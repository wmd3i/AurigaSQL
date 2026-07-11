from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path

from dbagent.benchmarks.base import BenchmarkCase


def parse_indices(value: str, *, source: str = "--indices") -> list[int]:
    """Parse zero-based dataset indices separated by commas or whitespace."""
    tokens = [token for token in re.split(r"[\s,]+", value.strip()) if token]
    if not tokens:
        raise ValueError(f"{source} must contain at least one index")

    indices: list[int] = []
    seen: set[int] = set()
    for token in tokens:
        try:
            index = int(token)
        except ValueError as exc:
            raise ValueError(f"{source} contains an invalid index: {token!r}") from exc
        if index < 0:
            raise ValueError(f"{source} indices must be non-negative: {index}")
        if index in seen:
            raise ValueError(f"{source} contains a duplicate index: {index}")
        seen.add(index)
        indices.append(index)
    return indices


def load_indices_file(path: Path) -> list[int]:
    try:
        value = path.expanduser().read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Could not read indices file {path}: {exc}") from exc
    return parse_indices(value, source=str(path))


def select_cases(cases: Sequence[BenchmarkCase], indices: Sequence[int]) -> list[BenchmarkCase]:
    """Select cases by their zero-based ``case_index`` values.

    The returned cases follow the order of ``indices``, not the order of
    ``cases``. For example, requesting ``[7, 2]`` returns the case whose
    ``case_index`` is 7 first, followed by the case whose index is 2.

    Raises ``ValueError`` if any requested index is absent from the dataset.
    """
    by_index = {case.case_index: case for case in cases}
    missing = [index for index in indices if index not in by_index]
    if missing:
        available = sorted(by_index)
        bounds = f"{available[0]}..{available[-1]}" if available else "empty dataset"
        rendered = ", ".join(str(index) for index in missing)
        raise ValueError(f"Dataset indices not found: {rendered} (available: {bounds})")
    return [by_index[index] for index in indices]
