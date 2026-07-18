from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import unquote, unquote_plus, urlparse

try:
    import sqlglot
except Exception:
    sqlglot = None
try:
    import psycopg
    from psycopg import sql as pg_sql
except Exception:
    psycopg = None
    pg_sql = None
try:
    import duckdb
except Exception:
    duckdb = None


class DBType(str, Enum):
    SQLITE = "sqlite"
    DUCKDB = "duckdb"
    POSTGRES = "postgres"
    MYSQL = "mysql"


POSTGRES_DSN_ENV = "POSTGRES_DSN"
MYSQL_DSN_ENV = "MYSQL_DSN"
SQL_QUERY_TIMEOUT_SECS = 60

def dump_json(payload: Any) -> str:
    return json.dumps(payload, indent=2, default=str, ensure_ascii=False)


def _connect_readonly(db_path: str) -> sqlite3.Connection:
    from urllib.parse import quote

    uri = f"file:{quote(str(db_path))}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _execute_sqlite_with_timeout(conn: sqlite3.Connection, query: str) -> tuple[list[str], list[tuple]]:
    deadline = time.monotonic() + SQL_QUERY_TIMEOUT_SECS

    def _progress_handler() -> int:
        return 1 if time.monotonic() >= deadline else 0

    conn.set_progress_handler(_progress_handler, 10000)
    try:
        cursor = conn.cursor()
        cursor.execute(query)
        columns = [description[0] for description in cursor.description] if cursor.description else []
        rows = cursor.fetchall() if cursor.description else []
        return columns, rows
    except sqlite3.OperationalError as exc:
        if "interrupted" in str(exc).lower():
            raise TimeoutError(f"query timed out after {SQL_QUERY_TIMEOUT_SECS}s") from exc
        raise
    finally:
        conn.set_progress_handler(None, 0)


def _postgres_timeout_sql() -> str:
    return f"SET LOCAL statement_timeout = '{SQL_QUERY_TIMEOUT_SECS}s'"


def _is_postgres_timeout_error(exc: Exception) -> bool:
    return "statement timeout" in str(exc).lower() or "canceling statement due to statement timeout" in str(exc).lower()


def _is_mysql_timeout_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "max_execution_time" in text or "query execution was interrupted" in text or "timeout" in text


def _ensure_db_file(db_path: str) -> Path | None:
    path = Path(db_path)
    return path if path.is_file() else None


def _nice_table(column_names: list[str], values: list[tuple]) -> str:
    lines = ["|".join(column_names)]
    lines.extend("|".join(str(value) for value in row) for row in values)
    return "\n".join(lines)


def _format_readonly_rows(columns: list[str], rows: list[tuple]) -> list[dict[str, Any]]:
    return [{column: value for column, value in zip(columns, row)} for row in rows]


def _readonly_payload(dialect: str, query: str, columns: list[str], rows: list[tuple]) -> str:
    payload: dict[str, Any] = {
        "dialect": dialect,
        "query": query,
        "columns": columns,
        "returned_rows": len(rows),
        "row_count": len(rows),
        "truncated": False,
        "rows": _format_readonly_rows(columns, rows),
    }
    return dump_json(payload)


def _connect_duckdb_readonly(db_path: str):
    if duckdb is None:
        raise RuntimeError("duckdb is not installed; duckdb tools are unavailable")
    if _ensure_db_file(db_path) is None:
        raise FileNotFoundError(f"database file not found: {db_path}")
    return duckdb.connect(database=db_path, read_only=True)


def _duckdb_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _duckdb_qualified_table(name: str) -> str:
    """Quote a (possibly schema-qualified) table reference, e.g. ``main.orders``.

    Each dot-separated segment is quoted independently so references like
    ``main_stg_shopify.orders`` resolve to the right schema instead of being
    treated as a single identifier containing a dot.
    """
    parts = name.split(".")
    return ".".join(_duckdb_identifier(part) for part in parts)


def list_sqlite_tables(db_path: str) -> str:
    full_schema = []
    try:
        if _ensure_db_file(db_path) is None:
            return f"Error fetching tables: database file not found: {db_path}"
        with _connect_readonly(db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = cursor.fetchall()
            for (table_name,) in tables:
                if table_name == "sqlite_sequence":
                    continue
                cursor.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    (table_name,),
                )
                create_stmt = cursor.fetchone()[0]
                full_schema.append(f"Table: {table_name}\nSchema: {create_stmt}\n")
        return "\n".join(full_schema)
    except Exception as exc:
        return f"Error fetching tables: {exc}"


