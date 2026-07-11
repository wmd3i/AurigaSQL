"""LLM success analyzer — the local (``runs/``) counterpart of ``analyzer.py``.

For each PASSED case, :func:`analyze_success_case` spawns the configured
coding-agent CLI (codex or Claude Code) with the case's result + trajectory file
paths and the rubric in ``prompts/successcase.md``. The agent writes its JSON
verdict to ``cases/<case_id>/success_analysis.json`` — co-located with the case
it explains. :func:`summarize_success_run` then aggregates every per-case
analysis into a persisted digest ``success_dump.json`` and a run-level
``success_summary.json``.

The whole point is **harness optimization**: mine the wins for concrete changes
to ``src/dbagent`` (prompt / tool / evaluator) that would let failing cases
reproduce the same winning behavior, and measure how much each win depended on
the ``ask()`` user-guidance channel (a guidance-dependent win is not a
reproducible agent skill).

This mirrors ``analyzer.py`` exactly (same agent plumbing, same "the model writes
its own output file" contract, same env-var configuration), so the coding-agent
command line and config are shared. It reuses the private helpers in
``analyzer`` rather than duplicating the subprocess/CLI logic.

Configuration reuses the same env vars as failure analysis
(``DBAGENT_FAILURE_AGENT`` / ``*_BINARY`` / ``*_MODEL`` / ``*_TIMEOUT`` etc.), so
the two analyzers always run with the same coding agent. The only success-
specific switch is ``DBAGENT_SUCCESS_ANALYSIS`` (or the ``--success-analysis``
CLI flag) to enable it during a run.
"""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from pathlib import Path
from typing import Any

from .analyzer import (
    AGENT_CLAUDE,
    AGENT_CODEX,
    BENCHMARK_ROOT,
    HARNESS_ROOT,
    STDERR_TAIL_BYTES,
    _agent,
    _binary,
    _build_cmd,
    _case_dir,
    _cfg,
    _model,
    _now_iso,
    _read_json_safe,
    _run_agent,
    agent_available,
)

logger = logging.getLogger(__name__)

SUCCESS_PROMPT_PATH = Path(__file__).parent / "prompts" / "successcase.md"
SUCCESS_SUMMARY_PROMPT_PATH = Path(__file__).parent / "prompts" / "successcasesummary.md"
SUCCESS_OUTPUT_NAME = "success_analysis.json"
SUCCESS_STATUS_NAME = ".success_analysis.status.json"
SUCCESS_SUMMARY_NAME = "success_summary.json"
SUCCESS_DUMP_NAME = "success_dump.json"

# Allowed categorical values (kept in sync with worker.py / the prompts).
SUCCESS_PATTERNS = (
    "schema_grounding",
    "clarified_ambiguity",
    "iterative_validation",
    "precise_logic",
    "correct_joins",
    "knowledge_use",
    "careful_output",
    "other",
)
GUIDANCE_LEVELS = ("none", "low", "high")
SUCCESS_DRIVERS = ("agent", "user_guidance", "harness", "benchmark")
HARNESS_LEVERS = ("prompt", "tool", "evaluator", "none")
SUCCESS_FOCUS = ("prompt", "tools", "evaluator")

# Required fields the coding-agent output must contain.
_REQUIRED_CASE_FIELDS = (
    "success_pattern",
    "guidance_dependency",
    "primary_driver",
    "harness_lever",
    "summary",
    "winning_move",
    "transferable_lesson",
)
_REQUIRED_SUMMARY_FIELDS = (
    "overall_summary",
    "winning_patterns",
    "transferable_fixes",
    "guidance_reliance",
    "recommended_focus",
)


def is_enabled() -> bool:
    """Env-var enable check (default OFF). The ``--success-analysis`` CLI flag is
    the primary switch; this lets scripts opt in via ``DBAGENT_SUCCESS_ANALYSIS=1``."""
    return _cfg("DBAGENT_SUCCESS_ANALYSIS", "0").strip().lower() in {"1", "true", "yes", "on"}


def _norm_choice(value: Any, allowed: tuple[str, ...], default: str) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in allowed else default


def _timeout() -> int:
    return int(_cfg("DBAGENT_FAILURE_CODEX_TIMEOUT", "600"))


def _reasoning() -> str:
    return _cfg("DBAGENT_FAILURE_CODEX_REASONING", "medium")


