from __future__ import annotations

from urllib.parse import unquote, unquote_plus, urlparse

from dbagent.agents.dbtools import DBType
from data.models import DataSource
from shared.config import LOGS_DIR

from .models import AgentRunConfig, DataSourceSession
from .sql_utils import ensure_readonly_sql, format_rows


def create_session(source: DataSource, task_id: str) -> DataSourceSession:
    if source.source_type != "user_connection":
        raise ValueError(f"MySQL source must be a user connection: {source.id}")
    if not source.dsn:
        raise ValueError(f"MySQL user connection has no DSN: {source.id}")
    workspace_dir = LOGS_DIR / "data_source_sessions" / task_id
    workspace_dir.mkdir(parents=True, exist_ok=True)
    return DataSourceSession(
        task_id=task_id,
        source=source,
        workspace_dir=workspace_dir,
        run_config=AgentRunConfig(
            db_type=DBType.MYSQL,
            db_path=source.dsn,
            prompt_prefix=(
                f"MySQL database: {source.display_name}\n"
                "This is a user-provided MySQL connection. Treat it as read-only. "
                "Use the MySQL tools to inspect schema, run read-only checks, "
                "validate the final SQL, and answer with one SQL query."
            ),
        ),
    )


def execute_final_sql(session: DataSourceSession, sql: str) -> str:
    ok, error = ensure_readonly_sql(sql)
    if not ok:
        return f"SQL Error: {error}"
    dsn = session.run_config.db_path
    if not dsn:
        return "SQL Error: MySQL connection was not initialized"
    try:
        conn = connect_mysql(dsn)
        try:
            with conn.cursor() as cur:
                cur.execute("SET SESSION TRANSACTION READ ONLY")
                cur.execute("START TRANSACTION READ ONLY")
                try:
                    cur.execute(sql.strip().rstrip(";"))
                    columns = [description[0] for description in cur.description] if cur.description else []
                    rows = cur.fetchmany(101) if cur.description else []
                finally:
                    conn.rollback()
        finally:
            conn.close()
    except Exception as exc:
        return f"SQL Error: {exc}"
    return format_rows(rows[:100], columns)


def cleanup(session: DataSourceSession) -> None:
    return


def connect_mysql(dsn: str):
    import pymysql

    parsed = urlparse(dsn)
    if parsed.scheme != "mysql":
        raise ValueError("MySQL DSN must start with mysql://")
    database = unquote(parsed.path.lstrip("/"))
    if not parsed.hostname:
        raise ValueError("MySQL DSN is missing host")
    if not database:
        raise ValueError("MySQL DSN is missing database")
    return pymysql.connect(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=unquote_plus(parsed.username or ""),
        password=unquote_plus(parsed.password or ""),
        database=database,
        connect_timeout=10,
        read_timeout=60,
        write_timeout=10,
        charset="utf8mb4",
        autocommit=False,
        cursorclass=pymysql.cursors.Cursor,
    )