def sample_sqlite_rows(db_path: str, table_name: str, limit: int = 15) -> str:
    try:
        if _ensure_db_file(db_path) is None:
            return f"Error sampling sqlite rows: database file not found: {db_path}"
        with _connect_readonly(db_path) as conn:
            cursor = conn.cursor()
            quoted_table = f"`{table_name}`"
            cursor.execute(f"SELECT * FROM {quoted_table} ORDER BY RANDOM() LIMIT ?;", (limit,))
            columns = [description[0] for description in cursor.description]
            rows = cursor.fetchall()
            table_view = _nice_table(columns, rows)
            if not rows:
                return f"/* Table {quoted_table} is empty with header {table_view} */"
            return (
                f"/* \n{limit} example random rows:\n"
                f"SELECT * FROM {quoted_table} LIMIT {limit};\n{table_view}\n*/"
            )
    except Exception as exc:
        return f"Error sampling sqlite rows: {exc}"


def validate_sqlite_query(sql_text: str) -> str:
    clean_sql = sql_text.replace("```sql", "").replace("```", "").strip()
    if sqlglot is None:
        return dump_json({"ok": True, "normalized_sql": clean_sql, "validator": "disabled"})
    try:
        ast = sqlglot.parse_one(clean_sql, read="sqlite")
        return dump_json({"ok": True, "normalized_sql": ast.sql(dialect="sqlite")})
    except Exception as exc:
        return dump_json(
            {
                "ok": False,
                "error": str(exc),
                "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
            }
        )


def _validate_readonly_sql(sql_text: str) -> tuple[bool, str]:
    query = sql_text.strip().rstrip(";")
    if not query:
        return False, "Error: Empty SQL query"
    return True, query


def _validate_select_like_sql(sql_text: str) -> tuple[bool, str]:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return ok, query
    if not re.match(r"^(select|with|explain|show)\b", query, re.IGNORECASE):
        return False, "Error: Only SELECT, WITH, EXPLAIN, or SHOW queries are allowed"
    return True, query


def run_sqlite_readonly(db_path: str, sql_text: str) -> str:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return query
    try:
        if _ensure_db_file(db_path) is None:
            return f"Error executing SQL: database file not found: {db_path}"
        with _connect_readonly(db_path) as conn:
            _, rows = _execute_sqlite_with_timeout(conn, query)
        return dump_json(rows)
    except TimeoutError as exc:
        return f"Error executing SQL: {exc}"
    except Exception as exc:
        return f"Error executing SQL: {exc}"


def explain_sqlite_query(db_path: str, sql_text: str) -> str:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return query
    try:
        if _ensure_db_file(db_path) is None:
            return f"Error explaining SQL: database file not found: {db_path}"
        with _connect_readonly(db_path) as conn:
            _, rows = _execute_sqlite_with_timeout(conn, f"EXPLAIN QUERY PLAN {query}")
        return dump_json(rows)
    except TimeoutError as exc:
        return f"Error explaining SQL: {exc}"
    except Exception as exc:
        return f"Error explaining SQL: {exc}"


def list_duckdb_tables(db_path: str) -> str:
    # Walk information_schema.columns across every user schema. SHOW TABLES only
    # reports the default search_path (typically just `main`), so staging schemas
    # like `main_stg_shopify` would otherwise be invisible to the agent.
    try:
        with _connect_duckdb_readonly(db_path) as conn:
            rows = conn.execute(
                """
                SELECT table_schema, table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                ORDER BY table_schema, table_name, ordinal_position
                """
            ).fetchall()
    except Exception as exc:
        return f"Error fetching duckdb tables: {exc}"
    tables: dict[tuple[str, str], list[str]] = {}
    for schema, table, column, data_type in rows:
        tables.setdefault((schema, table), []).append(f"{column} {data_type}")
    full_schema = [
        f"Table: {schema}.{table}\nColumns: {', '.join(columns)}\n"
        for (schema, table), columns in tables.items()
    ]
    return "\n".join(full_schema)