def _validate_case(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "output is not a JSON object"
    missing = [f for f in _REQUIRED_CASE_FIELDS if f not in data]
    if missing:
        return False, f"missing fields: {', '.join(missing)}"
    return True, ""


def _validate_summary(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "summary output is not a JSON object"
    missing = [f for f in _REQUIRED_SUMMARY_FIELDS if f not in data]
    if missing:
        return False, f"missing summary fields: {', '.join(missing)}"
    return True, ""


def _build_case_prompt(case_id: str, case_result_path: Path, trajectory_path: Path | None,
                       output_path: Path) -> str:
    traj_line = (
        f"- trajectory JSON:   {trajectory_path}\n"
        if trajectory_path and trajectory_path.exists()
        else "- trajectory JSON:   (not available for this case)\n"
    )
    return (
        f"Analyze the PASSING text-to-SQL case `{case_id}` and write a structured "
        f"JSON success analysis.\n\n"
        f"Follow the rules in `{SUCCESS_PROMPT_PATH}` exactly — output schema, "
        f"allowed keys, length caps, evidence requirements. Use the exact file "
        f"paths below; do not infer locations.\n\n"
        f"Inputs (already on disk):\n"
        f"- case result JSON:  {case_result_path}\n"
        f"{traj_line}\n"
        f"Output:\n"
        f"- write your JSON analysis to:  {output_path}\n"
        f"- the file must contain ONLY valid JSON conforming to the schema in "
        f"  {SUCCESS_PROMPT_PATH}; no prose, code fences, or commentary outside the JSON.\n"
        f"- do NOT include any `_`-prefixed fields; the runner adds those.\n"
    )


def analyze_success_case(case_result: dict[str, Any], *, run_id: str | None = None) -> dict[str, Any] | None:
    """Run the coding agent on one PASSED case and write ``success_analysis.json``.

    Returns the written analysis dict on success, or None if skipped/failed.
    Never raises — analysis must never bring down a benchmark run; all errors are
    caught, logged, and recorded in a ``.status.json`` sidecar.
    """
    import subprocess
    import time

    case_id = str(case_result.get("case_id", "?"))
    agent = _agent()
    binary = _binary(agent)
    model = _model(agent)
    timeout = _timeout()

    case_dir = _case_dir(case_result)
    if case_dir is None or not case_dir.exists():
        logger.warning("success_analysis_skip case=%s reason=no_case_dir", case_id)
        return None

    case_result_path = case_dir / "result.json"
    if not case_result_path.exists():
        embedded = (case_result.get("artifacts") or {}).get("case_result_path")
        if embedded and Path(embedded).exists():
            case_result_path = Path(embedded)
        else:
            logger.warning("success_analysis_skip case=%s reason=no_result_json", case_id)
            return None

    traj = (case_result.get("logs") or {}).get("trajectory")
    trajectory_path = Path(traj) if traj else (case_dir / "trajectory.json")

    output_path = case_dir / SUCCESS_OUTPUT_NAME
    status_path = case_dir / SUCCESS_STATUS_NAME

    if not agent_available(agent):
        logger.warning("success_analysis_skip case=%s reason=agent_not_found agent=%s binary=%s", case_id, agent, binary)
        return None

    status_path.write_text(json.dumps({
        "state": "RUNNING", "started_at": _now_iso(), "agent": agent, "model": model,
    }, indent=2))

    prompt = _build_case_prompt(case_id, case_result_path, trajectory_path, output_path)
    allow_dirs = [case_dir]
    if trajectory_path.exists() and trajectory_path.parent != case_dir:
        allow_dirs.append(trajectory_path.parent)
    cmd = _build_cmd(prompt, agent=agent, binary=binary, model=model,
                     reasoning=_reasoning(), allow_dirs=allow_dirs)

    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        status_path.write_text(json.dumps({
            "state": "FAILED", "error": f"timeout after {timeout}s",
        }, indent=2))
        logger.warning("success_analysis_timeout case=%s after=%ss", case_id, timeout)
        return None
    except Exception as exc:
        status_path.write_text(json.dumps({"state": "FAILED", "error": str(exc)}, indent=2))
        logger.warning("success_analysis_error case=%s error=%s", case_id, exc)
        return None

    elapsed = time.monotonic() - t0

    if proc.returncode != 0:
        tail = (proc.stderr or "")[-STDERR_TAIL_BYTES:]
        status_path.write_text(json.dumps({
            "state": "FAILED", "returncode": proc.returncode, "stderr_tail": tail,
        }, indent=2))
        logger.warning("success_analysis_rc case=%s rc=%s", case_id, proc.returncode)
        return None

    if not output_path.exists():
        status_path.write_text(json.dumps({
            "state": "FAILED_PARSE", "error": "agent returned rc=0 but wrote no output file",
        }, indent=2))
        logger.warning("success_analysis_nooutput case=%s", case_id)
        return None

    raw = output_path.read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        status_path.write_text(json.dumps({"state": "FAILED_PARSE", "error": str(exc)}, indent=2))
        logger.warning("success_analysis_badjson case=%s error=%s", case_id, exc)
        return None

    ok, err = _validate_case(data)
    if not ok:
        status_path.write_text(json.dumps({"state": "FAILED_PARSE", "error": err}, indent=2))
        logger.warning("success_analysis_invalid case=%s error=%s", case_id, err)
        return None

    evaluation = case_result.get("evaluation") or {}
    data["success_pattern"] = _norm_choice(data.get("success_pattern"), SUCCESS_PATTERNS, "other")
    data["guidance_dependency"] = _norm_choice(data.get("guidance_dependency"), GUIDANCE_LEVELS, "none")
    data["primary_driver"] = _norm_choice(data.get("primary_driver"), SUCCESS_DRIVERS, "agent")
    data["harness_lever"] = _norm_choice(data.get("harness_lever"), HARNESS_LEVERS, "none")
    data.setdefault("case_id", case_id)
    data["_meta"] = {
        "agent": agent,
        "model": model,
        "elapsed_s": round(elapsed, 2),
        "analyzed_at": _now_iso(),
        "score": evaluation.get("score"),
        "run_id": run_id or case_result.get("run_id"),
    }
    output_path.write_text(json.dumps(data, indent=2))

    if status_path.exists():
        status_path.unlink()

    logger.info("success_analysis_done case=%s pattern=%s lever=%s guidance=%s elapsed=%.1fs",
                case_id, data["success_pattern"], data["harness_lever"], data["guidance_dependency"], elapsed)
    return data


def _passed_case_ids(run_dir: Path) -> list[str]:
    """Case ids whose ``result.json`` reports evaluation.passed == True."""
    cases_dir = run_dir / "cases"
    if not cases_dir.exists():
        return []
    passed: list[str] = []
    for case_dir in sorted(cases_dir.iterdir(), key=lambda p: _sort_key(p.name)):
        if not case_dir.is_dir():
            continue
        result = _read_json_safe(case_dir / "result.json")
        if isinstance(result, dict) and bool((result.get("evaluation") or {}).get("passed")):
            passed.append(case_dir.name)
    return passed


def _sort_key(name: str):
    return (0, int(name)) if name.isdigit() else (1, name)


def _distribution(counts: Counter, total: int) -> list[dict[str, Any]]:
    return [
        {"key": key, "count": count, "pct": round(100.0 * count / total, 1) if total else 0.0}
        for key, count in counts.most_common()
    ]


def _load_case_analysis(run_dir: Path, case_id: str) -> dict[str, Any] | None:
    data = _read_json_safe(run_dir / "cases" / case_id / SUCCESS_OUTPUT_NAME)
    return data if isinstance(data, dict) else None


def _build_digest(run_dir: Path, run_id: str | None, analyzed: list[dict[str, Any]], passed_total: int) -> dict[str, Any]:
    pattern_counts: Counter = Counter()
    guidance_counts: Counter = Counter()
    driver_counts: Counter = Counter()
    lever_counts: Counter = Counter()
    for a in analyzed:
        pattern_counts[_norm_choice(a.get("success_pattern"), SUCCESS_PATTERNS, "other")] += 1
        guidance_counts[_norm_choice(a.get("guidance_dependency"), GUIDANCE_LEVELS, "none")] += 1
        driver_counts[_norm_choice(a.get("primary_driver"), SUCCESS_DRIVERS, "agent")] += 1
        lever_counts[_norm_choice(a.get("harness_lever"), HARNESS_LEVERS, "none")] += 1
    n = len(analyzed)
    return {
        "run_id": run_id,
        "generated_at": _now_iso(),
        "stats": {
            "passed_cases": passed_total,
            "analyzed_cases": n,
            "pending_cases": max(passed_total - n, 0),
            "coverage_pct": round(100.0 * n / passed_total, 1) if passed_total else 0.0,
            "by_success_pattern": _distribution(pattern_counts, n),
            "by_guidance_dependency": _distribution(guidance_counts, n),
            "by_primary_driver": _distribution(driver_counts, n),
            "by_harness_lever": _distribution(lever_counts, n),
            "top_success_pattern": pattern_counts.most_common(1)[0][0] if pattern_counts else None,
            "top_harness_lever": lever_counts.most_common(1)[0][0] if lever_counts else None,
            "guidance_high_pct": round(100.0 * guidance_counts.get("high", 0) / n, 1) if n else 0.0,
            "actionable_lever_pct": round(100.0 * (n - lever_counts.get("none", 0)) / n, 1) if n else 0.0,
        },
        "cases": [
            {
                "case_id": a.get("case_id"),
                "success_pattern": _norm_choice(a.get("success_pattern"), SUCCESS_PATTERNS, "other"),
                "guidance_dependency": _norm_choice(a.get("guidance_dependency"), GUIDANCE_LEVELS, "none"),
                "primary_driver": _norm_choice(a.get("primary_driver"), SUCCESS_DRIVERS, "agent"),
                "harness_lever": _norm_choice(a.get("harness_lever"), HARNESS_LEVERS, "none"),
                "summary": a.get("summary"),
                "transferable_lesson": a.get("transferable_lesson"),
            }
            for a in analyzed
        ],
    }


def summarize_success_run(run_dir: str | Path, *, run_id: str | None = None) -> dict | None:
    """Aggregate per-case success analyses into a persisted ``success_dump.json``
    digest plus a ``success_summary.json`` (deterministic stats + LLM narrative).

    Never raises. Always writes ``success_dump.json`` + the deterministic stats
    even if the coding-agent narrative step is unavailable or fails.
    """
    run_dir = Path(run_dir)
    passed_ids = _passed_case_ids(run_dir)
    analyzed = [a for a in (_load_case_analysis(run_dir, cid) for cid in passed_ids) if a is not None]
    if not analyzed:
        logger.info("success_summary_skip reason=no_analyses run_dir=%s", run_dir)
        return None

    digest = _build_digest(run_dir, run_id, analyzed, len(passed_ids))
    # Persist the digest (unlike failure analysis, which deletes its scratch input).
    (run_dir / SUCCESS_DUMP_NAME).write_text(json.dumps(digest, indent=2))

    summary: dict[str, Any] = {
        "run_id": run_id,
        "generated_at": _now_iso(),
        "agent": _agent(),
        "stats": digest["stats"],
        "narrative": None,
    }

    agent = _agent()
    if agent_available(agent):
        dump_path = run_dir / SUCCESS_DUMP_NAME
        output_path = run_dir / ".success_summary_narrative.json"
        read_source = _cfg("DBAGENT_SUCCESS_SUMMARY_READ_SOURCE", "1").strip().lower() \
            not in {"0", "false", "no", "off"}
        allow_dirs = [run_dir]
        if read_source:
            allow_dirs += [HARNESS_ROOT, BENCHMARK_ROOT]
            source_lines = (
                f"harness_root (read to ground prompt/tool/evaluator fixes):  {HARNESS_ROOT}\n"
                f"You MAY read source files under that root (read-only) to make the "
                f"transferable_fixes cite real file:function locations.\n"
            )
        else:
            source_lines = (
                "Do NOT read source code; base transferable_fixes on the digest alone.\n"
            )
        prompt = (
            f"Synthesize a run-level SUCCESS summary for harness optimization. "
            f"Follow the rules and output schema in `{SUCCESS_SUMMARY_PROMPT_PATH}` "
            f"exactly.\n\n"
            f"Input digest (dump.json, read it):  {dump_path}\n"
            f"{source_lines}"
            f"Write your JSON summary to:  {output_path}\n"
            f"Write ONLY valid JSON conforming to the schema; no prose or code fences.\n"
        )
        ok, errtail = _run_agent(prompt, agent=agent, binary=_binary(agent), model=_model(agent),
                                 reasoning=_reasoning(), timeout=_timeout(), allow_dirs=allow_dirs)
        if ok and output_path.exists():
            narrative = _read_json_safe(output_path)
            valid, verr = _validate_summary(narrative)
            if valid:
                narrative["recommended_focus"] = _norm_choice(
                    narrative.get("recommended_focus"), SUCCESS_FOCUS, "prompt"
                )
                summary["narrative"] = narrative
            else:
                logger.warning("success_summary_narrative_invalid run_dir=%s err=%s", run_dir, verr)
        else:
            logger.warning("success_summary_narrative_failed run_dir=%s err=%s", run_dir, errtail)
        if output_path.exists():
            output_path.unlink()

    (run_dir / SUCCESS_SUMMARY_NAME).write_text(json.dumps(summary, indent=2))
    logger.info("success_summary_written run_dir=%s analyzed=%d top_lever=%s",
                run_dir, len(analyzed), digest["stats"].get("top_harness_lever"))
    return summary


def analyze_run(run_dir: str | Path, *, force: bool = False,
                max_workers: int | None = None,
                case_ids: list[str] | None = None) -> dict[str, Any]:
    """Analyze the PASSED cases of an existing run, then write the dump + summary.

    Idempotent — passed cases already having ``success_analysis.json`` are skipped
    unless ``force``. Explicit invocation, so it ignores :func:`is_enabled` (the
    env/flag switch) — but it still needs the coding-agent CLI.
    """
    run_dir = Path(run_dir)
    agent = _agent()
    if not agent_available(agent):
        logger.warning("success backfill aborted: %s binary not found on PATH", _binary(agent))
        return {"analyzed": 0, "skipped": 0, "failed": 0, "error": f"{agent} not found"}

    run_json = _read_json_safe(run_dir / "run.json") or {}
    run_id = run_json.get("run_id") or run_dir.name

    passed_ids = _passed_case_ids(run_dir)
    if case_ids is not None:
        wanted = set(case_ids)
        missing = wanted - set(passed_ids)
        passed_ids = [cid for cid in passed_ids if cid in wanted]
        if missing:
            logger.warning("success backfill: requested case(s) not among this run's passes — skipping: %s", ", ".join(sorted(missing)))

    todo = [cid for cid in passed_ids if force or not (run_dir / "cases" / cid / SUCCESS_OUTPUT_NAME).exists()]
    already = len(passed_ids) - len(todo)
    logger.info("success_backfill_start run_dir=%s passed=%d todo=%d already_done=%d force=%s",
                run_dir, len(passed_ids), len(todo), already, force)

    analyzed = failed = 0
    if todo:
        workers = max_workers or int(_cfg("DBAGENT_FAILURE_MAX_WORKERS", "2"))
        from concurrent.futures import ThreadPoolExecutor

        def _one(case_id: str):
            payload = _read_json_safe(run_dir / "cases" / case_id / "result.json")
            if payload is None:
                return None
            payload.setdefault("case_id", case_id)
            return analyze_success_case(payload, run_id=run_id)

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="success-backfill") as pool:
            for result in pool.map(_one, todo):
                if result is not None:
                    analyzed += 1
                else:
                    failed += 1

    if analyzed or force or not (run_dir / SUCCESS_SUMMARY_NAME).exists():
        summarize_success_run(run_dir, run_id=run_id)

    logger.info("success_backfill_done run_dir=%s analyzed=%d skipped=%d failed=%d",
                run_dir, analyzed, already, failed)
    return {"analyzed": analyzed, "skipped": already, "failed": failed}


def main():
    """CLI: analyze the PASSED cases of an existing run dir (backfill)."""
    import argparse

    p = argparse.ArgumentParser(
        prog="python -m dbagent.failure_analysis.success_analyzer",
        description="Backfill success analysis onto an existing run directory "
                    "(writes success_analysis.json + success_dump.json + success_summary.json).",
    )
    p.add_argument("--run", type=Path, required=True, help="path to a runs/<run_id> directory")
    p.add_argument("--case", action="append", default=None, metavar="CASE_ID",
                   help="only analyze this passed case (repeatable, or comma-separated). "
                        "Default: all passed cases.")
    p.add_argument("--force", action="store_true",
                   help="re-analyze cases that already have success_analysis.json")
    p.add_argument("--agent", choices=[AGENT_CODEX, AGENT_CLAUDE], default=None,
                   help="coding-agent CLI to use (default: codex, or $DBAGENT_FAILURE_AGENT)")
    args = p.parse_args()
    if not args.run.exists():
        raise SystemExit(f"run dir not found: {args.run}")
    if args.agent:
        os.environ["DBAGENT_FAILURE_AGENT"] = args.agent

    case_ids = None
    if args.case:
        case_ids = [cid.strip() for item in args.case for cid in item.split(",") if cid.strip()]

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    result = analyze_run(args.run, force=args.force, case_ids=case_ids)
    print(f"success backfill done: analyzed={result['analyzed']} skipped={result['skipped']} "
          f"failed={result['failed']}")
    print(f"dump:    {args.run / SUCCESS_DUMP_NAME}")
    print(f"summary: {args.run / SUCCESS_SUMMARY_NAME}")


if __name__ == "__main__":
    main()
