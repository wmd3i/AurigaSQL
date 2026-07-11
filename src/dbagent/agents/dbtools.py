from __future__ import annotations

import json
import os
import re
import shlex
import sqlite3
import subprocess
import time
from enum import Enum
from pathlib import Path
from typing import Any

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


POSTGRES_DSN_ENV = "POSTGRES_DSN"
MAX_OUTPUT_CHARS = 100000
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
SQL_QUERY_TIMEOUT_SECS = 60
DBT_TIMEOUT_SECS = 300
DBT_STDOUT_TAIL_CHARS = 4000
READONLY_ROW_LIMIT = 100
READONLY_CELL_CHARS = 200
DBT_NODE_SUCCESS_LIMIT = 20
DBT_ARTIFACT_HINT_LIMIT = 8
DBT_ARTIFACT_SUFFIXES = (".duckdb", ".csv", ".parquet", ".json", ".db")

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


def _ensure_db_file(db_path: str) -> Path | None:
    path = Path(db_path)
    return path if path.is_file() else None


def _nice_table(column_names: list[str], values: list[tuple]) -> str:
    lines = ["|".join(column_names)]
    lines.extend("|".join(str(value) for value in row) for row in values)
    return "\n".join(lines)


def _truncate_preview_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    if len(text) <= READONLY_CELL_CHARS:
        return text
    return text[:READONLY_CELL_CHARS] + "...[truncated]"


def _format_readonly_rows(columns: list[str], rows: list[tuple]) -> list[dict[str, Any]]:
    return [
        {column: _truncate_preview_value(value) for column, value in zip(columns, row)}
        for row in rows
    ]


def _readonly_payload(dialect: str, query: str, columns: list[str], rows: list[tuple], truncated: bool) -> str:
    payload: dict[str, Any] = {
        "dialect": dialect,
        "query": query,
        "columns": columns,
        "returned_rows": len(rows),
        "row_count": None if truncated else len(rows),
        "truncated": truncated,
        "rows": _format_readonly_rows(columns, rows),
    }
    if truncated:
        payload["limit"] = READONLY_ROW_LIMIT
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
            rows = conn.execute(query).fetchmany(READONLY_ROW_LIMIT + 1)
            columns = [description[0] for description in conn.description] if conn.description else []
        truncated = len(rows) > READONLY_ROW_LIMIT
        if truncated:
            rows = rows[:READONLY_ROW_LIMIT]
        return _readonly_payload("duckdb", query, columns, rows, truncated)
    except Exception as exc:
        return f"Error executing DuckDB SQL: {exc}"


def run_bash(command: str, workdir: Path) -> str:
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(item in command for item in dangerous):
        return "Error: Dangerous command blocked"
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "Error: Timeout (120s)"

    output = _ANSI_ESCAPE.sub("", (result.stdout + result.stderr)).strip()
    return output[:MAX_OUTPUT_CHARS] if output else "(no output)"

def _dbt_node_summary(
    workdir: Path,
    previous_mtimes: dict[Path, float] | None = None,
) -> tuple[list[dict[str, Any]] | None, Path | None, float | None]:
    """Parse a fresh target/run_results.json into a compact per-node status list.

    Returns ``(nodes, path, mtime)``. When ``previous_mtimes`` is provided, only
    files that are new or have a newer mtime than the pre-run snapshot count as
    current for this invocation.
    """
    candidates: list[tuple[Path, float]] = []
    for path in workdir.rglob("target/run_results.json"):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        previous_mtime = previous_mtimes.get(path) if previous_mtimes is not None else None
        if previous_mtimes is not None and previous_mtime is not None and mtime <= previous_mtime:
            continue
        candidates.append((path, mtime))
    candidates.sort(key=lambda item: item[1], reverse=True)
    if not candidates:
        return None, None, None
    path, mtime = candidates[0]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None, path, mtime
    nodes: list[dict[str, Any]] = []
    for r in data.get("results", []):
        unique_id = r.get("unique_id") or ""
        node: dict[str, Any] = {
            "name": unique_id.split(".")[-1] or unique_id,
            "status": r.get("status"),
        }
        message = r.get("message")
        if message:
            node["message"] = str(message)[:300]
        adapter = r.get("adapter_response") or {}
        if adapter.get("rows_affected") is not None:
            node["rows"] = adapter["rows_affected"]
        nodes.append(node)
    return nodes, path, mtime