def sample_duckdb_rows(db_path: str, table_name: str, limit: int = 15) -> str:
    try:
        limit_value = int(limit)
        if limit_value <= 0:
            return "Error sampling duckdb rows: limit must be positive"
        quoted_table = _duckdb_qualified_table(table_name)
        with _connect_duckdb_readonly(db_path) as conn:
            try:
                rows = conn.execute(f"SELECT * FROM {quoted_table} USING SAMPLE {limit_value} ROWS").fetchall()
            except Exception:
                rows = conn.execute(f"SELECT * FROM {quoted_table} LIMIT ?", [limit_value]).fetchall()
            columns = [description[0] for description in conn.description] if conn.description else []
        table_view = _nice_table(columns, rows)
        if not rows:
            return f"/* Table {table_name} is empty with header {table_view} */"
        return f"/* \n{limit_value} example rows from {table_name}:\n{table_view}\n*/"
    except Exception as exc:
        return f"Error sampling duckdb rows: {exc}"


def validate_duckdb_query(sql_text: str) -> str:
    clean_sql = sql_text.replace("```sql", "").replace("```", "").strip()
    if sqlglot is None:
        return dump_json({"ok": True, "normalized_sql": clean_sql, "validator": "disabled"})
    try:
        ast = sqlglot.parse_one(clean_sql, read="duckdb")
        return dump_json({"ok": True, "normalized_sql": ast.sql(dialect="duckdb")})
    except Exception as exc:
        return dump_json(
            {
                "ok": False,
                "error": str(exc),
                "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
            }
        )


def run_duckdb_readonly(db_path: str, sql_text: str) -> str:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return query
    try:
        with _connect_duckdb_readonly(db_path) as conn:
            rows = conn.execute(query).fetchall()
            columns = [description[0] for description in conn.description] if conn.description else []
        return _readonly_payload("duckdb", query, columns, rows)
    except Exception as exc:
        return f"Error executing DuckDB SQL: {exc}"


def connect_postgres():
    if psycopg is None:
        raise RuntimeError("psycopg is not installed; postgres tools are unavailable")
    dsn = os.getenv(POSTGRES_DSN_ENV)
    if not dsn:
        raise RuntimeError(f"missing env var {POSTGRES_DSN_ENV}")
    return psycopg.connect(dsn)


def connect_mysql():
    dsn = os.getenv(MYSQL_DSN_ENV)
    if not dsn:
        raise RuntimeError(f"missing env var {MYSQL_DSN_ENV}")
    try:
        import pymysql
    except Exception as exc:
        raise RuntimeError("pymysql is not installed; mysql tools are unavailable") from exc

    parsed = urlparse(dsn)
    if parsed.scheme != "mysql":
        raise RuntimeError("MYSQL_DSN must start with mysql://")
    database = unquote(parsed.path.lstrip("/"))
    if not parsed.hostname:
        raise RuntimeError("MYSQL_DSN is missing host")
    if not database:
        raise RuntimeError("MYSQL_DSN is missing database")
    return pymysql.connect(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=unquote_plus(parsed.username or ""),
        password=unquote_plus(parsed.password or ""),
        database=database,
        connect_timeout=10,
        read_timeout=SQL_QUERY_TIMEOUT_SECS,
        write_timeout=10,
        charset="utf8mb4",
        autocommit=False,
        cursorclass=pymysql.cursors.Cursor,
    )


def _parse_table_ref(table_name: str, schema: str | None = None) -> tuple[str | None, str]:
    table_ref = table_name.strip()
    if not table_ref:
        raise ValueError("Empty table name")
    if "." in table_ref:
        schema_from_ref, table = table_ref.split(".", 1)
        schema = schema or schema_from_ref
    else:
        table = table_ref
    table = table.strip()
    schema = schema.strip() if schema else None
    if not table:
        raise ValueError("Empty table name")
    return schema, table


def _table_label(schema: str | None, table: str) -> str:
    return f"{schema}.{table}" if schema else table


def list_postgres_tables() -> str:
    query = """
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name;
    """
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(query)
                rows = cur.fetchall()
    except Exception as exc:
        return f"Error: {exc}"
    return dump_json({"dialect": "postgres", "tables": [{"schema": s, "table": t} for s, t in rows]})


