"""Product request handlers used by the domain routers in :mod:`api.routers`."""

import asyncio
import atexit
import json
import logging
import os
import re
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from runtime.runtime import DbAgentRuntime
from data.models import DataSource
from data.registry import list_data_sources, list_demo_data_sources, resolve_data_source
from data.engines.session import cleanup_data_session, create_data_session
from data.connections.demo import (
    DEMO_PRESETS,
    DemoGroupId,
    connect_demo_group,
    disconnect_demo_group,
    list_connected_demo_groups,
)
from shared.config import CONFIG_DIR, RESOURCE_ROOT, RUNTIME_ROOT, settings
from shared.llm import call_llm
from shared.llm_profile_store import (
    MASK_SENTINELS,
    create_profile,
    default_model_id_from_store,
    delete_profile,
    get_user_profile,
    list_user_profiles,
    set_default_profile,
    update_profile,
)
from shared.model_registry import all_specs, catalog_payload, default_model_id, get_spec, resolve_credentials
from data.connections.user import (
    connection_public_dict,
    create_connection,
    delete_connection,
    list_connections,
    update_connection,
)
from data.connections.validation import ConnectionEngine, validate_local_database
from api.schemas import (
    AnalyzeRequest,
    AnswerUserRequest,
    BranchAnswerRequest,
    CancelRequest,
    ConnectionCreateRequest,
    ConnectionTestRequest,
    ConnectionUpdateRequest,
    DataSourceResolveRequest,
    DemoConnectionRequest,
    FreechatStartRequest,
    LlmConfigCreateRequest,
    LlmConfigDraftTestRequest,
    LlmConfigUpdateRequest,
    ProviderInput,
    SetDefaultRequest,
    TitleRequest,
    TurnRequest,
    VisualizationRequest,
)

logger = logging.getLogger(__name__)
AGENT_RUNTIME = DbAgentRuntime()


LOCAL_FILE_IMPORT_DIR = CONFIG_DIR / "imported_databases"

DEMO_MODEL_LABEL = "GLM-5.2"
DEMO_MODEL_PROVIDER = "zai"
DEMO_MODEL_NAME = "openai/glm-5.2"
DEMO_MODEL_API_BASE = "https://api.z.ai/api/coding/paas/v4"
DESKTOP_ENV = "AURIGASQL_DESKTOP"

LOCAL_MODEL_LABEL = "Local Model · Qwen3 1.7B"
LOCAL_MODEL_PROVIDER = "other"
LOCAL_MODEL_NAME = "openai/Qwen3-1.7B-Q4_K_M"
LOCAL_MODEL_API_PORT = int(os.getenv("AURIGASQL_LOCAL_MODEL_PORT", "6021"))
LOCAL_MODEL_API_BASE = f"http://127.0.0.1:{LOCAL_MODEL_API_PORT}/v1"
LOCAL_MODEL_FILENAME = "Qwen3-1.7B-Q4_K_M.gguf"
LOCAL_MODEL_URL = (
    "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/"
    "Qwen3-1.7B-Q4_K_M.gguf"
)
LOCAL_MODEL_ESTIMATED_BYTES = 1_140_000_000
LOCAL_MODEL_DIR = RUNTIME_ROOT / "models" / "qwen3-1.7b"
LOCAL_MODEL_DOWNLOAD_WORKERS = max(1, min(8, int(os.getenv("AURIGASQL_LOCAL_MODEL_DOWNLOAD_WORKERS", "4"))))

_local_model_lock = threading.Lock()
_local_model_download: dict[str, Any] = {
    "downloading": False,
    "bytes_downloaded": 0,
    "total_bytes": 0,
    "started_at": 0.0,
    "updated_at": 0.0,
    "speed_bps": 0.0,
    "error": "",
}
_llama_server_process: subprocess.Popen | None = None


def _stop_llama_server() -> None:
    global _llama_server_process
    if not _llama_server_process or _llama_server_process.poll() is not None:
        return
    _llama_server_process.terminate()
    try:
        _llama_server_process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        _llama_server_process.kill()
    finally:
        _llama_server_process = None


atexit.register(_stop_llama_server)


def _ensure_desktop_defaults() -> None:
    if os.getenv(DESKTOP_ENV, "").strip() != "1":
        return
    api_key = os.getenv("AURIGASQL_ZAI_API_KEY", "").strip()
    if not api_key:
        return
    try:
        profiles = list_user_profiles()
        existing = next(
            (
                profile
                for profile in profiles
                if profile.provider == DEMO_MODEL_PROVIDER
                and profile.model == DEMO_MODEL_NAME
                and profile.api_base == DEMO_MODEL_API_BASE
            ),
            None,
        )
        profile = existing or create_profile(
            label=DEMO_MODEL_LABEL,
            provider=DEMO_MODEL_PROVIDER,
            model=DEMO_MODEL_NAME,
            api_key=api_key,
            api_base=DEMO_MODEL_API_BASE,
            enabled=True,
        )
        set_default_profile(profile.id)
    except Exception as exc:
        logger.warning("Failed to initialize bundled GLM-5.2 profile: %s", exc)


def _local_model_path() -> Path:
    return LOCAL_MODEL_DIR / LOCAL_MODEL_FILENAME


