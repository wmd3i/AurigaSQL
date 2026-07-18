from __future__ import annotations

import shutil

from dbagent.agents.dbtools import DBType
from data.models import DataSource
from shared.config import LOGS_DIR

from .models import AgentRunConfig, DataSourceSession
from .sql_utils import ensure_readonly_sql, format_rows


def create_session(source: DataSource, task_id: str) -> DataSourceSession:
    if source.db_path is None or not source.db_path.exists():
        raise FileNotFoundError(f"DuckDB database file not found for source {source.id}: {source.db_path}")
    workspace_dir = LOGS_DIR / "data_source_sessions" / task_id
    workspace_dir.mkdir(parents=True, exist_ok=True)
    db_path = workspace_dir / source.db_path.name
    shutil.copy2(source.db_path, db_path)
    return DataSourceSession(
        task_id=task_id,
        source=source,
        workspace_dir=workspace_dir,
        cleanup_paths=[db_path],
        run_config=AgentRunConfig(
            db_type=DBType.DUCKDB,
            db_path=str(db_path),
            prompt_prefix=(
                f"DuckDB database: {source.display_name}\n"
                f"DuckDB database path: {db_path}\n"
                "Use this exact db_path when calling DuckDB tools. "
                "Inspect the schema, run read-only checks, validate the final SQL, "
                "and answer with one SQL query."
            ),
        ),
    )


def execute_final_sql(session: DataSourceSession, sql: str) -> str:
    ok, error = ensure_readonly_sql(sql)
    if not ok:
        return f"SQL Error: {error}"
    db_path = session.run_config.db_path
    if not db_path:
        return "SQL Error: DuckDB database path was not initialized"
    try:
        import duckdb

        with duckdb.connect(database=db_path, read_only=True) as conn:
            rows = conn.execute(sql.strip().rstrip(";")).fetchall()
            columns = [description[0] for description in conn.description] if conn.description else []
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