def describe_postgres_table(table_name: str, schema: str | None = None) -> str:
    try:
        schema_name, table = _parse_table_ref(table_name, schema)
    except ValueError as exc:
        return f"Error: {exc}"
    base_sql = pg_sql.SQL(
        """
        SELECT
            c.table_schema,
            c.table_name,
            c.column_name,
            c.data_type,
            c.is_nullable,
            COALESCE(c.column_default, ''),
            c.ordinal_position,
            CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'YES' ELSE 'NO' END AS is_primary_key
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
            ON c.table_schema = kcu.table_schema
           AND c.table_name = kcu.table_name
           AND c.column_name = kcu.column_name
        LEFT JOIN information_schema.table_constraints tc
            ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
           AND kcu.table_name = tc.table_name
           AND tc.constraint_type = 'PRIMARY KEY'
        WHERE c.table_name = {table_lit}
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        {schema_filter}
        ORDER BY c.ordinal_position;
        """
    )
    if schema_name:
        query = base_sql.format(
            table_lit=pg_sql.Literal(table),
            schema_filter=pg_sql.SQL("AND c.table_schema = {}").format(pg_sql.Literal(schema_name)),
        )
    else:
        query = base_sql.format(table_lit=pg_sql.Literal(table), schema_filter=pg_sql.SQL(""))
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(query)
                rows = cur.fetchall()
    except Exception as exc:
        return f"Error: {exc}"
    if not rows:
        return f"Error: table not found: {_table_label(schema_name, table)}"
    first = rows[0]
    result = {"dialect": "postgres", "schema": first[0], "table": first[1], "columns": []}
    for row in rows:
        _, _, column_name, data_type, nullable, default, ordinal_position, is_primary_key = row
        result["columns"].append(
            {
                "name": column_name,
                "type": data_type,
                "nullable": nullable == "YES",
                "default": default or None,
                "ordinal_position": int(ordinal_position),
                "primary_key": is_primary_key == "YES",
            }
        )
    return dump_json(result)


def sample_postgres_rows(table_name: str, schema: str | None = None, limit: int = 15) -> str:
    try:
        schema_name, table = _parse_table_ref(table_name, schema)
        limit_value = int(limit)
    except Exception as exc:
        return f"Error: {exc}"
    if limit_value <= 0:
        return "Error: limit must be positive"
    identifier = pg_sql.Identifier(schema_name, table) if schema_name else pg_sql.Identifier(table)
    query = pg_sql.SQL("SELECT * FROM {} LIMIT %s").format(identifier)
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (limit_value,))
                columns = [desc[0] for desc in cur.description] if cur.description else []
                rows = cur.fetchall() if cur.description else []
    except Exception as exc:
        return f"Error: {exc}"
    return dump_json(
        {
            "dialect": "postgres",
            "query": f"SELECT * FROM {_table_label(schema_name, table)} LIMIT {limit_value}",
            "row_count": len(rows),
            "rows": [dict(zip(columns, row)) for row in rows],
        }
    )

def run_postgres_readonly(sql_text: str) -> str:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return query
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(_postgres_timeout_sql())
                cur.execute(query)
                columns = [desc[0] for desc in cur.description] if cur.description else []
                rows = cur.fetchall() if cur.description else []
    except Exception as exc:
        if _is_postgres_timeout_error(exc):
            return f"Error: query timed out after {SQL_QUERY_TIMEOUT_SECS}s"
        return f"Error: {exc}"
    return dump_json(
        {
            "dialect": "postgres",
            "query": query,
            "row_count": len(rows),
            "rows": [dict(zip(columns, row)) for row in rows],
        }
    )


_DDL_LEADING_RE = re.compile(
    r"^\s*(create|alter|drop|truncate|grant|revoke|comment|reindex|vacuum|analyze|refresh)\b",
    re.IGNORECASE,
)


