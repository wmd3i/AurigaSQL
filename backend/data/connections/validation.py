from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Literal
from urllib.parse import quote, quote_plus

ConnectionEngine = Literal["sqlite", "duckdb", "postgres", "mysql"]
PostgresSslMode = Literal["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]

SQLITE_SUFFIXES = {".sqlite", ".sqlite3", ".db"}
DUCKDB_SUFFIXES = {".duckdb", ".db"}
POSTGRES_SSLMODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


def normalize_local_path(path: str) -> Path:
    candidate = Path(path.strip()).expanduser()
    if not candidate.is_absolute():
        raise ValueError("path must be an absolute file path")
    return candidate.resolve()


def validate_local_database(engine: ConnectionEngine, path: str) -> tuple[bool, str, Path | None]:
    if engine in {"postgres", "mysql"}:
        return False, f"{engine} connections use host, port, database, username, and password", None

    try:
        db_path = normalize_local_path(path)
    except ValueError as exc:
        return False, str(exc), None

    if not db_path.exists():
        return False, f"File not found: {db_path}", db_path
    if not db_path.is_file():
        return False, f"Path is not a file: {db_path}", db_path

    suffix = db_path.suffix.lower()
    if engine == "sqlite" and suffix not in SQLITE_SUFFIXES:
        return False, "SQLite files must use .sqlite, .sqlite3, or .db", db_path
    if engine == "duckdb" and suffix not in DUCKDB_SUFFIXES:
        return False, "DuckDB files must use .duckdb or .db", db_path

    try:
        if engine == "sqlite":
            _test_sqlite(db_path)
        elif engine == "duckdb":
            _test_duckdb(db_path)
        else:
            return False, f"Unsupported local database engine: {engine}", db_path
    except Exception as exc:
        return False, f"Could not open {engine} database read-only: {exc}", db_path

    return True, "Connection succeeded", db_path


def _test_sqlite(db_path: Path) -> None:
    uri = f"{db_path.as_uri()}?mode=ro"
    deadline = time.monotonic() + 10
    with sqlite3.connect(uri, uri=True) as conn:
        def progress_handler() -> int:
            return 1 if time.monotonic() >= deadline else 0

        conn.set_progress_handler(progress_handler, 10000)
        try:
            conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
        finally:
            conn.set_progress_handler(None, 0)


def _test_duckdb(db_path: Path) -> None:
    import duckdb

    with duckdb.connect(database=str(db_path), read_only=True) as conn:
        conn.execute("SELECT 1").fetchone()


def validate_postgres_connection(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
    sslmode: str = "prefer",
) -> tuple[bool, str]:
    dsn = build_postgres_dsn(
        host=host,
        port=port,
        database=database,
        username=username,
        password=password,
        sslmode=sslmode,
    )
    try:
        _test_postgres(dsn)
    except Exception as exc:
        return False, f"Could not connect to postgres database read-only: {exc}"
    return True, "Connection succeeded"


def validate_mysql_connection(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
) -> tuple[bool, str]:
    try:
        _test_mysql(
            host=host,
            port=port,
            database=database,
            username=username,
            password=password,
        )
    except Exception as exc:
        return False, f"Could not connect to mysql database: {exc}"
    return True, "Connection succeeded"


def build_postgres_dsn(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
    sslmode: str = "prefer",
) -> str:
    host = host.strip()
    database = database.strip()
    username = username.strip()
    sslmode = sslmode.strip() or "prefer"
    if not host:
        raise ValueError("host is required")
    if not database:
        raise ValueError("database is required")
    if not username:
        raise ValueError("username is required")
    if port <= 0 or port > 65535:
        raise ValueError("port must be between 1 and 65535")
    if sslmode not in POSTGRES_SSLMODES:
        raise ValueError("invalid sslmode")
    user = quote(username, safe="")
    pwd = quote(password, safe="")
    db = quote(database, safe="")
    # Enforce read-only and query timeout at the connection/session level for
    # agent tools that connect directly through POSTGRES_DSN.
    options = quote("-c default_transaction_read_only=on -c statement_timeout=60000", safe="")
    return f"postgresql://{user}:{pwd}@{host}:{port}/{db}?sslmode={sslmode}&options={options}"


def build_mysql_dsn(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
) -> str:
    host = host.strip()
    database = database.strip()
    username = username.strip()
    if not host:
        raise ValueError("host is required")
    if not database:
        raise ValueError("database is required")
    if not username:
        raise ValueError("username is required")
    if port <= 0 or port > 65535:
        raise ValueError("port must be between 1 and 65535")
    user = quote_plus(username)
    pwd = quote_plus(password)
    db = quote(database, safe="")
    return f"mysql://{user}:{pwd}@{host}:{port}/{db}"


def mask_postgres_location(host: str, port: int, database: str, username: str) -> str:
    return f"{username.strip()}@{host.strip()}:{port}/{database.strip()}"


def mask_mysql_location(host: str, port: int, database: str, username: str) -> str:
    return f"{username.strip()}@{host.strip()}:{port}/{database.strip()}"


def _test_postgres(dsn: str) -> None:
    try:
        import psycopg

        with psycopg.connect(dsn, connect_timeout=10) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        return
    except ModuleNotFoundError:
        pass

    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
    finally:
        conn.close()


def _test_mysql(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
) -> None:
    host = host.strip()
    database = database.strip()
    username = username.strip()
    if not host:
        raise ValueError("host is required")
    if not database:
        raise ValueError("database is required")
    if not username:
        raise ValueError("username is required")
    if port <= 0 or port > 65535:
        raise ValueError("port must be between 1 and 65535")

    import pymysql

    conn = pymysql.connect(
        host=host,
        port=port,
        user=username,
        password=password,
        database=database,
        connect_timeout=10,
        read_timeout=10,
        write_timeout=10,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.Cursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute("SELECT 1")
            cur.fetchone()
    finally:
        conn.close()
