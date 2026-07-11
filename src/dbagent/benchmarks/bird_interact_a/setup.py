from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import time
import json
from functools import lru_cache
from pathlib import Path
from typing import TypedDict
from urllib.request import urlopen

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _psycopg_or_warn():
    """Return the psycopg module, or None (warning once) if it is not installed.

    Without psycopg the readiness check degrades to a bare TCP port probe, which
    can pass before Postgres is actually able to serve (the cold-start race this
    check exists to avoid). psycopg is also required for evaluation, so a missing
    install will fail later regardless; warn early. Cached so a polling caller
    logs this at most once.
    """
    try:
        import psycopg
    except ImportError:
        logger.warning(
            "psycopg is not installed; Postgres readiness falls back to a TCP port "
            "check (weaker, may race on cold start). psycopg is also required for "
            "BIRD-Interact evaluation -- install it to avoid later failures."
        )
        return None
    return psycopg


BIRD_INTERACT_REPO = "https://github.com/bird-bench/BIRD-Interact"
BIRD_INTERACT_ENV_DIRNAME = "BIRD-Interact-env"
HF_API_URL = "https://huggingface.co/api/datasets/{repo}/tree/main?recursive=true"
HF_RESOLVE_URL = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"
# Per-split data sources:
#   hf_repo  : HuggingFace dataset (public prompts/schemas/KB)
#   drive_id : Google Drive GT/testcases file id (solution SQL + test cases).
#              MUST be provided via .env (BIRD_INTERACT_FULL_DRIVE_ID /
#              BIRD_INTERACT_LITE_DRIVE_ID); no literal ID lives in this tree.
#   filename : local name to save the downloaded GT file as
DATASET_SOURCES = {
    "full": {
        "hf_repo": "birdsql/bird-interact-full",
        "drive_id": os.environ.get("BIRD_INTERACT_FULL_DRIVE_ID"),
        "filename": "bird_interact_full_gt_kg_testcases_08022.jsonl",
    },
    "lite": {
        "hf_repo": "birdsql/bird-interact-lite",
        "drive_id": os.environ.get("BIRD_INTERACT_LITE_DRIVE_ID"),
        "filename": "bird_interact_lite_gt_kg_testcases.jsonl",
    },
}


class BirdInteractLayout(TypedDict):
    source_root: Path
    data_dir: Path
    data_path: Path


def resolve_bird_interact_layout(workdir: Path, split: str = "lite") -> BirdInteractLayout:
    data_dir_env = os.getenv("BIRD_INTERACT_DATA_DIR")
    if data_dir_env:
        data_dir = Path(data_dir_env).expanduser().resolve()
        data_path = data_dir / "bird_interact_data.jsonl"
        if data_path.exists():
            return {
                "source_root": data_dir.parent,
                "data_dir": data_dir,
                "data_path": data_path,
            }

    source_root = _resolve_source_root(workdir)
    dataset_name = f"bird-interact-{split}"
    candidates = [
        source_root / "bird_interact_conv" / "data" / dataset_name,
        source_root / "BIRD-Interact-ADK" / dataset_name,
        source_root / dataset_name,
        workdir / "datasets" / dataset_name,
    ]
    for data_dir in candidates:
        data_path = data_dir / "bird_interact_data.jsonl"
        if data_path.exists():
            return {
                "source_root": source_root,
                "data_dir": data_dir.resolve(),
                "data_path": data_path.resolve(),
            }

    searched = "\n".join(f"- {candidate}" for candidate in candidates)
    raise FileNotFoundError(
        f"Could not find BIRD-Interact data for split={split!r}. "
        "Set BIRD_INTERACT_ROOT or BIRD_INTERACT_DATA_DIR.\n"
        f"Searched:\n{searched}"
    )


def bird_interact_ready(data_dir: Path) -> bool:
    return (data_dir / "bird_interact_data.jsonl").is_file()


def _has_ground_truth(data_path: Path) -> bool:
    """True if the dataset JSONL already carries GT (a non-empty sol_sql)."""
    try:
        with data_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    return bool(json.loads(line).get("sol_sql"))
    except (OSError, json.JSONDecodeError):
        return False
    return False