def validate_postgres_query(sql_text: str) -> str:
    """Validate a PostgreSQL statement before it is finalized.

    Runs ``EXPLAIN`` against the live database, which parses and plans the query
    -- resolving every table/column/type against the real schema -- WITHOUT
    executing it or returning rows. This catches name-resolution mistakes (e.g.
    a double-quoted ``"SiteTie"`` when the real column is lowercase ``sitetie``)
    that a syntax-only parser cannot. DDL/maintenance statements are not
    EXPLAIN-able, so they fall back to a syntax-only check.
    """
    clean_sql = sql_text.replace("```sql", "").replace("```", "").strip().rstrip(";").strip()
    if not clean_sql:
        return dump_json(
            {
                "ok": False,
                "error": "Empty SQL query",
                "next_action": "Provide a non-empty SQL query and validate again.",
            }
        )
    # DDL/maintenance can't be EXPLAIN-ed; only check syntax (best effort).
    if _DDL_LEADING_RE.match(clean_sql):
        if sqlglot is not None:
            try:
                sqlglot.parse_one(clean_sql, read="postgres")
            except Exception as exc:
                return dump_json(
                    {
                        "ok": False,
                        "stage": "syntax",
                        "error": str(exc),
                        "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
                    }
                )
        return dump_json(
            {
                "ok": True,
                "normalized_sql": clean_sql,
                "note": "Syntax checked only; DDL/maintenance statements cannot be semantically validated against the schema.",
            }
        )
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(_postgres_timeout_sql())
                cur.execute(f"EXPLAIN {clean_sql}")
    except Exception as exc:
        if _is_postgres_timeout_error(exc):
            return dump_json(
                {
                    "ok": False,
                    "stage": "schema",
                    "error": f"query timed out after {SQL_QUERY_TIMEOUT_SECS}s",
                    "next_action": "Simplify the query and validate again.",
                }
            )
        return dump_json(
            {
                "ok": False,
                "stage": "schema",
                "error": str(exc),
                "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
            }
        )
    return dump_json({"ok": True, "normalized_sql": clean_sql})


def explain_postgres_query(sql_text: str) -> str:
    ok, query = _validate_readonly_sql(sql_text)
    if not ok:
        return query
    if not re.match(r"^(select|with)\b", query, re.IGNORECASE):
        return "Error: Only SELECT/WITH queries can be explained"
    explain_sql = f"EXPLAIN (FORMAT JSON) {query}"
    try:
        with connect_postgres() as conn:
            with conn.cursor() as cur:
                cur.execute(_postgres_timeout_sql())
                cur.execute(explain_sql)
                plan = cur.fetchone()[0]
    except Exception as exc:
        if _is_postgres_timeout_error(exc):
            return f"Error: query timed out after {SQL_QUERY_TIMEOUT_SECS}s"
        return f"Error: {exc}"
    return dump_json({"dialect": "postgres", "query": query, "plan": plan})


