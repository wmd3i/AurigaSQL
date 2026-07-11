from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from func_timeout import FunctionTimedOut, func_timeout

try:
    import sqlglot
except Exception:
    sqlglot = None

from dbagent.benchmarks.base import EvaluationRecord, TaskSpec

# Matches the official BIRD evaluator's default meta_time_out.
EXEC_TIMEOUT_SECONDS = 30.0


def _normalize_sql(sql_text: str) -> str:
    clean = sql_text.replace("```sql", "").replace("```", "").strip().rstrip(";")
    if not clean:
        return ""
    if sqlglot is None:
        return clean
    try:
        ast = sqlglot.parse_one(clean, read="sqlite")
        return ast.sql(dialect="sqlite")
    except Exception:
        return clean


def _results_match(predicted_rows: Any, gold_rows: Any) -> bool:
    """BIRD execution accuracy: rows match as an unordered set.

    Mirrors the official evaluator (``set(predicted_res) == set(ground_truth_res)``)
    so results are compared independent of row order. Falls back to a sorted
    comparison if a row contains an unhashable value.
    """
    try:
        return set(predicted_rows) == set(gold_rows)
    except TypeError:
        return sorted(map(repr, predicted_rows)) == sorted(map(repr, gold_rows))


def _execute_sql(db_path: Path, sql_text: str, timeout: float = EXEC_TIMEOUT_SECONDS) -> tuple[bool, Any]:
    def _run() -> tuple[bool, Any]:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            cursor = conn.cursor()
            cursor.execute(sql_text)
            return True, cursor.fetchall()
        finally:
            conn.close()

    try:
        return func_timeout(timeout, _run)
    except FunctionTimedOut:
        return False, f"timeout after {timeout}s"
    except Exception as exc:
        return False, str(exc)