def prepare_bird_interact_dataset(workdir: Path, split: str) -> BirdInteractLayout:
    """Ensure public BIRD-Interact data is present and merged with local GT.

    Public Hugging Face data contains the prompts, schemas, and KB files. The
    benchmark's GT JSONL (downloaded from Google Drive) supplies solution SQL and
    test cases. The adapter needs the merged `bird_interact_data.jsonl`.

    A public-only copy (e.g. the BIRD-Interact repo checkout) has sol_sql empty
    and is NOT evaluable, so we still download + merge the GT in that case instead
    of returning it as-is.
    """
    existing = None
    try:
        existing = resolve_bird_interact_layout(workdir, split)
    except FileNotFoundError:
        existing = None

    if existing is not None and _has_ground_truth(existing["data_path"]):
        return existing

    if existing is not None:
        # An existing dataset dir (with schema/KB) but only public data: merge GT
        # in place, preserving the original public file as a sibling .public copy.
        data_dir = existing["data_dir"]
        merged_path = existing["data_path"]
        public_path = data_dir / "bird_interact_data.public.jsonl"
        if not public_path.exists():
            shutil.copyfile(merged_path, public_path)
    else:
        # Nothing local: download the public dataset from HuggingFace.
        data_dir = workdir / "datasets" / f"bird-interact-{split}"
        public_path = data_dir / "bird_interact_data.public.jsonl"
        merged_path = data_dir / "bird_interact_data.jsonl"
        if not public_path.exists():
            _download_hf_dataset(split, data_dir)
            downloaded_public = data_dir / "bird_interact_data.jsonl"
            if downloaded_public.exists():
                downloaded_public.replace(public_path)

    gt_path = _resolve_gt_path(workdir, split)
    _merge_public_with_gt(public_path, gt_path, merged_path)
    return resolve_bird_interact_layout(workdir, split)


def ensure_bird_interact_postgres(workdir: Path, split: str) -> None:
    """Start the BIRD-Interact PostgreSQL Docker service when available.

    The BIRD-Interact compose file publishes lite on host port 5432 and full on
    host port 5433. dbAgent evaluates from the host and runs agents in sibling
    containers, so the host-published port is the stable integration point.
    """
    if os.getenv("BIRD_INTERACT_SKIP_POSTGRES_SETUP") in {"1", "true", "TRUE", "yes"}:
        return

    service = "postgresql_full" if split == "full" else "postgresql"
    default_port = "5433" if split == "full" else "5432"
    os.environ.setdefault("BIRD_INTERACT_PG_HOST", "127.0.0.1")
    os.environ.setdefault("BIRD_INTERACT_PG_PORT", default_port)

    host = os.environ["BIRD_INTERACT_PG_HOST"]
    port = int(os.environ["BIRD_INTERACT_PG_PORT"])

    if _postgres_ready(host, port):
        return

    compose_file = _ensure_bird_interact_env_checkout(workdir)
    if shutil.which("docker") is None:
        raise RuntimeError("Docker CLI not found; cannot start BIRD-Interact PostgreSQL")

    _run_compose(compose_file, ["pull", service])
    _run_compose(compose_file, ["up", "-d", service])

    deadline = time.monotonic() + int(os.getenv("BIRD_INTERACT_PG_STARTUP_TIMEOUT", "300"))
    while time.monotonic() < deadline:
        if _postgres_ready(host, port):
            return
        time.sleep(2)
    raise RuntimeError(f"BIRD-Interact PostgreSQL service {service!r} was not ready at {host}:{port} in time")


def teardown_bird_interact_postgres(workdir: Path, split: str) -> None:
    """Stop/remove the BIRD-Interact PostgreSQL service for this benchmark run."""
    service = "postgresql_full" if split == "full" else "postgresql"
    container = "bird_interact_postgresql_full" if split == "full" else "bird_interact_postgresql"
    compose_file = _resolve_bird_interact_compose(workdir)
    if compose_file is not None and shutil.which("docker") is not None:
        _run_compose(compose_file, ["rm", "-sf", service])
        return
    if shutil.which("docker") is None:
        return
    subprocess.run(["docker", "rm", "-f", container], capture_output=True, text=True, check=False)


