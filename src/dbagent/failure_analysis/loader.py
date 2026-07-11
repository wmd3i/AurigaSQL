"""Read-only loader: walk a run directory and collect failure analyses.

No LLM, no codex. This is the viewer's data layer. It reads the per-case
``result.json`` for objective context (question, gold vs predicted SQL,
error_type) and the ``failure_analysis.json`` that the runner wrote, plus any
``.failure_analysis.status.json`` sidecar so the viewer can show in-flight /
failed analyses while a run is still going.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

OUTPUT_NAME = "failure_analysis.json"
STATUS_NAME = ".failure_analysis.status.json"


def _read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


@dataclass
class CaseView:
    """Everything the viewer needs to render one failed case."""

    case_id: str
    case_index: int | None
    db_id: str | None
    question: str | None
    error_type: str | None
    score: Any
    gold_sql: str | None
    predicted_sql: str | None
    # The analysis state for this case:
    #   "DONE"    — failure_analysis.json present
    #   "RUNNING" — status sidecar says running
    #   "FAILED"  — status sidecar says failed/failed_parse
    #   "PENDING" — failed case with neither (not yet analyzed)
    analysis_state: str = "PENDING"
    analysis: dict | None = None
    status: dict | None = None
    # Run-level review can contradict this card's per-case verdict (the
    # per-case analyzer is behavioral-only and unaware of evaluator semantics).
    # When failure_summary.json's narrative.attribution_corrections names this
    # case, the matching text is attached here so the card can warn the reader.
    correction: str | None = None
    # Chinese translation of ``correction`` (from narrative.attribution_corrections_zh,
    # matched by the same index). Falls back to the English text when absent.
    correction_zh: str | None = None

    @property
    def failure_category(self) -> str | None:
        return (self.analysis or {}).get("failure_category")

    @property
    def attribution(self) -> str | None:
        return (self.analysis or {}).get("attribution")


@dataclass
class RunView:
    run_dir: Path
    run_id: str | None
    benchmark_id: str | None
    total_cases: int | None
    passed_cases: int | None
    failed_cases: int | None
    accuracy: float | None
    failed: list[CaseView] = field(default_factory=list)
    summary: dict | None = None  # run-level aggregation, if baked

    @property
    def analyzed_count(self) -> int:
        return sum(1 for c in self.failed if c.analysis_state == "DONE")


def load_run(run_dir: str | Path) -> RunView:
    run_dir = Path(run_dir)
    run_json = _read_json(run_dir / "run.json") or {}
    summary_json = _read_json(run_dir / "evaluation_summary.json") or {}

    # Index case summaries by id for objective context without re-reading every
    # result.json twice. evaluation_summary.case_summaries is the cheap source.
    case_summaries = {
        str(cs.get("case_id")): cs for cs in (summary_json.get("case_summaries") or [])
    }

    failed: list[CaseView] = []
    cases_dir = run_dir / "cases"
    if cases_dir.exists():
        for case_dir in sorted(cases_dir.iterdir(), key=lambda p: _sort_key(p.name)):
            if not case_dir.is_dir():
                continue
            view = _load_case(case_dir, case_summaries.get(case_dir.name))
            if view is not None:
                failed.append(view)

    summary = _read_json(run_dir / "failure_summary.json")
    _attach_corrections(failed, summary)

    return RunView(
        run_dir=run_dir,
        run_id=run_json.get("run_id") or summary_json.get("run_id"),
        benchmark_id=run_json.get("benchmark_id") or summary_json.get("benchmark_id"),
        total_cases=run_json.get("total_cases") or summary_json.get("total_cases"),
        passed_cases=run_json.get("passed_cases") or summary_json.get("passed_cases"),
        failed_cases=run_json.get("failed_cases") or summary_json.get("failed_cases"),
        accuracy=run_json.get("accuracy"),
        failed=failed,
        summary=summary,
    )


def _attach_corrections(failed: list["CaseView"], summary: dict | None) -> None:
    """Map narrative.attribution_corrections entries onto the cases they name.

    Corrections are free text that mentions a case_id (e.g. "provider001 tagged
    as ..."). We match a correction to a case when its case_id appears as a whole
    token, so numeric ids like "0" don't match "10". A correction may name more
    than one case; each gets it. Multiple corrections for one case are joined.
    """
    narrative = (summary or {}).get("narrative") or {}
    corrections = narrative.get("attribution_corrections") or []
    # Parallel Chinese array (same order/length); index i is the translation of
    # corrections[i]. May be shorter/absent — we fall back to English per item.
    corrections_zh = narrative.get("attribution_corrections_zh") or []
    if not corrections:
        return
    for case in failed:
        hits, hits_zh = [], []
        for i, c in enumerate(corrections):
            if isinstance(c, str) and re.search(
                rf"(?<![A-Za-z0-9]){re.escape(case.case_id)}(?![A-Za-z0-9])", c
            ):
                hits.append(c)
                zh = corrections_zh[i] if i < len(corrections_zh) else None
                hits_zh.append(zh if isinstance(zh, str) and zh.strip() else c)
        if hits:
            case.correction = " ".join(hits)
            case.correction_zh = " ".join(hits_zh)


def _sort_key(name: str):
    # Numeric case ids (BIRD) sort numerically; string ids (Spider2) sort lexically.
    return (0, int(name)) if name.isdigit() else (1, name)


def _load_case(case_dir: Path, case_summary: dict | None) -> CaseView | None:
    """Return a CaseView for a FAILED case, or None if the case passed/unknown."""
    result = _read_json(case_dir / "result.json")
    evaluation = (result or {}).get("evaluation") or {}

    # Determine pass/fail. Prefer result.json; fall back to the summary row.
    if result is not None:
        passed = bool(evaluation.get("passed"))
    elif case_summary is not None:
        passed = bool(case_summary.get("passed"))
    else:
        return None  # nothing to read

    if passed:
        return None  # viewer only shows failures

    src = result or {}
    inp = src.get("input") or {}
    ref = src.get("reference") or {}
    pred = src.get("prediction") or {}
    cs = case_summary or {}

    view = CaseView(
        case_id=case_dir.name,
        case_index=src.get("case_index", cs.get("case_index")),
        db_id=inp.get("db_id") or cs.get("db_id"),
        question=inp.get("question") or cs.get("question"),
        error_type=evaluation.get("error_type", cs.get("error_type")),
        score=evaluation.get("score", cs.get("score")),
        gold_sql=ref.get("gold_sql") or cs.get("gold_sql"),
        predicted_sql=pred.get("final_sql") or cs.get("prediction_sql"),
    )

    analysis = _read_json(case_dir / OUTPUT_NAME)
    if analysis is not None:
        view.analysis = analysis
        view.analysis_state = "DONE"
        return view

    status = _read_json(case_dir / STATUS_NAME)
    if status is not None:
        view.status = status
        state = str(status.get("state", "")).upper()
        view.analysis_state = "RUNNING" if state == "RUNNING" else "FAILED"
        return view

    view.analysis_state = "PENDING"
    return view