def _mysql_identifier(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def _mysql_qualified_table(table_name: str, schema: str | None = None) -> str:
    schema_name, table = _parse_table_ref(table_name, schema)
    if schema_name:
        return f"{_mysql_identifier(schema_name)}.{_mysql_identifier(table)}"
    return _mysql_identifier(table)


def _set_mysql_timeout(cur) -> None:
    try:
        cur.execute(f"SET SESSION MAX_EXECUTION_TIME={SQL_QUERY_TIMEOUT_SECS * 1000}")
    except Exception:
        pass


def list_mysql_tables() -> str:
    query = """
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema = DATABASE()
    ORDER BY table_schema, table_name
    """
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute(query)
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        return f"Error: {exc}"
    return dump_json({"dialect": "mysql", "tables": [{"schema": s, "table": t} for s, t in rows]})


def describe_mysql_table(table_name: str, schema: str | None = None) -> str:
    try:
        schema_name, table = _parse_table_ref(table_name, schema)
    except ValueError as exc:
        return f"Error: {exc}"
    schema_filter = "AND c.table_schema = %s" if schema_name else "AND c.table_schema = DATABASE()"
    params = [table]
    if schema_name:
        params.append(schema_name)
    query = f"""
    SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.column_type,
        c.is_nullable,
        COALESCE(c.column_default, ''),
        c.ordinal_position,
        CASE WHEN c.column_key = 'PRI' THEN 'YES' ELSE 'NO' END AS is_primary_key
    FROM information_schema.columns c
    WHERE c.table_name = %s
      {schema_filter}
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
    """
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute(query, params)
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        return f"Error: {exc}"
    if not rows:
        return f"Error: table not found: {_table_label(schema_name, table)}"
    first = rows[0]
    result = {"dialect": "mysql", "schema": first[0], "table": first[1], "columns": []}
    for row in rows:
        _, _, column_name, data_type, nullable, default, ordinal_position, is_primary_key = row
        result["columns"].append(
            {
                "name": column_name,
                "type": data_type,
                "nullable": nullable == "YES",
                "default": default or None,
                "ordinal_position": int(ordinal_position),
                "primary_key": is_primary_key == "YES",
            }
        )
    return dump_json(result)


def sample_mysql_rows(table_name: str, schema: str | None = None, limit: int = 15) -> str:
    try:
        limit_value = int(limit)
        quoted_table = _mysql_qualified_table(table_name, schema)
    except Exception as exc:
        return f"Error: {exc}"
    if limit_value <= 0:
        return "Error: limit must be positive"
    query = f"SELECT * FROM {quoted_table} LIMIT %s"
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute("START TRANSACTION READ ONLY")
                try:
                    cur.execute(query, (limit_value,))
                    columns = [desc[0] for desc in cur.description] if cur.description else []
                    rows = cur.fetchall() if cur.description else []
                finally:
                    conn.rollback()
        finally:
            conn.close()
    except Exception as exc:
        return f"Error: {exc}"
    return dump_json(
        {
            "dialect": "mysql",
            "query": f"SELECT * FROM {_table_label(schema, table_name)} LIMIT {limit_value}",
            "row_count": len(rows),
            "rows": [dict(zip(columns, row)) for row in rows],
        }
    )


def run_mysql_readonly(sql_text: str) -> str:
    ok, query = _validate_select_like_sql(sql_text)
    if not ok:
        return query
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute("START TRANSACTION READ ONLY")
                try:
                    cur.execute(query)
                    columns = [desc[0] for desc in cur.description] if cur.description else []
                    rows = cur.fetchall() if cur.description else []
                finally:
                    conn.rollback()
        finally:
            conn.close()
    except Exception as exc:
        if _is_mysql_timeout_error(exc):
            return f"Error: query timed out after {SQL_QUERY_TIMEOUT_SECS}s"
        return f"Error: {exc}"
    return dump_json(
        {
            "dialect": "mysql",
            "query": query,
            "row_count": len(rows),
            "rows": [dict(zip(columns, row)) for row in rows],
        }
    )


def validate_mysql_query(sql_text: str) -> str:
    clean_sql = sql_text.replace("```sql", "").replace("```", "").strip().rstrip(";").strip()
    if not clean_sql:
        return dump_json(
            {
                "ok": False,
                "error": "Empty SQL query",
                "next_action": "Provide a non-empty SQL query and validate again.",
            }
        )
    if not re.match(r"^(select|with|explain|show)\b", clean_sql, re.IGNORECASE):
        return dump_json(
            {
                "ok": False,
                "error": "Only SELECT, WITH, EXPLAIN, or SHOW queries are allowed.",
                "next_action": "Revise the SQL to be read-only and validate again.",
            }
        )
    if sqlglot is not None:
        try:
            sqlglot.parse_one(clean_sql, read="mysql")
        except Exception as exc:
            return dump_json(
                {
                    "ok": False,
                    "stage": "syntax",
                    "error": str(exc),
                    "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
                }
            )
    semantic_sql = clean_sql if clean_sql.lower().startswith("explain") else f"EXPLAIN {clean_sql}"
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute(semantic_sql)
                cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        if _is_mysql_timeout_error(exc):
            error = f"query timed out after {SQL_QUERY_TIMEOUT_SECS}s"
        else:
            error = str(exc)
        return dump_json(
            {
                "ok": False,
                "stage": "schema",
                "error": error,
                "next_action": "Revise the SQL and validate again. Only return the query after validation returns ok=true.",
            }
        )
    return dump_json({"ok": True, "normalized_sql": clean_sql})


def explain_mysql_query(sql_text: str) -> str:
    ok, query = _validate_select_like_sql(sql_text)
    if not ok:
        return query
    if not re.match(r"^(select|with)\b", query, re.IGNORECASE):
        return "Error: Only SELECT/WITH queries can be explained"
    try:
        conn = connect_mysql()
        try:
            with conn.cursor() as cur:
                _set_mysql_timeout(cur)
                cur.execute(f"EXPLAIN {query}")
                columns = [desc[0] for desc in cur.description] if cur.description else []
                rows = cur.fetchall() if cur.description else []
        finally:
            conn.close()
    except Exception as exc:
        if _is_mysql_timeout_error(exc):
            return f"Error: query timed out after {SQL_QUERY_TIMEOUT_SECS}s"
        return f"Error: {exc}"
    return dump_json({"dialect": "mysql", "query": query, "plan": [dict(zip(columns, row)) for row in rows]})


def build_llm_tools(
    db_type: DBType,
    extra_tools: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    sqlite_tools = [
        {
            "type": "function",
            "function": {
                "name": "list_sqlite_tables",
                "description": "List SQLite tables in the connected database.",
                "parameters": {
                    "type": "object",
                    "properties": {"db_path": {"type": "string", "description": "Path to the SQLite database file."}},
                    "required": ["db_path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "sample_sqlite_rows",
                "description": "Return a small sample of rows from a SQLite table.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {"type": "string", "description": "Path to the SQLite database file."},
                        "table_name": {"type": "string", "description": "Table name."},
                        "limit": {"type": "integer", "description": "Maximum number of rows to return. Defaults to 15."},
                    },
                    "required": ["db_path", "table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_sqlite_readonly",
                "description": "Execute a read-only SQL query against SQLite.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {"type": "string", "description": "Path to the SQLite database file."},
                        "sql": {"type": "string", "description": "The read-only SQL statement to execute."},
                    },
                    "required": ["db_path", "sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "explain_sqlite_query",
                "description": "Explain a SQLite query plan for a read-only query.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {"type": "string", "description": "Path to the SQLite database file."},
                        "sql": {"type": "string", "description": "The SQL query to explain."},
                    },
                    "required": ["db_path", "sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "validate_sqlite_query",
                "description": "Validate a SQLite SQL query before finalizing it.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL query to validate."}},
                    "required": ["sql"],
                },
            },
        },
    ]
    duckdb_tools = [
        {
            "type": "function",
            "function": {
                "name": "list_duckdb_tables",
                "description": "List DuckDB tables in the connected database.",
                "parameters": {
                    "type": "object",
                    "properties": {"db_path": {"type": "string", "description": "Path to the DuckDB database file."}},
                    "required": ["db_path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "sample_duckdb_rows",
                "description": "Return a small sample of rows from a DuckDB table.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {"type": "string", "description": "Path to the DuckDB database file."},
                        "table_name": {"type": "string", "description": "Table name."},
                        "limit": {"type": "integer", "description": "Maximum number of rows to return. Defaults to 15."},
                    },
                    "required": ["db_path", "table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_duckdb_readonly",
                "description": "Execute a read-only SQL query against DuckDB.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "db_path": {"type": "string", "description": "Path to the DuckDB database file."},
                        "sql": {"type": "string", "description": "The read-only SQL statement to execute."},
                    },
                    "required": ["db_path", "sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "validate_duckdb_query",
                "description": "Validate a DuckDB SQL query before finalizing it.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL query to validate."}},
                    "required": ["sql"],
                },
            },
        },
    ]
    postgres_tools = [
        {
            "type": "function",
            "function": {
                "name": "list_postgres_tables",
                "description": "List Postgres tables in the connected database.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "describe_postgres_table",
                "description": "Describe a PostgreSQL table's columns and keys.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {"type": "string", "description": "Table name, optionally schema-qualified."},
                        "schema": {"type": "string", "description": "Optional schema name."},
                    },
                    "required": ["table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "sample_postgres_rows",
                "description": "Return a small sample of rows from a PostgreSQL table.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {"type": "string", "description": "Table name, optionally schema-qualified."},
                        "schema": {"type": "string", "description": "Optional schema name."},
                        "limit": {"type": "integer", "description": "Maximum rows to return. Defaults to 15."},
                    },
                    "required": ["table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_postgres_readonly",
                "description": "Execute a read-only SQL query against PostgreSQL.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL statement to execute."}},
                    "required": ["sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "explain_postgres_query",
                "description": "Explain a PostgreSQL query plan for a read-only query.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL query to explain."}},
                    "required": ["sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "validate_postgres_query",
                "description": (
                    "Validate a PostgreSQL query against the live schema before finalizing it. "
                    "Resolves all table/column/type references (catches errors like quoting a "
                    "mixed-case identifier that is actually stored lowercase) without executing it."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL statement to validate."}},
                    "required": ["sql"],
                },
            },
        },
    ]
    mysql_tools = [
        {
            "type": "function",
            "function": {
                "name": "list_mysql_tables",
                "description": "List MySQL tables in the connected database.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "describe_mysql_table",
                "description": "Describe a MySQL table's columns and keys.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {"type": "string", "description": "Table name, optionally schema-qualified."},
                        "schema": {"type": "string", "description": "Optional schema name."},
                    },
                    "required": ["table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "sample_mysql_rows",
                "description": "Return a small sample of rows from a MySQL table.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {"type": "string", "description": "Table name, optionally schema-qualified."},
                        "schema": {"type": "string", "description": "Optional schema name."},
                        "limit": {"type": "integer", "description": "Maximum rows to return. Defaults to 15."},
                    },
                    "required": ["table_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_mysql_readonly",
                "description": "Execute a read-only SQL query against MySQL.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL statement to execute."}},
                    "required": ["sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "explain_mysql_query",
                "description": "Explain a MySQL query plan for a read-only query.",
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL query to explain."}},
                    "required": ["sql"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "validate_mysql_query",
                "description": (
                    "Validate a MySQL query against the live schema before finalizing it. "
                    "Checks syntax and uses EXPLAIN to resolve table/column references without executing the query."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "The SQL statement to validate."}},
                    "required": ["sql"],
                },
            },
        },
    ]
    tools_by_type = {
        DBType.SQLITE: sqlite_tools,
        DBType.DUCKDB: duckdb_tools,
        DBType.POSTGRES: postgres_tools,
        DBType.MYSQL: mysql_tools,
    }
    tools = list(tools_by_type[db_type])
    if extra_tools:
        tools = tools + extra_tools
    return tools