def _dbt_status_counts(nodes: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for node in nodes:
        status = str(node.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return dict(sorted(counts.items()))


def _dbt_sort_and_cap_nodes(nodes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    failing_statuses = {"error", "fail", "failed"}
    failing_nodes = [node for node in nodes if str(node.get("status") or "").lower() in failing_statuses]
    other_nodes = [node for node in nodes if str(node.get("status") or "").lower() not in failing_statuses]
    ordered_nodes = failing_nodes + other_nodes[:DBT_NODE_SUCCESS_LIMIT]
    truncated = len(ordered_nodes) < len(nodes)
    return ordered_nodes, truncated


def _collect_recent_artifact_hints(workdir: Path, start_time: float) -> list[str]:
    hints: list[tuple[float, Path]] = []
    for path in workdir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in DBT_ARTIFACT_SUFFIXES:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime < start_time:
            continue
        hints.append((mtime, path))
    hints.sort(key=lambda item: item[0], reverse=True)
    return [str(path.relative_to(workdir)) for _, path in hints[:DBT_ARTIFACT_HINT_LIMIT]]


def run_dbt(args: str, workdir: Path) -> str:
    """Run a dbt command from the workspace root and return a compact summary:
    per-node status/error from run_results.json plus the tail of stdout. Color is
    disabled at the source (DBT_USE_COLORS/NO_COLOR) so no ANSI noise enters history."""
    args = (args or "").strip()
    if not args:
        return "Error: provide dbt arguments, e.g. 'run', 'build', 'test', or 'run --select my_model'"
    try:
        argv = ["dbt", *shlex.split(args)]
    except ValueError as exc:
        return f"Error: invalid dbt arguments: {exc}"
    env = {**os.environ, "DBT_USE_COLORS": "False", "NO_COLOR": "1"}
    before_run_results: dict[Path, float] = {}
    for path in workdir.rglob("target/run_results.json"):
        try:
            before_run_results[path] = path.stat().st_mtime
        except OSError:
            continue
    started_at = time.time()
    started_monotonic = time.monotonic()
    try:
        result = subprocess.run(
            argv,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=DBT_TIMEOUT_SECS,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return f"Error: dbt timed out after {DBT_TIMEOUT_SECS}s"
    except FileNotFoundError:
        return "Error: dbt is not installed or not on PATH"
    elapsed_seconds = round(time.monotonic() - started_monotonic, 3)

    stdout = _ANSI_ESCAPE.sub("", (result.stdout + result.stderr)).strip()
    summary: dict[str, Any] = {
        "command": " ".join(shlex.quote(part) for part in argv),
        "returncode": result.returncode,
        "ok": result.returncode == 0,
        "elapsed_seconds": elapsed_seconds,
    }
    nodes, run_results_path, run_results_mtime = _dbt_node_summary(workdir, previous_mtimes=before_run_results)
    if nodes is not None:
        summary["node_counts"] = _dbt_status_counts(nodes)
        summary["used_fresh_run_results"] = True
        summary["nodes"], summary["truncated_nodes"] = _dbt_sort_and_cap_nodes(nodes)
    else:
        summary["used_fresh_run_results"] = False
    if run_results_path is not None:
        summary["run_results_path"] = str(run_results_path.relative_to(workdir))
    if run_results_mtime is not None:
        summary["run_results_mtime"] = run_results_mtime
    artifact_hints = _collect_recent_artifact_hints(workdir, start_time=started_at)
    if artifact_hints:
        summary["artifact_hints"] = artifact_hints
    tail = stdout[-DBT_STDOUT_TAIL_CHARS:]
    if len(stdout) > DBT_STDOUT_TAIL_CHARS:
        tail = "...[truncated]...\n" + tail
    summary["stdout_tail"] = tail
    return dump_json(summary)


def connect_postgres():
    if psycopg is None:
        raise RuntimeError("psycopg is not installed; postgres tools are unavailable")
    dsn = os.getenv(POSTGRES_DSN_ENV)
    if not dsn:
        raise RuntimeError(f"missing env var {POSTGRES_DSN_ENV}")
    return psycopg.connect(dsn)


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

# TODO: add regex re.match(r"^(select|show|explain)\b", query, re.IGNORECASE)
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


def build_llm_tools(
    db_type: DBType,
    yolo: bool,
    extra_tools: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    # TODO: LLM can change the work directory?
    shared_tools = [
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run a shell command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "The shell command to execute."}
                    },
                    "required": ["command"],
                },
            },
        }
    ]
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
        {
                "type": "function",
                "function": {
                    "name": "run_dbt",
                    "description": (
                        "Run a dbt command from the workspace root (e.g. 'run', 'build', 'test', "
                        "'compile', 'run --select my_model'). Returns a compact summary: per-node "
                        "status and error messages from run_results.json, plus the tail of stdout. "
                        "Prefer this over invoking dbt through bash."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "args": {
                                "type": "string",
                                "description": "Arguments passed to dbt, without the leading 'dbt' (e.g. 'build' or 'run --select my_model').",
                            }
                        },
                        "required": ["args"],
                    },
                },
        }
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
    tools_by_type = {
        DBType.SQLITE: sqlite_tools,
        DBType.DUCKDB: duckdb_tools,
        DBType.POSTGRES: postgres_tools,
    }
    tools = shared_tools + tools_by_type[db_type]
    if extra_tools:
        tools = tools + extra_tools
    if not yolo:
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": "ask_user",
                    "description": "Ask the user a clarifying question when more information is needed.",
                    "parameters": {
                        "type": "object",
                        "properties": {"question": {"type": "string", "description": "The clarifying question."}},
                        "required": ["question"],
                    },
                },
            }
        )
    return tools


def build_tool_handler_map(workdir: Path):
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
        "run_dbt": lambda **kw: run_dbt(kw["args"], workdir=workdir),
        # Postgres tools
        "list_postgres_tables": lambda **_: list_postgres_tables(),
        "describe_postgres_table": lambda **kw: describe_postgres_table(kw["table_name"], kw.get("schema")),
        "sample_postgres_rows": lambda **kw: sample_postgres_rows(kw["table_name"], kw.get("schema"), kw.get("limit", 15)),
        "run_postgres_readonly": lambda **kw: run_postgres_readonly(kw["sql"]),
        "explain_postgres_query": lambda **kw: explain_postgres_query(kw["sql"]),
        "validate_postgres_query": lambda **kw: validate_postgres_query(kw["sql"]),
        # Shared tools
        "bash": lambda **kw: run_bash(kw["command"], workdir=workdir),
        # Clarification tool
        "ask_user": lambda **kw: "Error: ask_user is disabled in this non-interactive run.",
    }
