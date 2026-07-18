from __future__ import annotations

import argparse
import datetime as dt
import decimal
import json
import os
import shutil
import sqlite3
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2 import sql


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = Path(__file__).with_name("demo_datasets.json")
DEFAULT_OUTPUT = REPO_ROOT / "datasets" / "demo"
BIRD_ROOT = REPO_ROOT / "datasets" / "bird_dev" / "dev_databases"
BIRD_INTERACT_ROOT = REPO_ROOT / "datasets" / "bird-interact-lite"


def _quote_sqlite(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _sqlite_type(data_type: str, udt_name: str) -> str:
    normalized = data_type.lower()
    if normalized in {"smallint", "integer", "bigint", "boolean"}:
        return "INTEGER"
    if normalized in {"real", "double precision"}:
        return "REAL"
    if normalized in {"numeric", "decimal"}:
        return "NUMERIC"
    if normalized in {"bytea"}:
        return "BLOB"
    if normalized in {"date", "timestamp without time zone", "timestamp with time zone", "time without time zone"}:
        return "TEXT"
    if normalized in {"array", "json", "jsonb"} or udt_name.startswith("_"):
        return "TEXT"
    return "TEXT"


def _sqlite_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bytes)):
        return value
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.date, dt.time, dt.datetime)):
        return value.isoformat(sep=" ") if isinstance(value, dt.datetime) else value.isoformat()
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def _postgres_tables(cursor: Any) -> list[str]:
    cursor.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """
    )
    return [row[0] for row in cursor.fetchall()]


def _postgres_columns(cursor: Any, table: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        SELECT column_name, data_type, udt_name, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table,),
    )
    return [
        {
            "name": row[0],
            "data_type": row[1],
            "udt_name": row[2],
            "nullable": row[3] == "YES",
            "position": row[4],
        }
        for row in cursor.fetchall()
    ]


def _postgres_primary_key(cursor: Any, table: str) -> list[str]:
    cursor.execute(
        """
        SELECT attribute.attname
        FROM pg_index index_info
        JOIN pg_class table_info ON table_info.oid = index_info.indrelid
        JOIN pg_namespace namespace_info ON namespace_info.oid = table_info.relnamespace
        JOIN unnest(index_info.indkey) WITH ORDINALITY AS key_info(attnum, ordinality) ON TRUE
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_info.oid AND attribute.attnum = key_info.attnum
        WHERE namespace_info.nspname = 'public'
          AND table_info.relname = %s
          AND index_info.indisprimary
        ORDER BY key_info.ordinality
        """,
        (table,),
    )
    return [row[0] for row in cursor.fetchall()]


def _create_sqlite_table(
    connection: sqlite3.Connection,
    table: str,
    columns: list[dict[str, Any]],
    primary_key: list[str],
) -> None:
    definitions = []
    for column in columns:
        definition = f"{_quote_sqlite(column['name'])} {_sqlite_type(column['data_type'], column['udt_name'])}"
        if not column["nullable"] and column["name"] not in primary_key:
            definition += " NOT NULL"
        definitions.append(definition)
    if primary_key:
        definitions.append("PRIMARY KEY (" + ", ".join(_quote_sqlite(name) for name in primary_key) + ")")
    statement = f"CREATE TABLE {_quote_sqlite(table)} ({', '.join(definitions)})"
    connection.execute(statement)


def _convert_postgres_database(database: str, destination: Path, pg: dict[str, Any]) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    source = psycopg2.connect(dbname=database, **pg)
    target = sqlite3.connect(temporary)
    table_report: list[dict[str, Any]] = []
    try:
        source.set_session(readonly=True, autocommit=True)
        with source.cursor() as cursor:
            for table in _postgres_tables(cursor):
                columns = _postgres_columns(cursor, table)
                primary_key = _postgres_primary_key(cursor, table)
                _create_sqlite_table(target, table, columns, primary_key)
                cursor.execute(sql.SQL("SELECT * FROM {}.{}").format(sql.Identifier("public"), sql.Identifier(table)))
                rows = cursor.fetchall()
                if rows:
                    placeholders = ", ".join("?" for _ in columns)
                    insert = f"INSERT INTO {_quote_sqlite(table)} VALUES ({placeholders})"
                    target.executemany(insert, [tuple(_sqlite_value(value) for value in row) for row in rows])
                sqlite_count = target.execute(f"SELECT COUNT(*) FROM {_quote_sqlite(table)}").fetchone()[0]
                if sqlite_count != len(rows):
                    raise RuntimeError(f"row-count mismatch for {database}.{table}: postgres={len(rows)} sqlite={sqlite_count}")
                table_report.append(
                    {
                        "table": table,
                        "columns": len(columns),
                        "rows": sqlite_count,
                        "primary_key": primary_key,
                    }
                )
        target.commit()
        integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed for {database}: {integrity}")
    except Exception:
        target.close()
        source.close()
        temporary.unlink(missing_ok=True)
        raise
    target.close()
    source.close()
    os.replace(temporary, destination)
    return {
        "database": database,
        "tables": table_report,
        "table_count": len(table_report),
        "row_count": sum(item["rows"] for item in table_report),
        "size_bytes": destination.stat().st_size,
    }


def _copy_bird_database(database: str, destination: Path) -> dict[str, Any]:
    source = BIRD_ROOT / database / f"{database}.sqlite"
    if not source.is_file():
        raise FileNotFoundError(f"BIRD database not found: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    with sqlite3.connect(f"file:{destination}?mode=ro", uri=True) as connection:
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        counts = {table: connection.execute(f"SELECT COUNT(*) FROM {_quote_sqlite(table)}").fetchone()[0] for table in tables}
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"SQLite integrity check failed for {database}: {integrity}")
    return {
        "database": database,
        "table_count": len(tables),
        "row_count": sum(counts.values()),
        "tables": [{"table": table, "rows": counts[table]} for table in tables],
        "size_bytes": destination.stat().st_size,
    }


def _copy_bird_interact_knowledge(
    database: str,
    sqlite_database: Path,
    destination: Path,
    output_root: Path,
) -> dict[str, str]:
    source = BIRD_INTERACT_ROOT / database
    destination.mkdir(parents=True, exist_ok=True)
    files = {
        "column_meanings_path": (
            source / f"{database}_column_meaning_base.json",
            destination / "column_meanings.json",
        ),
        "knowledge_path": (source / f"{database}_kb.jsonl", destination / "knowledge.jsonl"),
    }
    result: dict[str, str] = {}
    for key, (source_path, destination_path) in files.items():
        if not source_path.is_file():
            raise FileNotFoundError(f"BIRD-Interact knowledge file not found: {source_path}")
        shutil.copy2(source_path, destination_path)
        result[key] = str(destination_path.relative_to(output_root))
    with sqlite3.connect(f"file:{sqlite_database}?mode=ro", uri=True) as connection:
        statements = [
            row[0]
            for row in connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
            if row[0]
        ]
    schema_path = destination / "schema.txt"
    schema_path.write_text(";\n\n".join(statements) + ";\n", encoding="utf-8")
    result["schema_path"] = str(schema_path.relative_to(output_root))
    return result


def build(config_path: Path, output: Path, pg: dict[str, Any]) -> None:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    sources: list[dict[str, Any]] = []
    report: dict[str, Any] = {"version": config["version"], "bird": [], "bird_interact": []}

    for item in config["bird"]:
        database = item["id"]
        relative_path = Path("bird") / "databases" / f"{database}.sqlite"
        result = _copy_bird_database(database, output / relative_path)
        report["bird"].append(result)
        sources.append(
            {
                **item,
                "source_id": f"bird:{database}",
                "source_group": "bird",
                "engine": "sqlite",
                "database": database,
                "db_path": str(relative_path),
            }
        )

    for item in config["bird_interact"]:
        database = item["id"]
        relative_path = Path("bird_interact") / "databases" / f"{database}.sqlite"
        result = _convert_postgres_database(database, output / relative_path, pg)
        report["bird_interact"].append(result)
        knowledge = _copy_bird_interact_knowledge(
            database,
            output / relative_path,
            output / "bird_interact" / "knowledge" / database,
            output,
        )
        sources.append(
            {
                **item,
                **knowledge,
                "source_id": f"bird_interact_a:{database}",
                "source_group": "bird_interact_a",
                "engine": "sqlite",
                "database": database,
                "db_path": str(relative_path),
            }
        )

    manifest = {"version": config["version"], "sources": sources}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "demo_questions.json").write_text(
        json.dumps(config.get("demo_questions", []), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output / "build-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the bundled AurigaSQL demo dataset subset.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--pg-host", default=os.getenv("BIRD_INTERACT_PG_HOST", "127.0.0.1"))
    parser.add_argument("--pg-port", type=int, default=int(os.getenv("BIRD_INTERACT_PG_PORT", "5432")))
    parser.add_argument("--pg-user", default=os.getenv("BIRD_INTERACT_PG_USER", "root"))
    parser.add_argument("--pg-password", default=os.getenv("BIRD_INTERACT_PG_PASSWORD", "123123"))
    args = parser.parse_args()
    build(
        args.config.resolve(),
        args.output.resolve(),
        {
            "host": args.pg_host,
            "port": args.pg_port,
            "user": args.pg_user,
            "password": args.pg_password,
        },
    )


if __name__ == "__main__":
    main()
