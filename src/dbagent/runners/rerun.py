"""Re-run support: reconstruct config from an existing run and decide which
cases to re-execute.

A re-run reuses an existing run directory in place. ``load_run_config`` rebuilds
the configs from the saved ``run.json`` so the CLI doesn't need them re-specified,
and ``plan_rerun`` splits the dataset into the cases to execute versus the
already-good results to carry forward (fed back into ``RunState`` so the
finalized run.json / predictions / evaluation_summary cover the full set).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dbagent.benchmarks.base import ERROR_TYPES, BenchmarkCase
from dbagent.config import AgentConfig, ConnectorConfig, ExperimentConfig

# Supported selection modes. Add new modes by extending plan_rerun below.
RERUN_MODES = ("incomplete", "failed")
# Optional sub-filter (only meaningful with mode="failed"): narrow the re-run to
# failures of a specific evaluation error_type. Sourced from the canonical set in
# benchmarks.base so the filter can never reject a value an evaluator emits.
ERROR_TYPE_FILTERS = ERROR_TYPES


@dataclass(slots=True)
class RerunConfig:
    run_id: str
    benchmark_id: str
    connector_config: ConnectorConfig
    agent_config: AgentConfig
    experiment_config: ExperimentConfig


@dataclass(slots=True)
class RerunPlan:
    # Cases to execute; their result.json will be (re)written.
    to_run: list[BenchmarkCase]
    # Already-good result payloads to seed into RunState so the finalized run
    # totals/predictions/summary cover the full dataset, not just to_run.
    carry_forward: list[dict[str, Any]]


def load_run_config(run_dir: Path) -> RerunConfig:
    """Rebuild the configs of an existing run from its run.json."""
    record = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    cfg = record["config"]
    return RerunConfig(
        run_id=run_dir.name,
        benchmark_id=record["benchmark_id"],
        connector_config=ConnectorConfig(**cfg["connector"]),
        agent_config=AgentConfig(**cfg["agent"]),
        experiment_config=ExperimentConfig(**cfg["experiment"]),
    )


def _load_result(run_dir: Path, case_id: str) -> dict[str, Any] | None:
    """Return a case's saved result payload, or None if missing or corrupt.

    A half-written/corrupt result is treated as None so the case is re-run.
    """
    path = run_dir / "cases" / case_id / "result.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _passed(payload: dict[str, Any]) -> bool:
    return bool((payload.get("evaluation") or {}).get("passed"))


def _error_type(payload: dict[str, Any]) -> str | None:
    return (payload.get("evaluation") or {}).get("error_type")


def plan_rerun(
    run_dir: Path,
    cases: list[BenchmarkCase],
    mode: str,
    error_type: str | None = None,
) -> RerunPlan:
    """Split cases into (to_run, carry_forward) for the given mode.

    - "incomplete": run cases with no usable result.json; keep the rest.
    - "failed": additionally re-run cases whose result.json did not pass.

    error_type (only valid with mode="failed") narrows the re-run to failures of
    that evaluation error_type. Incomplete cases (no usable result.json) are
    always re-run regardless of the filter, since they have no error_type yet.
    """
    if mode not in RERUN_MODES:
        raise ValueError(f"Unknown rerun mode {mode!r}; expected one of {RERUN_MODES}")
    if error_type is not None:
        if error_type not in ERROR_TYPE_FILTERS:
            raise ValueError(f"Unknown error_type filter {error_type!r}; expected one of {ERROR_TYPE_FILTERS}")
        if mode != "failed":
            raise ValueError("error_type filter is only valid with mode='failed'")

    to_run: list[BenchmarkCase] = []
    carry_forward: list[dict[str, Any]] = []
    for case in cases:
        payload = _load_result(run_dir, case.case_id)
        if payload is None:
            # Incomplete: re-run regardless of mode or filter (no error_type yet).
            to_run.append(case)
        elif mode == "failed" and not _passed(payload) and (
            error_type is None or _error_type(payload) == error_type
        ):
            to_run.append(case)
        else:
            carry_forward.append(payload)
    return RerunPlan(to_run=to_run, carry_forward=carry_forward)