def build_tool_handler_map():
    return {
        # SQLite tools
        "list_sqlite_tables": lambda **kw: list_sqlite_tables(kw["db_path"]),
        "sample_sqlite_rows": lambda **kw: sample_sqlite_rows(kw["db_path"], kw["table_name"], kw.get("limit", 15)),
        "run_sqlite_readonly": lambda **kw: run_sqlite_readonly(kw["db_path"], kw["sql"]),
        "explain_sqlite_query": lambda **kw: explain_sqlite_query(kw["db_path"], kw["sql"]),
        "validate_sqlite_query": lambda **kw: validate_sqlite_query(kw["sql"]),
        # DuckDB tools
        "list_duckdb_tables": lambda **kw: list_duckdb_tables(kw["db_path"]),
        "sample_duckdb_rows": lambda **kw: sample_duckdb_rows(kw["db_path"], kw["table_name"], kw.get("limit", 15)),
        "run_duckdb_readonly": lambda **kw: run_duckdb_readonly(kw["db_path"], kw["sql"]),
        "validate_duckdb_query": lambda **kw: validate_duckdb_query(kw["sql"]),
        # Postgres tools
        "list_postgres_tables": lambda **_: list_postgres_tables(),
        "describe_postgres_table": lambda **kw: describe_postgres_table(kw["table_name"], kw.get("schema")),
        "sample_postgres_rows": lambda **kw: sample_postgres_rows(kw["table_name"], kw.get("schema"), kw.get("limit", 15)),
        "run_postgres_readonly": lambda **kw: run_postgres_readonly(kw["sql"]),
        "explain_postgres_query": lambda **kw: explain_postgres_query(kw["sql"]),
        "validate_postgres_query": lambda **kw: validate_postgres_query(kw["sql"]),
        # MySQL tools
        "list_mysql_tables": lambda **_: list_mysql_tables(),
        "describe_mysql_table": lambda **kw: describe_mysql_table(kw["table_name"], kw.get("schema")),
        "sample_mysql_rows": lambda **kw: sample_mysql_rows(kw["table_name"], kw.get("schema"), kw.get("limit", 15)),
        "run_mysql_readonly": lambda **kw: run_mysql_readonly(kw["sql"]),
        "explain_mysql_query": lambda **kw: explain_mysql_query(kw["sql"]),
        "validate_mysql_query": lambda **kw: validate_mysql_query(kw["sql"]),
    }