def _resolve_bird_interact_compose(workdir: Path) -> Path | None:
    source_root = _resolve_source_root(workdir)
    candidates = [
        source_root / "env" / "docker-compose.yml",
        workdir.parent / "BIRD-Interact" / "env" / "docker-compose.yml",
        workdir / "datasets" / "BIRD-Interact" / "env" / "docker-compose.yml",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return None


def _resolve_gt_path(workdir: Path, split: str) -> Path:
    env_key = "BIRD_INTERACT_GT_PATH"
    if os.getenv(env_key):
        path = Path(os.environ[env_key]).expanduser().resolve()
        if path.exists():
            return path
        raise FileNotFoundError(f"{env_key} points to a missing file: {path}")

    data_dir = workdir / "datasets" / f"bird-interact-{split}"
    gt = DATASET_SOURCES.get(split)
    if gt:
        destination = data_dir / gt["filename"]
        if destination.exists():
            return destination.resolve()
        drive_id = gt["drive_id"]
        if not drive_id:
            raise RuntimeError(
                f"Missing Google Drive ID for BIRD-Interact {split}. Set "
                f"BIRD_INTERACT_{split.upper()}_DRIVE_ID in .env (or set "
                f"{env_key} to a local GT file)."
            )
        _download_gt_with_gdown(drive_id, destination, split)
        if destination.exists():
            return destination.resolve()

    raise FileNotFoundError(
        f"Could not find BIRD-Interact {split} GT/testcases JSONL at the required path under {data_dir}. "
        f"Set {env_key}=/path/to/bird_interact_{split}_gt_...jsonl."
    )


def _download_gt_with_gdown(drive_id: str, destination: Path, split: str) -> None:
    if shutil.which("gdown") is None:
        raise FileNotFoundError(
            f"Missing {split} GT file: {destination}. Install gdown or set BIRD_INTERACT_GT_PATH."
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = ["gdown", drive_id, "-O", str(destination)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not destination.exists():
        output = (result.stdout + result.stderr).strip()
        raise RuntimeError(f"Failed to download BIRD-Interact {split} GT with gdown:\n{output}")


def _download_hf_dataset(split: str, data_dir: Path) -> None:
    source = DATASET_SOURCES.get(split)
    if not source:
        raise FileNotFoundError(f"No HuggingFace dataset configured for split={split!r}")
    repo = source["hf_repo"]
    api_url = HF_API_URL.format(repo=repo)
    data_dir.mkdir(parents=True, exist_ok=True)
    with urlopen(api_url, timeout=60) as response:
        entries = json.loads(response.read().decode("utf-8"))

    for entry in entries:
        rel_path = entry.get("path")
        if entry.get("type") != "file" or not rel_path or rel_path == ".gitattributes":
            continue
        destination = data_dir / rel_path
        if destination.exists() and destination.stat().st_size > 0:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        file_url = HF_RESOLVE_URL.format(repo=repo, path=rel_path)
        with urlopen(file_url, timeout=60) as response, destination.open("wb") as handle:
            shutil.copyfileobj(response, handle)


def _merge_public_with_gt(public_path: Path, gt_path: Path, merged_path: Path) -> None:
    if not public_path.exists():
        raise FileNotFoundError(f"Missing public BIRD-Interact data: {public_path}")

    gt_by_id: dict[str, dict] = {}
    with gt_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            instance_id = item.get("instance_id")
            if instance_id:
                gt_by_id[instance_id] = item

    merged_path.parent.mkdir(parents=True, exist_ok=True)
    merged_count = 0
    with public_path.open("r", encoding="utf-8") as source, merged_path.open("w", encoding="utf-8") as dest:
        for line in source:
            if not line.strip():
                continue
            item = json.loads(line)
            gt_item = gt_by_id.get(item.get("instance_id"))
            if gt_item:
                item["sol_sql"] = gt_item.get("sol_sql", [])
                item["external_knowledge"] = gt_item.get("external_knowledge", [])
                item["test_cases"] = gt_item.get("test_cases", [])
                if isinstance(gt_item.get("follow_up"), dict):
                    item.setdefault("follow_up", {})
                    item["follow_up"]["sol_sql"] = gt_item["follow_up"].get("sol_sql", [])
                    item["follow_up"]["external_knowledge"] = gt_item["follow_up"].get("external_knowledge", [])
                    item["follow_up"]["test_cases"] = gt_item["follow_up"].get("test_cases", [])
                merged_count += 1
            dest.write(json.dumps(item, ensure_ascii=False) + "\n")

    if merged_count == 0:
        raise RuntimeError(f"No GT rows from {gt_path} matched public rows in {public_path}")


def _ensure_bird_interact_env_checkout(workdir: Path) -> Path:
    compose_file = _resolve_bird_interact_compose(workdir)
    if compose_file is not None:
        return compose_file

    if shutil.which("git") is None:
        raise RuntimeError(
            "Git CLI not found; cannot sparse-clone BIRD-Interact env/. "
            "Install git, set BIRD_INTERACT_ROOT, or start PostgreSQL manually."
        )

    checkout_root = Path(os.getenv("BIRD_INTERACT_ENV_ROOT", workdir / "datasets" / BIRD_INTERACT_ENV_DIRNAME))
    checkout_root = checkout_root.expanduser().resolve()
    compose_file = checkout_root / "env" / "docker-compose.yml"
    if compose_file.exists():
        return compose_file

    checkout_root.parent.mkdir(parents=True, exist_ok=True)
    if checkout_root.exists() and any(checkout_root.iterdir()):
        raise RuntimeError(
            f"BIRD-Interact env checkout target exists but has no env/docker-compose.yml: {checkout_root}. "
            "Set BIRD_INTERACT_ENV_ROOT to an empty path or remove the incomplete checkout."
        )

    commands = [
        ["git", "clone", "--filter=blob:none", "--sparse", BIRD_INTERACT_REPO, str(checkout_root)],
        ["git", "-C", str(checkout_root), "sparse-checkout", "set", "env"],
    ]
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            output = (result.stdout + result.stderr).strip()
            raise RuntimeError(f"Failed to prepare BIRD-Interact env checkout: {' '.join(command)}\n{output}")

    if not compose_file.exists():
        raise RuntimeError(f"BIRD-Interact sparse checkout did not create compose file: {compose_file}")
    return compose_file


def _run_compose(compose_file: Path, args: list[str]) -> None:
    command = ["docker", "compose", "-f", str(compose_file), *args]
    result = subprocess.run(command, cwd=compose_file.parent, capture_output=True, text=True)
    if result.returncode != 0:
        output = (result.stdout + result.stderr).strip()
        raise RuntimeError(
            "Failed to run BIRD-Interact Docker Compose command. "
            "If this is a stale Docker group session, run through `sg docker -c ...` "
            f"or restart the shell. Command: {' '.join(command)}\nOutput:\n{output}"
        )


def _tcp_port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def _postgres_ready(host: str, port: int) -> bool:
    """Real readiness check: authenticate against the maintenance DB, run a query,
    and confirm at least one "{db}_template" exists. Falls back to a TCP check
    when psycopg is unavailable.
    """
    psycopg = _psycopg_or_warn()
    if psycopg is None:
        return _tcp_port_open(host, port)

    user = os.getenv("BIRD_INTERACT_PG_USER", "root")
    password = os.getenv("BIRD_INTERACT_PG_PASSWORD", "123123")
    maintenance_db = os.getenv("BIRD_INTERACT_PG_MAINTENANCE_DB", "postgres")
    try:
        with psycopg.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            dbname=maintenance_db,
            connect_timeout=3,
        ) as conn:
            row = conn.execute(
                "SELECT count(*) FROM pg_database WHERE datname LIKE '%\\_template'"
            ).fetchone()
            return bool(row) and row[0] > 0
    except Exception:
        return False


def _resolve_source_root(workdir: Path) -> Path:
    data_dir_env = os.getenv("BIRD_INTERACT_DATA_DIR")
    if data_dir_env:
        data_dir = Path(data_dir_env).expanduser().resolve()
        if (data_dir / "bird_interact_data.jsonl").exists():
            return data_dir.parent

    root_env = os.getenv("BIRD_INTERACT_ROOT")
    candidates = []
    if root_env:
        candidates.append(Path(root_env).expanduser())
    candidates.extend(
        [
            workdir.parent / "BIRD-Interact",
            workdir / "datasets" / "BIRD-Interact",
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return candidates[0].resolve() if candidates else workdir
