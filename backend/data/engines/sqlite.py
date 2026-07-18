from __future__ import annotations

import json
import shutil
import sqlite3
import time
from pathlib import Path

from dbagent.agents.dbtools import DBType
from data.models import DataSource
from shared.config import LOGS_DIR

from .models import AgentRunConfig, DataSourceSession
from .sql_utils import ensure_readonly_sql, format_rows

SQL_TIMEOUT_SECS = 60


def _load_knowledge(source: DataSource) -> tuple[list[dict] | None, dict[str, str] | None]:
    kb_entries = None
    column_meanings = None
    if source.knowledge_path is not None:
        kb_entries = []
        with source.knowledge_path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    item = json.loads(line)
                    if isinstance(item, dict):
                        kb_entries.append(item)
    if source.column_meanings_path is not None:
        payload = json.loads(source.column_meanings_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"Column meanings must be a JSON object: {source.column_meanings_path}")
        column_meanings = {str(key): str(value) for key, value in payload.items()}
    return kb_entries, column_meanings


def create_session(source: DataSource, task_id: str) -> DataSourceSession:
    if source.db_path is None or not source.db_path.exists():
        raise FileNotFoundError(f"SQLite database file not found for source {source.id}: {source.db_path}")
    workspace_dir = LOGS_DIR / "data_source_sessions" / task_id
    workspace_dir.mkdir(parents=True, exist_ok=True)
    db_path = workspace_dir / source.db_path.name
    shutil.copy2(source.db_path, db_path)
    kb_entries, column_meanings = _load_knowledge(source)
    return DataSourceSession(
        task_id=task_id,
        source=source,
        workspace_dir=workspace_dir,
        cleanup_paths=[db_path],
        run_config=AgentRunConfig(
            db_type=DBType.SQLITE,
            db_path=str(db_path),
            prompt_prefix=(
                f"SQLite database: {source.display_name}\n"
                f"SQLite database path: {db_path}\n"
                "Use this exact db_path when calling SQLite tools. "
                "Inspect the schema, run read-only checks, validate the final SQL, "
                "and answer with one SQL query."
            ),
            kb_entries=kb_entries,
            column_meanings=column_meanings,
        ),
    )


def execute_final_sql(session: DataSourceSession, sql: str) -> str:
    ok, error = ensure_readonly_sql(sql)
    if not ok:
        return f"SQL Error: {error}"
    db_path = session.run_config.db_path
    if not db_path:
        return "SQL Error: SQLite database path was not initialized"
    try:
        with _connect_readonly(Path(db_path)) as conn:
            columns, rows = _execute_with_timeout(conn, sql)
    except Exception as exc:
        return f"SQL Error: {exc}"
    return format_rows(rows, columns)


def cleanup(session: DataSourceSession) -> None:
    for path in session.cleanup_paths or []:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass


def _connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _execute_with_timeout(conn: sqlite3.Connection, sql: str) -> tuple[list[str], list[tuple]]:
    deadline = time.monotonic() + SQL_TIMEOUT_SECS

    def progress_handler() -> int:
        return 1 if time.monotonic() >= deadline else 0

    conn.set_progress_handler(progress_handler, 10000)
    try:
        cursor = conn.cursor()
        cursor.execute(sql.strip().rstrip(";"))
        columns = [description[0] for description in cursor.description] if cursor.description else []
        rows = cursor.fetchall() if cursor.description else []
        return columns, rows
    finally:
        conn.set_progress_handler(None, 0)
