from __future__ import annotations

from data.models import DataSource

from .models import DataSourceSession


def create_data_session(source: DataSource, task_id: str) -> DataSourceSession:
    if not source.ready:
        raise ValueError(source.reason or f"Data source is not ready: {source.id}")
    if source.engine == "postgres":
        from . import postgres

        return postgres.create_session(source, task_id)
    if source.engine == "mysql":
        from . import mysql

        return mysql.create_session(source, task_id)
    if source.engine == "sqlite":
        from . import sqlite

        return sqlite.create_session(source, task_id)
    if source.engine == "duckdb":
        from . import duckdb

        return duckdb.create_session(source, task_id)
    raise ValueError(f"Unsupported data engine: {source.engine}")


def execute_final_sql(session: DataSourceSession, sql: str) -> str:
    if session.source.engine == "postgres":
        from . import postgres

        return postgres.execute_final_sql(session, sql)
    if session.source.engine == "mysql":
        from . import mysql

        return mysql.execute_final_sql(session, sql)
    if session.source.engine == "sqlite":
        from . import sqlite

        return sqlite.execute_final_sql(session, sql)
    if session.source.engine == "duckdb":
        from . import duckdb

        return duckdb.execute_final_sql(session, sql)
    return f"SQL Error: Unsupported data engine: {session.source.engine}"


def cleanup_data_session(session: DataSourceSession) -> None:
    if session.source.engine == "postgres":
        from . import postgres

        postgres.cleanup(session)
    elif session.source.engine == "mysql":
        from . import mysql

        mysql.cleanup(session)
    elif session.source.engine == "sqlite":
        from . import sqlite

        sqlite.cleanup(session)
    elif session.source.engine == "duckdb":
        from . import duckdb

        duckdb.cleanup(session)
