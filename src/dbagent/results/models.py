from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID


def jsonify(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", "replace")
    if isinstance(value, dict):
        return {key: jsonify(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonify(item) for item in value]
    return value


@dataclass(slots=True)
class CaseResult:
    run_id: str
    benchmark_id: str
    split: str
    case_id: str
    case_index: int
    input: dict[str, Any]
    reference: dict[str, Any]
    prediction: dict[str, Any]
    evaluation: dict[str, Any]
    status: str
    timing: dict[str, Any]
    llm: dict[str, Any]
    artifacts: dict[str, Any] = field(default_factory=dict)
    logs: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return jsonify(asdict(self))


@dataclass(slots=True)
class RunRecord:
    run_id: str
    benchmark_id: str
    split: str
    config: dict[str, Any]
    started_at: str
    git: dict[str, Any] | None = None
    # populated at end of run
    total_cases: int | None = None
    completed_cases: int | None = None
    passed_cases: int | None = None
    failed_cases: int | None = None
    accuracy: float | None = None
    token_stats: dict[str, Any] = field(default_factory=dict)
    output_paths: dict[str, Any] = field(default_factory=dict)
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return jsonify(asdict(self))
