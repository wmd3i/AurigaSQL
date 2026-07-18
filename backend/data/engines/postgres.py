from __future__ import annotations

from dbagent.agents.dbtools import DBType
from data.models import DataSource
from shared.config import LOGS_DIR

from .models import AgentRunConfig, DataSourceSession
from .sql_utils import ensure_readonly_sql, format_rows


def create_session(source: DataSource, task_id: str) -> DataSourceSession:
    if source.source_type != "user_connection":
        raise ValueError(f"Postgres sources must be user connections: {source.id}")
    return _create_user_connection_session(source, task_id)


def execute_final_sql(session: DataSourceSession, sql: str) -> str:
    return _execute_user_connection_sql(session, sql)


def cleanup(session: DataSourceSession) -> None:
    return


def _create_user_connection_session(source: DataSource, task_id: str) -> DataSourceSession:
    if not source.dsn:
        raise ValueError(f"Postgres user connection has no DSN: {source.id}")
    workspace_dir = LOGS_DIR / "data_source_sessions" / task_id
    workspace_dir.mkdir(parents=True, exist_ok=True)
    return DataSourceSession(
        task_id=task_id,
        source=source,
        workspace_dir=workspace_dir,
        run_config=AgentRunConfig(
            db_type=DBType.POSTGRES,
            db_path=source.dsn,
            prompt_prefix=(
                f"PostgreSQL database: {source.display_name}\n"
                "This is a user-provided PostgreSQL connection. Treat it as read-only. "
                "Use the PostgreSQL tools to inspect schema, run read-only checks, "
                "validate the final SQL, and answer with one SQL query."
            ),
        ),
    )


def _execute_user_connection_sql(session: DataSourceSession, sql: str) -> str:
    ok, error = ensure_readonly_sql(sql)
    if not ok:
        return f"SQL Error: {error}"
    dsn = session.run_config.db_path
    if not dsn:
        return "SQL Error: Postgres connection was not initialized"
    try:
        try:
            import psycopg

            with psycopg.connect(dsn, connect_timeout=10) as conn:
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute("BEGIN READ ONLY")
                    try:
                        cur.execute("SET LOCAL statement_timeout = '60s'")
                        cur.execute(sql.strip().rstrip(";"))
                        columns = [description[0] for description in cur.description] if cur.description else []
                        rows = cur.fetchmany(101) if cur.description else []
                    finally:
                        cur.execute("ROLLBACK")
        except ModuleNotFoundError:
            import psycopg2

            conn = psycopg2.connect(dsn, connect_timeout=10)
            conn.autocommit = True
            try:
                with conn.cursor() as cur:
                    cur.execute("BEGIN READ ONLY")
                    try:
                        cur.execute("SET LOCAL statement_timeout = '60s'")
                        cur.execute(sql.strip().rstrip(";"))
                        columns = [description[0] for description in cur.description] if cur.description else []
                        rows = cur.fetchmany(101) if cur.description else []
                    finally:
                        cur.execute("ROLLBACK")
            finally:
                conn.close()
    except Exception as exc:
        return f"SQL Error: {exc}"
    return format_rows(rows[:100], columns)
