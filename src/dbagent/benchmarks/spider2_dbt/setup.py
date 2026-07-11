from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

import gdown

logger = logging.getLogger(__name__)

# Dataset sources. The Google Drive zip URLs MUST be provided via .env
# (SPIDER2_GOLD_ZIP_URL / SPIDER2_START_ZIP_URL) as full gdown URLs, e.g.
# "https://drive.google.com/uc?id=<DRIVE_ID>"; no Drive ID lives in this tree.
# The git repo URL keeps a default (it is not a Drive ID).
SPIDER2_REPO_URL = os.environ.get(
    "SPIDER2_REPO_URL", "https://github.com/xlang-ai/Spider2.git"
)
GOLD_ZIP_URL = os.environ.get("SPIDER2_GOLD_ZIP_URL")
START_ZIP_URL = os.environ.get("SPIDER2_START_ZIP_URL")


def spider2_dbt_layout(workdir: Path) -> dict[str, Path]:
    workdir = workdir.expanduser().resolve()
    datasets_root = workdir / "datasets"
    spider2_root = datasets_root / "Spider2"
    spider2_dbt_root = spider2_root / "spider2-dbt"
    examples_root = spider2_dbt_root / "examples"
    gold_root = spider2_dbt_root / "evaluation_suite" / "gold"
    return {
        "workdir": workdir,
        "datasets_root": datasets_root,
        "spider2_root": spider2_root,
        "spider2_dbt_root": spider2_dbt_root,
        "examples_root": examples_root,
        "dataset_path": examples_root / "spider2-dbt.jsonl",
        "gold_root": gold_root,
        "gold_metadata_path": gold_root / "spider2_eval.jsonl",
    }


def spider2_dbt_ready(workdir: Path) -> bool:
    layout = spider2_dbt_layout(workdir)
    return (
        layout["dataset_path"].exists()
        and any(layout["examples_root"].rglob("*.duckdb"))
        and any(layout["gold_root"].rglob("*.duckdb"))
    )


def prepare_spider2_dbt(workdir: Path) -> dict[str, Path]:
    layout = spider2_dbt_layout(workdir)
    if spider2_dbt_ready(workdir):
        logger.info("spider2_dbt_prepare_skipped reason=dataset_ready root=%s", layout["spider2_dbt_root"])
        return layout

    logger.info("spider2_dbt_prepare_started root=%s", layout["spider2_dbt_root"])
    _ensure_spider2_repo(layout["datasets_root"], layout["spider2_root"], layout["spider2_dbt_root"])
    _ensure_archive(layout["spider2_dbt_root"] / "DBT_start_db.zip", START_ZIP_URL, layout["spider2_dbt_root"])
    _ensure_archive(layout["spider2_dbt_root"] / "dbt_gold.zip", GOLD_ZIP_URL, layout["spider2_dbt_root"])
    _run_upstream_setup(layout["spider2_dbt_root"])
    _validate_prepared_dataset(layout["dataset_path"], layout["examples_root"], layout["gold_root"])
    logger.info("spider2_dbt_prepare_finished root=%s", layout["spider2_dbt_root"])
    return layout


def _ensure_spider2_repo(datasets_root: Path, spider2_root: Path, spider2_dbt_root: Path) -> None:
    if spider2_dbt_root.exists():
        logger.info("spider2_dbt_repo_clone_skipped reason=repo_exists path=%s", spider2_dbt_root)
        return

    datasets_root.mkdir(parents=True, exist_ok=True)
    if spider2_root.exists():
        raise FileNotFoundError(f"Missing Spider2-DBT directory under cloned repo: {spider2_dbt_root}")

    logger.info("spider2_dbt_repo_clone_started url=%s path=%s", SPIDER2_REPO_URL, spider2_root)
    subprocess.run(
        ["git", "clone", "--depth", "1", SPIDER2_REPO_URL, str(spider2_root)],
        cwd=datasets_root,
        check=True,
    )
    logger.info("spider2_dbt_repo_clone_finished path=%s", spider2_root)

    if not spider2_dbt_root.exists():
        raise FileNotFoundError(f"Cloned Spider2 repo but missing Spider2-DBT root: {spider2_dbt_root}")


def _ensure_archive(destination: Path, url: str, cwd: Path) -> None:
    if destination.exists():
        logger.info("spider2_dbt_archive_download_skipped reason=file_exists path=%s", destination)
        return

    if not url:
        raise RuntimeError(
            f"Missing Google Drive URL for {destination.name}. Set "
            "SPIDER2_GOLD_ZIP_URL / SPIDER2_START_ZIP_URL in .env "
            "(full gdown URL, e.g. https://drive.google.com/uc?id=<DRIVE_ID>)."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    logger.info("spider2_dbt_archive_download_started url=%s path=%s", url, destination)
    previous_cwd = Path.cwd()
    try:
        if cwd != previous_cwd:
            os.chdir(cwd)
        result = gdown.download(url=url, output=str(destination), quiet=False)
    finally:
        if cwd != previous_cwd:
            os.chdir(previous_cwd)
    if result is None or not destination.exists():
        raise FileNotFoundError(f"Failed to download Spider2-DBT archive to {destination}")
    logger.info("spider2_dbt_archive_download_finished path=%s size_bytes=%d", destination, destination.stat().st_size)


def _run_upstream_setup(spider2_dbt_root: Path) -> None:
    logger.info("spider2_dbt_upstream_setup_started cwd=%s", spider2_dbt_root)
    subprocess.run(
        [sys.executable, "setup.py"],
        cwd=spider2_dbt_root,
        check=True,
    )
    logger.info("spider2_dbt_upstream_setup_finished cwd=%s", spider2_dbt_root)


def _validate_prepared_dataset(dataset_path: Path, examples_root: Path, gold_root: Path) -> None:
    logger.info(
        "spider2_dbt_validate_started dataset_path=%s examples_root=%s gold_root=%s",
        dataset_path,
        examples_root,
        gold_root,
    )
    if not dataset_path.exists():
        raise FileNotFoundError(f"Spider2-DBT dataset metadata missing: {dataset_path}")
    if not any(examples_root.rglob("*.duckdb")):
        raise FileNotFoundError(
            f"Spider2-DBT setup did not populate example .duckdb files under {examples_root}"
        )
    if not any(gold_root.rglob("*.duckdb")):
        raise FileNotFoundError(
            f"Spider2-DBT setup did not populate gold .duckdb files under {gold_root}"
        )
    logger.info("spider2_dbt_validate_finished dataset_path=%s", dataset_path)