def _find_llama_server_path() -> Path:
    env_path = os.getenv("AURIGASQL_LLAMA_SERVER_PATH", "").strip()
    candidates = [
        Path(env_path).expanduser() if env_path else None,
        RESOURCE_ROOT / "llama.cpp" / "llama-server",
        Path(__file__).resolve().parents[2] / "frontend" / "vendor" / "llama.cpp" / "macos" / "llama-server",
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    raise FileNotFoundError(
        "llama-server was not found. Expected it in app resources at llama.cpp/llama-server."
    )


def _local_model_server_ready(timeout: float = 2.0) -> bool:
    req = urllib.request.Request(f"{LOCAL_MODEL_API_BASE}/models")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _https_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _download_headers() -> dict[str, str]:
    return {"User-Agent": "AurigaSQL/0.1"}


def _remote_model_size() -> int:
    req = urllib.request.Request(LOCAL_MODEL_URL, headers=_download_headers(), method="HEAD")
    with urllib.request.urlopen(req, timeout=45, context=_https_context()) as resp:
        return int(resp.headers.get("Content-Length") or LOCAL_MODEL_ESTIMATED_BYTES)


def _record_download_progress(downloaded: int, total: int, started_at: float) -> None:
    now = time.time()
    elapsed = max(0.001, now - started_at)
    with _local_model_lock:
        _local_model_download.update(
            bytes_downloaded=downloaded,
            total_bytes=total,
            updated_at=now,
            speed_bps=downloaded / elapsed,
        )


def _download_local_model_single(total: int, started_at: float) -> Path:
    model_path = _local_model_path()
    part_path = model_path.with_suffix(model_path.suffix + ".part")
    existing = part_path.stat().st_size if part_path.exists() else 0
    headers = _download_headers()
    mode = "wb"
    if 0 < existing < total:
        headers["Range"] = f"bytes={existing}-"
        mode = "ab"
    elif existing >= total:
        return part_path
    req = urllib.request.Request(LOCAL_MODEL_URL, headers=headers)
    downloaded = existing
    _record_download_progress(downloaded, total, started_at)
    with urllib.request.urlopen(req, timeout=60, context=_https_context()) as resp:
        with open(part_path, mode) as out:
            while True:
                chunk = resp.read(4 * 1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                _record_download_progress(downloaded, total, started_at)
    return part_path


def _download_local_model_parallel(total: int, started_at: float) -> Path:
    model_path = _local_model_path()
    segment_dir = model_path.with_suffix(model_path.suffix + ".parts")
    segment_dir.mkdir(parents=True, exist_ok=True)
    worker_count = max(1, min(LOCAL_MODEL_DOWNLOAD_WORKERS, total // (16 * 1024 * 1024) or 1))
    span = (total + worker_count - 1) // worker_count
    errors: list[str] = []
    progress: dict[int, int] = {}
    progress_lock = threading.Lock()

    def segment_path(index: int) -> Path:
        return segment_dir / f"{index:02d}.part"

    def update_progress(index: int, value: int) -> None:
        with progress_lock:
            progress[index] = value
            downloaded = sum(progress.values())
        _record_download_progress(downloaded, total, started_at)

    def download_segment(index: int, start: int, end: int) -> None:
        expected = end - start + 1
        path = segment_path(index)
        existing = path.stat().st_size if path.exists() else 0
        if existing >= expected:
            update_progress(index, expected)
            return
        headers = _download_headers()
        headers["Range"] = f"bytes={start + existing}-{end}"
        req = urllib.request.Request(LOCAL_MODEL_URL, headers=headers)
        update_progress(index, existing)
        try:
            with urllib.request.urlopen(req, timeout=60, context=_https_context()) as resp:
                if resp.status != 206:
                    raise RuntimeError(f"range request returned HTTP {resp.status}")
                with open(path, "ab") as out:
                    done = existing
                    while done < expected:
                        chunk = resp.read(4 * 1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        update_progress(index, min(done, expected))
            if path.stat().st_size != expected:
                raise RuntimeError(f"segment {index} incomplete")
        except Exception as exc:
            errors.append(str(exc))

    threads: list[threading.Thread] = []
    for index in range(worker_count):
        start = index * span
        end = min(total - 1, start + span - 1)
        if start > end:
            continue
        thread = threading.Thread(target=download_segment, args=(index, start, end), daemon=True)
        threads.append(thread)
        thread.start()
    for thread in threads:
        thread.join()
    if errors:
        raise RuntimeError(errors[0])

    part_path = model_path.with_suffix(model_path.suffix + ".part")
    with open(part_path, "wb") as out:
        for index in range(len(threads)):
            out.write(segment_path(index).read_bytes())
    if part_path.stat().st_size != total:
        raise RuntimeError("assembled model download is incomplete")
    try:
        for path in segment_dir.iterdir():
            path.unlink()
        segment_dir.rmdir()
    except OSError:
        pass
    return part_path


def _download_local_model() -> None:
    model_path = _local_model_path()
    LOCAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    try:
        total = _remote_model_size()
        with _local_model_lock:
            _local_model_download.update(
                downloading=True,
                bytes_downloaded=0,
                total_bytes=total,
                started_at=started_at,
                updated_at=started_at,
                speed_bps=0.0,
                error="",
            )
        try:
            part_path = _download_local_model_parallel(total, started_at)
        except Exception as exc:
            logger.info("Parallel local model download failed, falling back to single stream: %s", exc)
            part_path = _download_local_model_single(total, started_at)
        os.replace(part_path, model_path)
        with _local_model_lock:
            _local_model_download.update(
                downloading=False,
                bytes_downloaded=model_path.stat().st_size,
                total_bytes=model_path.stat().st_size,
                updated_at=time.time(),
                speed_bps=0.0,
                error="",
            )
    except Exception as exc:
        try:
            model_path.with_suffix(model_path.suffix + ".part").unlink()
        except OSError:
            pass
        with _local_model_lock:
            _local_model_download.update(downloading=False, updated_at=time.time(), speed_bps=0.0, error=str(exc))
        logger.warning("Local model download failed: %s", exc)


def _start_local_model_download() -> None:
    with _local_model_lock:
        if _local_model_download.get("downloading"):
            return
        _local_model_download.update(
            downloading=True,
            bytes_downloaded=0,
            total_bytes=LOCAL_MODEL_ESTIMATED_BYTES,
            started_at=time.time(),
            updated_at=time.time(),
            speed_bps=0.0,
            error="",
        )
    thread = threading.Thread(target=_download_local_model, name="aurigasql-local-model-download", daemon=True)
    thread.start()


def _ensure_llama_server_running() -> None:
    global _llama_server_process
    if _local_model_server_ready():
        return
    model_path = _local_model_path()
    if not model_path.exists():
        raise FileNotFoundError("Local Qwen model is not downloaded yet.")
    llama_server = _find_llama_server_path()
    try:
        llama_server.chmod(llama_server.stat().st_mode | 0o111)
    except OSError:
        pass
    if _llama_server_process and _llama_server_process.poll() is None:
        _llama_server_process.terminate()
    cmd = [
        str(llama_server),
        "-m",
        str(model_path),
        "--host",
        "127.0.0.1",
        "--port",
        str(LOCAL_MODEL_API_PORT),
        "--ctx-size",
        "8192",
    ]
    _llama_server_process = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=str(LOCAL_MODEL_DIR),
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if _llama_server_process.poll() is not None:
            raise RuntimeError("llama-server exited before it became ready.")
        if _local_model_server_ready(timeout=1.0):
            return
        time.sleep(1)
    raise TimeoutError("Timed out waiting for llama-server to start.")


def _ensure_local_model_profile():
    existing = next(
        (
            profile
            for profile in list_user_profiles()
            if profile.provider == LOCAL_MODEL_PROVIDER
            and profile.model == LOCAL_MODEL_NAME
            and profile.api_base == LOCAL_MODEL_API_BASE
        ),
        None,
    )
    if existing:
        update_profile(
            existing.id,
            label=LOCAL_MODEL_LABEL,
            api_key="",
            api_base=LOCAL_MODEL_API_BASE,
            enabled=True,
        )
        set_default_profile(existing.id)
        return get_user_profile(existing.id) or existing
    profile = create_profile(
        label=LOCAL_MODEL_LABEL,
        provider=LOCAL_MODEL_PROVIDER,
        model=LOCAL_MODEL_NAME,
        api_key="",
        api_base=LOCAL_MODEL_API_BASE,
        enabled=True,
    )
    set_default_profile(profile.id)
    return profile


def _local_model_status() -> dict[str, Any]:
    model_path = _local_model_path()
    downloaded = model_path.exists()
    with _local_model_lock:
        state = dict(_local_model_download)
    size = model_path.stat().st_size if downloaded else int(state.get("bytes_downloaded") or 0)
    total = int(state.get("total_bytes") or LOCAL_MODEL_ESTIMATED_BYTES)
    speed_bps = float(state.get("speed_bps") or 0.0)
    remaining = max(0, total - size)
    eta_seconds = int(remaining / speed_bps) if speed_bps > 0 else 0
    existing = next(
        (
            profile
            for profile in list_user_profiles()
            if profile.provider == LOCAL_MODEL_PROVIDER
            and profile.model == LOCAL_MODEL_NAME
            and profile.api_base == LOCAL_MODEL_API_BASE
        ),
        None,
    )
    return {
        "label": LOCAL_MODEL_LABEL,
        "provider": LOCAL_MODEL_PROVIDER,
        "model": LOCAL_MODEL_NAME,
        "api_base": LOCAL_MODEL_API_BASE,
        "model_url": LOCAL_MODEL_URL,
        "model_path": str(model_path),
        "downloaded": downloaded,
        "downloading": bool(state.get("downloading")),
        "bytes_downloaded": size,
        "total_bytes": total,
        "speed_bps": speed_bps,
        "eta_seconds": eta_seconds,
        "running": _local_model_server_ready(timeout=0.5),
        "profile_id": existing.id if existing else "",
        "error": str(state.get("error") or ""),
    }


async def startup_defaults() -> None:
    _ensure_desktop_defaults()


def _safe_import_filename(filename: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", filename.strip()).strip("._")
    return stem or "database"


def _write_imported_database_file(engine: ConnectionEngine, filename: str, content: bytes) -> tuple[bool, str, str]:
    if engine not in {"sqlite", "duckdb"}:
        raise ValueError("Only SQLite and DuckDB files can be imported")
    if not content:
        raise ValueError("Selected file is empty")

    suffix = Path(filename).suffix.lower()
    allowed_suffixes = {
        "sqlite": {".sqlite", ".sqlite3", ".db"},
        "duckdb": {".duckdb", ".db"},
    }[engine]
    if suffix not in allowed_suffixes:
        expected = ", ".join(sorted(allowed_suffixes))
        raise ValueError(f"{engine} files must use one of: {expected}")

    LOCAL_FILE_IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_import_filename(filename)
    target = LOCAL_FILE_IMPORT_DIR / f"{uuid.uuid4().hex[:10]}-{safe_name}"
    target.write_bytes(content)
    ok, message, db_path = validate_local_database(engine, str(target))
    if not ok:
        try:
            target.unlink()
        except OSError:
            pass
        return False, message, str(target)
    return True, message, str(db_path or target)

def _source_schema_text(source: DataSource) -> str:
    if source.schema_path and source.schema_path.exists():
        return source.schema_path.read_text(encoding="utf-8")
    if source.engine == "sqlite" and source.db_path and source.db_path.exists():
        import sqlite3

        with sqlite3.connect(f"file:{source.db_path.resolve()}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
        return "\n\n".join(row[0] for row in rows if row and row[0])
    if source.engine == "duckdb" and source.db_path and source.db_path.exists():
        import duckdb

        with duckdb.connect(database=str(source.db_path), read_only=True) as conn:
            rows = conn.execute(
                """
                SELECT table_schema, table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                ORDER BY table_schema, table_name, ordinal_position
                """
            ).fetchall()
        return _schema_rows_to_text(rows)
    if source.engine == "postgres" and source.source_type == "user_connection" and source.dsn:
        query = """
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY table_schema, table_name, ordinal_position
        LIMIT 2000
        """
        try:
            import psycopg

            with psycopg.connect(source.dsn, connect_timeout=10) as conn:
                with conn.cursor() as cur:
                    cur.execute(query)
                    rows = cur.fetchall()
        except ModuleNotFoundError:
            import psycopg2

            conn = psycopg2.connect(source.dsn, connect_timeout=10)
            try:
                with conn.cursor() as cur:
                    cur.execute(query)
                    rows = cur.fetchall()
            finally:
                conn.close()
        return _schema_rows_to_text(rows)
    if source.engine == "mysql" and source.source_type == "user_connection" and source.dsn:
        from data.engines.mysql import connect_mysql

        query = """
        SELECT table_schema, table_name, column_name, column_type
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
        ORDER BY table_schema, table_name, ordinal_position
        LIMIT 2000
        """
        conn = connect_mysql(source.dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(query)
                rows = cur.fetchall()
        finally:
            conn.close()
        return _schema_rows_to_text(rows)
    raise HTTPException(404, f"Schema not found for data source: {source.id}")


def _schema_rows_to_text(rows: list[tuple[Any, ...]]) -> str:
    lines: list[str] = []
    current: tuple[str, str] | None = None
    columns: list[str] = []
    for schema, table, column, data_type in rows:
        key = (schema, table)
        if current is not None and current != key:
            lines.append(f"Table: {current[0]}.{current[1]}\nColumns: {', '.join(columns)}")
            columns = []
        current = key
        columns.append(f"{column} {data_type}")
    if current is not None:
        lines.append(f"Table: {current[0]}.{current[1]}\nColumns: {', '.join(columns)}")
    return "\n\n".join(lines)


def _source_for_display_name(name: str) -> DataSource:
    for source in list_data_sources(include_not_ready=False):
        if source.id == name or source.display_name == name or source.database == name:
            return source
    raise HTTPException(404, f"Unknown data source: {name}")


def _demo_connection_payload(source_group: DemoGroupId) -> dict:
    connected = source_group in list_connected_demo_groups()
    sources = [source for source in list_demo_data_sources() if source.source_group == source_group]
    ready_count = sum(1 for source in sources if source.ready)
    first_not_ready = next((source for source in sources if not source.ready), None)
    preset = DEMO_PRESETS[source_group]
    return {
        "source_group": source_group,
        "label": preset["label"],
        "engine": preset["engine"],
        "description": preset["description"],
        "connected": connected,
        "ready_count": ready_count,
        "reason": first_not_ready.reason if ready_count == 0 and first_not_ready else "",
    }


def _demo_connections_payload() -> dict:
    return {
        "connections": [
            _demo_connection_payload(source_group)
            for source_group in DEMO_PRESETS
        ]
    }


def _call_llm_for_selected_model(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
) -> str:
    """Call LiteLLM using the selected frontend model id when provided."""
    import litellm

    if model:
        spec = get_spec(model)
        kwargs = dict(
            model=spec.litellm_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            num_retries=5,
            timeout=1500,
        )
        kwargs.update(resolve_credentials(spec))
        resp = litellm.completion(**kwargs)
        return resp.choices[0].message.content.strip()

    router_model = settings.db_router_model or settings.user_sim_model
    return call_llm(messages, router_model, temperature, max_tokens)


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        cleaned = cleaned[start : end + 1]
    parsed = json.loads(cleaned)
    return parsed if isinstance(parsed, dict) else {}


def _data_source_candidate_text(source: DataSource) -> str:
    parts = [
        f"id: {source.id}",
        f"name: {source.display_name}",
        f"engine: {source.engine}",
    ]
    if source.database:
        parts.append(f"database: {source.database}")
    if source.description:
        parts.append(f"description: {source.description}")
    if source.source_type:
        parts.append(f"type: {source.source_type}")
    return " | ".join(parts)


def _query_tokens(text: str) -> set[str]:
    tokens = set(re.findall(r"[a-z0-9_]+", text.lower()))
    expanded = set(tokens)
    for token in tokens:
        if token.endswith("ies") and len(token) > 4:
            expanded.add(f"{token[:-3]}y")
        if token.endswith("s") and len(token) > 3:
            expanded.add(token[:-1])
    return expanded


def _keyword_route_data_source(query: str, sources: list[DataSource]) -> tuple[DataSource | None, str]:
    query_tokens = _query_tokens(query)
    if not query_tokens:
        return None, ""
    scored: list[tuple[float, DataSource, set[str]]] = []
    for source in sources:
        fields = [
            source.id.replace(":", " "),
            source.display_name,
            source.database or "",
            source.description or "",
        ]
        candidate_tokens = _query_tokens(" ".join(fields))
        overlap = query_tokens & candidate_tokens
        score = float(len(overlap))
        if source.database and source.database.lower() in query.lower():
            score += 8.0
        if source.display_name and source.display_name.lower() in query.lower():
            score += 8.0
        # Demo catalog synonyms that are more reliable than asking a tiny router model.
        if source.database == "financial" and query_tokens & {
            "account",
            "bank",
            "client",
            "loan",
            "payment",
            "transaction",
            "amount",
        }:
            score += 6.0
        if source.database == "california_schools" and query_tokens & {"school", "district", "enrollment", "student", "assessment"}:
            score += 6.0
        if source.database == "formula_1" and query_tokens & {"race", "driver", "constructor", "circuit", "lap", "formula"}:
            score += 6.0
        if source.database == "student_club" and query_tokens & {"club", "event", "budget", "expense", "attendance"}:
            score += 6.0
        if source.database == "superhero" and query_tokens & {"hero", "superhero", "power", "publisher", "alignment"}:
            score += 6.0
        if source.database == "toxicology" and query_tokens & {"molecule", "atom", "bond", "toxicology", "toxic"}:
            score += 6.0
        if source.database == "credit" and query_tokens & {"credit", "utilization", "risk", "application"}:
            score += 6.0
        if source.database == "museum" and query_tokens & {
            "artifact",
            "conservation",
            "difficulty",
            "material",
            "museum",
            "exhibition",
        }:
            score += 6.0
        if source.database == "gaming" and query_tokens & {"gaming", "game", "latency", "device", "scope", "performance"}:
            score += 6.0
        if source.database == "news" and query_tokens & {
            "news",
            "satisfaction",
            "article",
            "recommendation",
            "session",
        }:
            score += 6.0
        if source.database == "robot" and query_tokens & {"robot", "payload", "capacity", "operation", "maintenance", "fault"}:
            score += 6.0
        if source.database == "solar" and query_tokens & {"solar", "plant", "generation", "capacity", "panel", "inverter"}:
            score += 6.0
        scored.append((score, source, overlap))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored or scored[0][0] < 2:
        return None, ""
    second = scored[1][0] if len(scored) > 1 else 0.0
    if scored[0][0] >= second + 2:
        source = scored[0][1]
        matched = ", ".join(sorted(scored[0][2])[:5])
        reason = f"Matched from catalog keywords{f': {matched}' if matched else ''}."
        return source, reason
    return None, ""


def _read_demo_questions() -> list[dict[str, Any]]:
    try:
        payload = json.loads(settings.demo_questions_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.warning("Demo questions file not found: %s", settings.demo_questions_path)
        return []
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Demo questions file is invalid: %s", exc)
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _profile_available(provider: str, api_key: str, api_base: str, enabled: bool) -> bool:
    if not enabled:
        return False
    if provider in {"ollama", "other"} and api_base.strip():
        return bool(api_base.strip())
    return bool(api_key.strip())


def _serialize_llm_configs() -> dict:
    profiles = []
    for spec in all_specs():
        profiles.append(
            {
                "id": spec.id,
                "label": spec.label,
                "provider": spec.provider,
                "model": spec.litellm_model,
                "api_base": spec.api_base,
                "enabled": spec.enabled,
                "available": spec.available,
                "source": spec.source,
                "read_only": spec.read_only,
                "api_key_masked": "set" if spec.api_key else "",
            }
        )
    return {"default_model_id": default_model_id(), "profiles": profiles}


def _validate_profile_payload(
    provider: ProviderInput,
    model: Optional[str],
    api_key: Optional[str],
    api_base: Optional[str],
) -> None:
    model = (model or "").strip()
    api_key = (api_key or "").strip()
    api_base = (api_base or "").strip()
    if not model:
        raise HTTPException(400, "model is required")
    if provider == "openai" and not model.startswith("openai/"):
        raise HTTPException(400, "OpenAI models must start with openai/")
    if provider == "gemini" and not model.startswith("gemini/"):
        raise HTTPException(400, "Gemini models must start with gemini/")
    if provider == "zai" and not model.startswith("openai/"):
        raise HTTPException(400, "Z.ai models should use an OpenAI-compatible model string")
    if provider == "anthropic" and not (model.startswith("claude-") or model.startswith("anthropic/")):
        raise HTTPException(400, "Anthropic models must start with claude- or anthropic/")
    if provider == "minimax" and not model.startswith("minimax/"):
        raise HTTPException(400, "MiniMax models must start with minimax/")
    if provider == "xai" and not model.startswith("xai/"):
        raise HTTPException(400, "xAI models must start with xai/")
    if provider == "ollama" and not model.startswith("ollama_chat/"):
        raise HTTPException(400, "Ollama models must start with ollama_chat/")
    if provider != "ollama" and provider != "other" and not api_key:
        raise HTTPException(400, "api_key is required")
    if provider in {"zai", "minimax", "xai", "ollama"} and not api_base:
        raise HTTPException(400, "api_base is required")
    if provider == "other" and not api_key and not api_base:
        raise HTTPException(400, "api_key or api_base is required")


def _test_profile_connection(model: Optional[str], api_key: Optional[str], api_base: Optional[str]) -> tuple[bool, str]:
    import litellm

    model = (model or "").strip()
    api_key = (api_key or "").strip()
    api_base = (api_base or "").strip()

    kwargs = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Reply with OK only."},
            {"role": "user", "content": "ping"},
        ],
        "temperature": 0.0,
        "max_tokens": 16,
        "num_retries": 1,
        "timeout": 45,
    }
    if api_base:
        kwargs["api_base"] = api_base
    if api_key:
        kwargs["api_key"] = api_key
    elif api_base and model.startswith("openai/"):
        kwargs["api_key"] = "not-needed"
    try:
        resp = litellm.completion(**kwargs)
        content = resp.choices[0].message.content.strip()
        return True, content or "Connection succeeded"
    except Exception as exc:
        return False, str(exc)


async def health():
    return {"status": "ok", "agent_runtime": "dbagent", "services": {}}


async def models():
    """Selectable LLM models for the UI picker (id, label, provider, availability)."""
    return catalog_payload()


async def llm_configs():
    """Configuration-oriented model profile list with masked keys only."""
    return _serialize_llm_configs()


async def create_llm_config(req: LlmConfigCreateRequest):
    label = req.label.strip()
    if not label:
        raise HTTPException(400, "label is required")
    _validate_profile_payload(req.provider, req.model, req.api_key, req.api_base)
    profile = create_profile(
        label=label,
        provider=req.provider,
        model=req.model,
        api_key=req.api_key,
        api_base=req.api_base,
        enabled=req.enabled,
    )
    if req.set_default:
        set_default_profile(profile.id)
    return _serialize_llm_configs()


async def update_llm_config(profile_id: str, req: LlmConfigUpdateRequest):
    existing = get_user_profile(profile_id)
    if not existing:
        raise HTTPException(404, "Profile not found or is read-only")

    model = req.model if req.model is not None else existing.model
    api_key = existing.api_key if req.api_key is None or req.api_key in MASK_SENTINELS else req.api_key
    api_base = req.api_base if req.api_base is not None else existing.api_base
    _validate_profile_payload(existing.provider, model, api_key, api_base)
    try:
        update_profile(
            profile_id,
            label=req.label,
            model=req.model,
            api_key=req.api_key,
            api_base=req.api_base,
            enabled=req.enabled,
        )
    except KeyError:
        raise HTTPException(404, "Profile not found") from None
    if req.set_default:
        set_default_profile(profile_id)
    return _serialize_llm_configs()


async def delete_llm_config(profile_id: str):
    if not get_user_profile(profile_id):
        raise HTTPException(404, "Profile not found or is read-only")
    try:
        delete_profile(profile_id)
    except KeyError:
        raise HTTPException(404, "Profile not found") from None
    return _serialize_llm_configs()


async def set_llm_default(req: SetDefaultRequest):
    # Allow env fallback ids to remain readable via /models, but only stored user
    # profiles can become the JSON-backed shared default.
    if not get_user_profile(req.model_id):
        raise HTTPException(404, "Default profile must be a user-configured model")
    try:
        set_default_profile(req.model_id)
    except KeyError:
        raise HTTPException(404, "Profile not found") from None
    return _serialize_llm_configs()


async def test_llm_config(profile_id: str):
    user_profile = get_user_profile(profile_id)
    if user_profile:
        ok, message = await asyncio.to_thread(
            _test_profile_connection,
            user_profile.model,
            user_profile.api_key,
            user_profile.api_base,
        )
        return {"ok": ok, "message": message}

    spec = next((item for item in all_specs() if item.id == profile_id), None)
    if not spec:
        raise HTTPException(404, "Profile not found")
    ok, message = await asyncio.to_thread(
        _test_profile_connection,
        spec.litellm_model,
        spec.api_key,
        spec.api_base,
    )
    return {"ok": ok, "message": message}


async def test_llm_config_draft(req: LlmConfigDraftTestRequest):
    profile = get_user_profile(req.profile_id) if req.profile_id else None
    model = req.model if req.model is not None else (profile.model if profile else "")
    api_key = req.api_key if req.api_key not in (None, "", *MASK_SENTINELS) else (profile.api_key if profile else "")
    api_base = req.api_base if req.api_base is not None else (profile.api_base if profile else "")
    _validate_profile_payload(req.provider, model, api_key, api_base)
    ok, message = await asyncio.to_thread(
        _test_profile_connection,
        model,
        api_key,
        api_base,
    )
    return {"ok": ok, "message": message}


async def local_model_status():
    return _local_model_status()


async def setup_local_model():
    status = _local_model_status()
    if not status["downloaded"]:
        _start_local_model_download()
        return {
            "ok": False,
            "message": "download_started",
            "status": _local_model_status(),
            "configs": None,
            "profile_id": "",
        }
    try:
        await asyncio.to_thread(_ensure_llama_server_running)
        profile = await asyncio.to_thread(_ensure_local_model_profile)
    except (FileNotFoundError, RuntimeError, TimeoutError, OSError) as exc:
        raise HTTPException(503, str(exc)) from exc
    return {
        "ok": True,
        "message": "ready",
        "status": _local_model_status(),
        "configs": _serialize_llm_configs(),
        "profile_id": profile.id,
    }


async def data_sources():
    """Product-facing demo and user connection data source catalog for the chat UI."""
    sources = [source.to_public_dict() for source in list_data_sources()]
    return {"sources": sources}


async def demo_data_sources():
    """Full demo source catalog, independent of one-click connection state."""
    sources = [source.to_public_dict() for source in list_demo_data_sources(include_not_ready=False)]
    return {"sources": sources}


async def resolve_data_source_for_query(req: DataSourceResolveRequest):
    """Pick the most relevant connected data source for a free-form question."""
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(400, "query is required")

    sources = list_data_sources(include_not_ready=False)
    if not sources:
        raise HTTPException(409, "Connect data before asking a question")

    fallback = sources[0]
    if len(sources) == 1:
        return {
            "source": fallback.to_public_dict(),
            "reason": "Only one ready data source is connected.",
        }

    candidates = "\n".join(f"- {_data_source_candidate_text(source)}" for source in sources)
    system_msg = (
        "You route a user's database question to exactly one connected data source. "
        "Use the source name, database name, engine, and description. "
        "Return only compact JSON with keys source_id and reason. "
        "The source_id must exactly match one of the provided ids. "
        "Do not return markdown, commentary, or any text outside the JSON object."
    )
    user_msg = (
        "Connected data sources:\n"
        f"{candidates}\n\n"
        "User question:\n"
        f"{query[:3000]}"
    )

    try:
        raw = await asyncio.wait_for(
            asyncio.to_thread(
                _call_llm_for_selected_model,
                [{"role": "system", "content": system_msg}, {"role": "user", "content": user_msg}],
                req.model,
                0.0,
                160,
            ),
            timeout=20,
        )
        parsed = _extract_json_object(raw)
        source_id = str(parsed.get("source_id") or "").strip()
        chosen = next((source for source in sources if source.id == source_id), None)
        reason = str(parsed.get("reason") or "").strip()
        if chosen:
            return {
                "source": chosen.to_public_dict(),
                "reason": reason or "Matched automatically from the question.",
            }
        logger.warning("data source resolve returned invalid source_id=%r raw=%r", source_id, raw)
        keyword_source, keyword_reason = _keyword_route_data_source(query, sources)
        if keyword_source:
            return {
                "source": keyword_source.to_public_dict(),
                "reason": keyword_reason,
            }
        raise HTTPException(
            408,
            "Auto match could not confidently choose a data source. Please select a database manually.",
        )
    except asyncio.TimeoutError as exc:
        logger.warning("data source resolve timed out")
        raise HTTPException(
            408,
            "Auto match timed out. Please select a database manually.",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("data source resolve failed: %s", exc)
        keyword_source, keyword_reason = _keyword_route_data_source(query, sources)
        if keyword_source:
            return {
                "source": keyword_source.to_public_dict(),
                "reason": keyword_reason,
            }
        raise HTTPException(
            408,
            "Auto match could not choose a data source. Please select a database manually.",
        ) from exc


async def demo_connections():
    """Demo dataset groups available for one-click data-source setup."""
    return _demo_connections_payload()


async def save_demo_connection(req: DemoConnectionRequest):
    await asyncio.to_thread(connect_demo_group, req.source_group)
    return _demo_connection_payload(req.source_group)


async def remove_demo_connection(req: DemoConnectionRequest):
    await asyncio.to_thread(disconnect_demo_group, req.source_group)
    return _demo_connection_payload(req.source_group)


async def connections():
    """Saved user database connections."""
    return {"connections": [connection_public_dict(connection) for connection in list_connections()]}


async def test_connection(req: ConnectionTestRequest):
    if req.engine in {"postgres", "mysql"}:
        from data.connections.validation import (
            build_mysql_dsn,
            build_postgres_dsn,
            validate_mysql_connection,
            validate_postgres_connection,
        )

        if req.engine == "postgres":
            ok, message = await asyncio.to_thread(
                validate_postgres_connection,
                host=req.host,
                port=req.port,
                database=req.database,
                username=req.username,
                password=req.password,
                sslmode=req.sslmode,
            )
        else:
            ok, message = await asyncio.to_thread(
                validate_mysql_connection,
                host=req.host,
                port=req.port,
                database=req.database,
                username=req.username,
                password=req.password,
            )
        schema_preview = ""
        if ok:
            try:
                dsn = (
                    build_postgres_dsn(
                        host=req.host,
                        port=req.port,
                        database=req.database,
                        username=req.username,
                        password=req.password,
                        sslmode=req.sslmode,
                    )
                    if req.engine == "postgres"
                    else build_mysql_dsn(
                        host=req.host,
                        port=req.port,
                        database=req.database,
                        username=req.username,
                        password=req.password,
                    )
                )
                schema_source = DataSource(
                    id="connection:draft",
                    source_group="user_connection",
                    engine=req.engine,
                    display_name=req.database or req.host,
                    ready=True,
                    source_type="user_connection",
                    database=req.database,
                    dsn=dsn,
                    connection_id="draft",
                )
                schema_preview = await asyncio.to_thread(_source_schema_text, schema_source)
            except Exception as exc:
                ok = False
                message = f"Could not read schema: {exc}"
        return {
            "ok": ok,
            "message": message,
            "schema_preview": schema_preview[:4000],
            "path": "",
        }

    ok, message, db_path = await asyncio.to_thread(validate_local_database, req.engine, req.path)
    source = None
    if ok and db_path is not None:
        source = DataSource(
            id="connection:draft",
            source_group="user_connection",
            engine=req.engine,
            display_name=db_path.stem,
            ready=True,
            source_type="user_connection",
            database=db_path.stem,
            db_path=db_path,
            connection_id="draft",
            description=f"User {req.engine.upper()} local file connection",
        )
    schema_preview = ""
    if source is not None:
        try:
            schema_preview = await asyncio.to_thread(_source_schema_text, source)
        except Exception as exc:
            ok = False
            message = f"Could not read schema: {exc}"
    return {
        "ok": ok,
        "message": message,
        "schema_preview": schema_preview[:4000],
        "path": str(db_path) if db_path is not None else "",
    }


async def import_connection_file(
    request: Request,
    engine: ConnectionEngine = Query(...),
    filename: str = Query(...),
):
    try:
        ok, message, path = await asyncio.to_thread(
            _write_imported_database_file,
            engine,
            filename,
            await request.body(),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"ok": ok, "message": message, "path": path}


async def save_connection(req: ConnectionCreateRequest):
    try:
        connection = await asyncio.to_thread(
            create_connection,
            name=req.name,
            engine=req.engine,
            path=req.path,
            host=req.host,
            port=req.port,
            database=req.database,
            username=req.username,
            password=req.password,
            sslmode=req.sslmode,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"connection": connection_public_dict(connection)}


async def patch_connection(connection_id: str, req: ConnectionUpdateRequest):
    try:
        connection = await asyncio.to_thread(
            update_connection,
            connection_id,
            name=req.name,
            path=req.path,
            host=req.host,
            port=req.port,
            database=req.database,
            username=req.username,
            password=req.password,
            sslmode=req.sslmode,
        )
    except KeyError:
        raise HTTPException(404, "Connection not found") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"connection": connection_public_dict(connection)}


async def remove_connection(connection_id: str):
    try:
        await asyncio.to_thread(delete_connection, connection_id)
    except KeyError:
        raise HTTPException(404, "Connection not found") from None
    return {"status": "ok"}


async def database_schema(database: str):
    """Return schema text for the data source currently identified by display name."""
    source = _source_for_display_name(database)
    schema = _source_schema_text(source)
    return {
        "database": source.display_name,
        "schema": schema,
        "dialect": source.engine,
    }


async def tasks(limit: int = 200):
    """Return safe, optional example prompts for the bundled demo data sources."""
    out = []
    for index, item in enumerate(_read_demo_questions()):
        source_id = str(item.get("source_id") or "")
        try:
            source = resolve_data_source(source_id)
        except KeyError:
            continue
        out.append({
            "instance_id": str(item.get("id") or f"demo-{index + 1}"),
            "source_id": source_id,
            "database": source.database or source.display_name,
            "amb_user_query": str(item.get("question") or ""),
            "num_critical_ambiguity": 0,
            "num_knowledge_ambiguity": 0,
            "has_follow_up": False,
        })
        if len(out) >= limit:
            break
    return {"tasks": out, "dataset": "demo"}


async def freechat_start(req: FreechatStartRequest):
    """Create a product chat session over a selected demo data source."""
    task_id = f"freechat_{uuid.uuid4().hex[:12]}"
    try:
        source = resolve_data_source(req.source_id)
    except KeyError:
        raise HTTPException(404, f"Unknown data source: {req.source_id}") from None
    if not source.ready:
        raise HTTPException(409, source.reason or f"Data source is not ready: {source.id}")
    try:
        data_session = await asyncio.to_thread(create_data_session, source, task_id)
    except Exception as exc:
        raise HTTPException(500, f"Failed to initialize data source session: {exc}") from exc

    try:
        await AGENT_RUNTIME.init_session(
            task_id=task_id,
            data_session=data_session,
            user_query=req.query,
            model=req.model,
            parent_context=req.parent_context,
        )
    except Exception:
        await asyncio.to_thread(cleanup_data_session, data_session)
        raise

    return {
        "task_id": task_id,
        "mode": "free-chat",
        "source": source.to_public_dict(),
        "user_query": req.query,
    }


async def turn(req: TurnRequest):
    """Run one SQL agent turn and wait for it to finish."""
    try:
        return await AGENT_RUNTIME.run_turn(
            task_id=req.task_id,
            message=req.message,
            model=req.model,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from None


async def answer_user(req: AnswerUserRequest):
    try:
        answered = await AGENT_RUNTIME.answer_user(req.task_id, req.answer)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from None
    if not answered:
        raise HTTPException(404, "no pending question for this task")
    return {"status": "ok", "task_id": req.task_id}


async def cancel_turn(req: CancelRequest):
    """Stop the in-flight dbagent turn best-effort."""
    hit = AGENT_RUNTIME.request_cancel(req.task_id)
    return {"status": "ok" if hit else "no_active_turn", "task_id": req.task_id}


async def title(req: TitleRequest):
    """Generate a short conversation title."""
    text = (req.text or "").strip()
    if not text:
        return {"title": ""}
    try:
        out = await asyncio.to_thread(
            _call_llm_for_selected_model,
            [
                {
                    "role": "system",
                    "content": (
                        "You write very short titles that summarize a database "
                        "question in 3 to 6 words. Reply with the title only, "
                        "no quotes, no punctuation, Title Case."
                    ),
                },
                {"role": "user", "content": text[:2000]},
            ],
            None,
            0.0,
            128,
        )
        title_text = out.splitlines()[0].strip().strip("\"'").strip() if out else ""
    except Exception as exc:
        logger.warning("title generation failed: %s", exc)
        title_text = ""
    return {"title": title_text}


async def analyze(req: AnalyzeRequest):
    """Analyze a query result in plain language."""
    if not (req.question or "").strip() or not (req.result or "").strip():
        return {"analysis": ""}
    user_parts = [f"User question:\n{req.question[:2000]}"]
    if (req.sql or "").strip():
        user_parts.append(f"\nSQL that produced the result:\n{req.sql.strip()[:4000]}")
    user_parts.append(f"\nQuery result:\n{req.result[:6000]}")
    try:
        out = await asyncio.to_thread(
            _call_llm_for_selected_model,
            [
                {
                    "role": "system",
                    "content": (
                        "You are a data analyst. Given a user's question, SQL, "
                        "and result, write a concise plain-language analysis. "
                        "Directly answer the question and call out key numbers."
                    ),
                },
                {"role": "user", "content": "\n".join(user_parts)},
            ],
            req.model,
            0.2,
            2048,
        )
    except Exception as exc:
        if req.model:
            fallback_model = default_model_id()
            if fallback_model and fallback_model != req.model:
                logger.warning(
                    "result analysis failed with selected model %s, retrying default %s: %s",
                    req.model,
                    fallback_model,
                    exc,
                )
                try:
                    out = await asyncio.to_thread(
                        _call_llm_for_selected_model,
                        [
                            {
                                "role": "system",
                                "content": (
                                    "You are a data analyst. Given a user's question, SQL, "
                                    "and result, write a concise plain-language analysis. "
                                    "Directly answer the question and call out key numbers."
                                ),
                            },
                            {"role": "user", "content": "\n".join(user_parts)},
                        ],
                        fallback_model,
                        0.2,
                        2048,
                    )
                except Exception as fallback_exc:
                    logger.exception("result analysis fallback failed: %s", fallback_exc)
                    raise HTTPException(502, "analysis failed") from fallback_exc
            else:
                logger.exception("result analysis failed: %s", exc)
                raise HTTPException(502, "analysis failed") from exc
        else:
            logger.exception("result analysis failed: %s", exc)
            raise HTTPException(502, "analysis failed") from exc
    return {"analysis": out}


async def branch_answer(req: BranchAnswerRequest):
    """Answer a manual canvas branch without starting the agent/tool loop."""
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(400, "question is required")

    system_msg = (
        "You answer a local follow-up from a canvas card. Answer only the user's "
        "new question using the provided parent-thread context. Do not plan or "
        "call tools, do not invent database results, and do not continue the full "
        "agent workflow. If the answer requires fresh SQL execution or unavailable "
        "data, say that briefly and explain what can be concluded from the context."
    )
    user_msg = (
        "Parent-thread context:\n"
        f'"""\n{(req.parent_context or "").strip() or "(no parent context provided)"}\n"""\n\n'
        "User's local branch question:\n"
        f'"""\n{question}\n"""\n\n'
        "Respond with the direct answer only."
    )

    try:
        answer = await asyncio.to_thread(
            _call_llm_for_selected_model,
            [{"role": "system", "content": system_msg}, {"role": "user", "content": user_msg}],
            req.model,
            0.2,
            900,
        )
    except Exception as exc:
        logger.warning("branch_answer LLM call failed: %s", exc)
        raise HTTPException(502, f"branch answer failed: {exc}")

    return {"answer": answer}


async def visualize(req: VisualizationRequest):
    """Get an LLM-generated chart specification for a result table."""
    if not (req.result or "").strip() or not (req.prompt or "").strip():
        return {"spec": {}}
    user_parts = [f"User question:\n{req.question[:2000]}"] if req.question else []
    if (req.sql or "").strip():
        user_parts.append(f"\nSQL that produced the result:\n{req.sql.strip()[:4000]}")
    user_parts.append(f"\nQuery result table text:\n{req.result[:6000]}")
    user_parts.append(f"\nRequested visualization:\n{req.prompt[:1000]}")
    try:
        raw = await asyncio.to_thread(
            _call_llm_for_selected_model,
            [
                {
                    "role": "system",
                    "content": (
                        "Choose a chart specification for a SQL result table. "
                        "Return JSON only with this schema: "
                        '{"chart_type":"bar|line|scatter|histogram","title":"short title",'
                        '"x_key":"exact column name or null","y_key":"exact column name or null",'
                        '"value_key":"exact column name or null","x_label":"short axis label",'
                        '"y_label":"short axis label","reason":"one short sentence",'
                        '"style":{"accent":"teal","background":"soft neutral","border":"light",'
                        '"radius":"large","font":"clean minimal","density":"comfortable"}}.'
                    ),
                },
                {"role": "user", "content": "\n".join(user_parts)},
            ],
            None,
            0.1,
            512,
        )
        spec = json.loads(raw) if raw else {}
    except Exception as exc:
        logger.warning("visualization suggestion failed: %s", exc)
        raise HTTPException(502, "visualization suggestion failed")
    return {"spec": spec}


def _parse_last_event_id(value: str | None) -> int:
    if not value:
        return -1
    try:
        return int(value)
    except ValueError:
        return -1


def _sse_event(index: int, event: dict[str, Any]) -> bytes:
    return f"id: {index}\ndata: {json.dumps(event, default=str)}\n\n".encode()


async def events_proxy(task_id: str, request: Request):
    """Stream dbagent runtime events to the browser."""

    async def gen():
        last_seen = _parse_last_event_id(request.headers.get("last-event-id"))
        q = await AGENT_RUNTIME.event_bus.subscribe(task_id)
        yield b": connected\n\n"
        high_water = last_seen
        try:
            try:
                state = AGENT_RUNTIME.public_state(task_id)
                replay_events = list(state.get("agent_events") or [])
            except KeyError:
                replay_events = []
            for index, evt in enumerate(replay_events):
                if index <= last_seen:
                    continue
                yield _sse_event(index, evt)
                high_water = index

            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=20.0)
                    if item.index <= high_water:
                        continue
                    yield _sse_event(item.index, item.payload)
                    high_water = item.index
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            AGENT_RUNTIME.event_bus.unsubscribe(task_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


async def session_snapshot(task_id: str):
    try:
        return AGENT_RUNTIME.session_response(task_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from None


async def cleanup(task_id: str):
    AGENT_RUNTIME.cleanup(task_id)
    return {"status": "ok", "task_id": task_id}
