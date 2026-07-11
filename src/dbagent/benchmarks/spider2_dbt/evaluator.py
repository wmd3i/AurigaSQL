from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import pandas as pd

try:
    import duckdb
except Exception as exc:
    duckdb = None
    _DUCKDB_IMPORT_ERROR = exc
else:
    _DUCKDB_IMPORT_ERROR = None


def string_match(pred: str, gold: str | list[str], conj: str = "or", exclude: list[str] | None = None) -> int:
    gold_values = gold if isinstance(gold, list) else [gold]
    exclude_values = exclude or []
    pred_lower = str(pred).lower()
    gold_lower = [str(value).lower() for value in gold_values]
    exclude_lower = [str(value).lower() for value in exclude_values]

    if any(value in pred_lower for value in exclude_lower):
        return 0
    if conj == "and":
        return 1 if all(value in pred_lower for value in gold_lower) else 0
    if conj == "or":
        return 1 if any(value in pred_lower for value in gold_lower) else 0
    raise ValueError(f"Invalid conj: {conj}")


def number_match(
    pred: str,
    gold: str | float | int | list[str | float | int],
    percentage: bool = False,
    precision: int = 4,
    conj: str = "or",
) -> int:
    pred_numbers = re.findall(r"\b\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?%?", str(pred))
    gold_values = gold if isinstance(gold, list) else [gold]

    if len(gold_values) == 1 and len(pred_numbers) != 1:
        return 0

    def to_float(value: str | float | int) -> float:
        text = str(value).replace(",", "")
        if text.endswith("%"):
            return float(text[:-1]) / 100
        return float(text)

    pred_values = [to_float(value) for value in pred_numbers]
    expected_values = [to_float(value) for value in gold_values]
    if percentage:
        expected_values = [value for expected in expected_values for value in (expected, expected * 100)]

    def matches(expected: float) -> bool:
        return any(abs(actual - expected) <= 10 ** (-precision) for actual in pred_values)

    if conj == "and":
        return 1 if all(matches(expected) for expected in expected_values) else 0
    if conj == "or":
        return 1 if any(matches(expected) for expected in expected_values) else 0
    raise ValueError(f"Invalid conj: {conj}")


def _vectors_match(left: list[Any], right: list[Any], *, ignore_order: bool, tolerance: float = 1e-2) -> bool:
    if ignore_order:
        sort_key = lambda value: (value is None, str(value), isinstance(value, (int, float)))
        left = sorted(left, key=sort_key)
        right = sorted(right, key=sort_key)
    if len(left) != len(right):
        return False
    for left_value, right_value in zip(left, right):
        # Nullable dtypes (Int64, boolean, ...) surface pd.NA, for which `!=`
        # returns pd.NA rather than a bool and raises in boolean context. Decide
        # null equality explicitly before any other comparison.
        left_na = bool(pd.isna(left_value))
        right_na = bool(pd.isna(right_value))
        if left_na or right_na:
            if left_na and right_na:
                continue
            return False
        if isinstance(left_value, (int, float)) and isinstance(right_value, (int, float)):
            if not math.isclose(float(left_value), float(right_value), abs_tol=tolerance):
                return False
        elif left_value != right_value:
            return False
    return True


def compare_pandas_table(
    pred: pd.DataFrame,
    gold: pd.DataFrame,
    condition_cols: list[int] | None = None,
    ignore_order: bool = False,
) -> int:
    gold_cols = gold.iloc[:, condition_cols] if condition_cols else gold
    pred_cols = pred
    gold_vectors = gold_cols.transpose().values.tolist()
    pred_vectors = pred_cols.transpose().values.tolist()
    for gold_vector in gold_vectors:
        if not any(_vectors_match(gold_vector, pred_vector, ignore_order=ignore_order) for pred_vector in pred_vectors):
            return 0
    return 1


def table_match(
    result: str | Path,
    gold: str | Path | list[str | Path],
    condition_cols: list[int] | list[list[int]] | None = None,
    ignore_order: bool = False,
) -> int:
    pred = pd.read_csv(result, low_memory=False)
    if isinstance(gold, list):
        for index, gold_path in enumerate(gold):
            cols = condition_cols[index] if condition_cols and condition_cols and isinstance(condition_cols[0], list) else condition_cols
            if compare_pandas_table(pred, pd.read_csv(gold_path, low_memory=False), cols or [], ignore_order):
                return 1
        return 0
    return compare_pandas_table(pred, pd.read_csv(gold, low_memory=False), condition_cols or [], ignore_order)


def _duckdb_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _duckdb_table_names(db_path: str | Path) -> list[str]:
    if duckdb is None:
        raise RuntimeError(f"duckdb is not installed: {_DUCKDB_IMPORT_ERROR}")
    with duckdb.connect(database=str(db_path), read_only=True) as conn:
        return [row[0] for row in conn.execute("SHOW TABLES").fetchall()]


def _duckdb_table(db_path: str | Path, table_name: str) -> pd.DataFrame:
    if duckdb is None:
        raise RuntimeError(f"duckdb is not installed: {_DUCKDB_IMPORT_ERROR}")
    with duckdb.connect(database=str(db_path), read_only=True) as conn:
        return conn.execute(f"SELECT * FROM {_duckdb_identifier(table_name)}").fetchdf()


def duckdb_match(
    result: str | Path,
    gold: str | Path,
    condition_tabs: list[str] | None = None,
    condition_cols: list[list[int]] | None = None,
    ignore_orders: list[bool] | None = None,
) -> int:
    tabs = condition_tabs or _duckdb_table_names(gold)
    cols = condition_cols or [[] for _ in tabs]
    ignores = ignore_orders or [False for _ in tabs]
    if len(cols) != len(tabs) or len(ignores) != len(tabs):
        raise ValueError("condition_cols and ignore_orders must match condition_tabs length")
    for index, table_name in enumerate(tabs):
        try:
            pred_table = _duckdb_table(result, table_name)
            gold_table = _duckdb_table(gold, table_name)
        except Exception:
            return 0
        if not compare_pandas_table(pred_table, gold_table, condition_cols=cols[index], ignore_order=ignores[index]):
            return 0
    return 1


def tables_match(
    result: list[str | Path],
    gold: list[str | Path],
    condition_cols: list[list[int]] | None = None,
    ignore_orders: list[bool] | None = None,
) -> int:
    cols = condition_cols or [[] for _ in gold]
    ignores = ignore_orders or [False for _ in gold]
    if len(result) != len(gold) or len(cols) != len(gold) or len(ignores) != len(gold):
        raise ValueError("result, gold, condition_cols, and ignore_orders must have matching lengths")
    for index, (result_path, gold_path) in enumerate(zip(result, gold)):
        pred_table = pd.read_csv(result_path, low_memory=False)
        gold_table = pd.read_csv(gold_path, low_memory=False)
        if not compare_pandas_table(pred_table, gold_table, condition_cols=cols[index], ignore_order=ignores[index]):
            return 0
    return 1
