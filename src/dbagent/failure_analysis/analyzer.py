"""LLM failure analyzer (the only place codex is invoked).

For each FAILED case, the experiment runner calls :func:`analyze_case`, which
spawns ``codex exec`` with the case's result + trajectory file paths and the
rubric in ``prompts/analysis.md``. codex writes its JSON verdict to
``cases/<case_id>/failure_analysis.json`` — co-located with the case it explains.

This mirrors the precedent in the BIRD-Interact-ADK web_report analyzer (same
flags, same "the model writes its own output file" pattern). This is the
generation side of the ``failure_analysis`` package; the viewer modules
(``loader``/``aggregate``/``render``/``serve``) stay LLM-free. The dependency
points one way: this module may use the viewer modules (for summary + bake);
they never import this one.

The coding-agent CLI is pluggable: ``codex`` (default) or ``claude`` (Claude
Code). Both follow the same "read the file paths, write your own JSON output
file" contract, so the prompts are unchanged; only the command line differs.

Configuration (all optional, read from the environment so no run-config plumbing
is required):

- ``DBAGENT_FAILURE_ANALYSIS``     — set "1"/"true" to enable during a run via
  env (the ``--failure-analysis`` flag does the same). Default OFF; a plain run
  never spawns the agent. (Backfill via ``backfill_run`` ignores this — it's explicit.)
- ``DBAGENT_FAILURE_AGENT``         — coding-agent CLI: "codex" (default) or "claude".
- ``DBAGENT_FAILURE_CODEX_BINARY``  — codex executable. Default "codex".
- ``DBAGENT_FAILURE_CODEX_MODEL``   — codex model id. Default "gpt-5.4".
- ``DBAGENT_FAILURE_CODEX_REASONING`` — minimal|low|medium|high (codex only). Default "medium".
- ``DBAGENT_FAILURE_CLAUDE_BINARY`` — claude executable. Default "claude".
- ``DBAGENT_FAILURE_CLAUDE_MODEL``  — claude model/alias. Default "claude-sonnet-4-6".
- ``DBAGENT_FAILURE_CODEX_TIMEOUT``  — seconds (both agents). Default 600.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .taxonomy import normalize_attribution, normalize_category

logger = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent / "prompts" / "analysis.md"
SUMMARY_PROMPT_PATH = Path(__file__).parent / "prompts" / "summary.md"
OUTPUT_NAME = "failure_analysis.json"
STATUS_NAME = ".failure_analysis.status.json"
SUMMARY_NAME = "failure_summary.json"

# Source roots for code-grounded summary suggestions.
# __file__ = src/dbagent/failure_analysis/analyzer.py
#   parents[1] = src/dbagent   -> the harness
#   parents[1]/benchmarks      -> the benchmark adapters + gold loading
HARNESS_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_ROOT = HARNESS_ROOT / "benchmarks"

STDERR_TAIL_BYTES = 2048

# String fields the codex output must contain (besides failure_category).
_REQUIRED_FIELDS = ("summary", "root_cause", "evidence", "fix_suggestion", "confidence")


def _cfg(name: str, default: str) -> str:
    return os.environ.get(name, default)


def is_enabled() -> bool:
    """Env-var enable check (default OFF). The --failure-analysis CLI flag is the
    primary switch; this lets scripts opt in via DBAGENT_FAILURE_ANALYSIS=1."""
    return _cfg("DBAGENT_FAILURE_ANALYSIS", "0").strip().lower() in {"1", "true", "yes", "on"}


AGENT_CODEX = "codex"
AGENT_CLAUDE = "claude"


def _agent() -> str:
    """Selected coding-agent CLI. Default codex so existing runs are unchanged."""
    val = _cfg("DBAGENT_FAILURE_AGENT", AGENT_CODEX).strip().lower()
    return AGENT_CLAUDE if val in {"claude", "claude-code", "cc"} else AGENT_CODEX


def _binary(agent: str | None = None) -> str:
    agent = agent or _agent()
    if agent == AGENT_CLAUDE:
        return _cfg("DBAGENT_FAILURE_CLAUDE_BINARY", "claude")
    return _cfg("DBAGENT_FAILURE_CODEX_BINARY", "codex")


def _model(agent: str | None = None) -> str:
    agent = agent or _agent()
    if agent == AGENT_CLAUDE:
        return _cfg("DBAGENT_FAILURE_CLAUDE_MODEL", "claude-sonnet-4-6")
    return _cfg("DBAGENT_FAILURE_CODEX_MODEL", "gpt-5.4")


def _build_cmd(prompt: str, *, agent: str, binary: str, model: str,
               reasoning: str, allow_dirs: list[Path] | None = None) -> list[str]:
    """Build the agent command line. Both agents read the file paths in the
    prompt and write their own JSON output file; only the flags differ."""
    if agent == AGENT_CLAUDE:
        # Claude Code headless: -p prints and exits; bypassPermissions skips the
        # approval prompts; --add-dir grants Read/Write on the case/run dirs.
        # Codex's model_reasoning_effort has no Claude equivalent, so it's dropped.
        cmd = [binary, "-p", prompt, "--model", model,
               "--permission-mode", "bypassPermissions"]
        for d in allow_dirs or []:
            cmd += ["--add-dir", str(d)]
        return cmd
    # codex (default) — unchanged from the original hard-coded command.
    return [binary, "exec", "--skip-git-repo-check", "-m", model,
            "-c", f"model_reasoning_effort='{reasoning}'",
            "--dangerously-bypass-approvals-and-sandbox", prompt]


def agent_available(agent: str | None = None) -> bool:
    """True if the selected agent's CLI is on PATH."""
    return shutil.which(_binary(agent)) is not None


def codex_available(binary: str | None = None) -> bool:
    """Back-compat shim: availability of the currently-selected agent."""
    if binary is not None:
        return shutil.which(binary) is not None
    return agent_available()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _case_dir(case_result: dict[str, Any]) -> Path | None:
    """Locate the on-disk case directory from a case-result payload."""
    path = (case_result.get("artifacts") or {}).get("case_result_path")
    if not path:
        return None
    return Path(path).parent


# TODO(per-case-source-grounding): per-case analysis is intentionally
# behavioral-only — it reads result.json + trajectory.json but NOT the harness
# source, to keep this hot path (runs once per failed case) cheap. The
# llm-vs-harness attribution is therefore inferred, not code-verified. The
# run-level summary (summarize_run) reads source and emits
# `attribution_corrections`. If those corrections show llm/harness is
# *frequently* miscalled here, revisit: let this per-case call read source only
# when it leans `harness`, to verify against e.g. agents/sql_agent.py / dbtools.py.
def _build_prompt(case_id: str, case_result_path: Path, trajectory_path: Path | None,
                  output_path: Path) -> str:
    traj_line = (
        f"- trajectory JSON:   {trajectory_path}\n"
        if trajectory_path and trajectory_path.exists()
        else "- trajectory JSON:   (not available for this case)\n"
    )
    return (
        f"Analyze the failed text-to-SQL case `{case_id}` and write a structured "
        f"JSON failure analysis.\n\n"
        f"Follow the rules in `{PROMPT_PATH}` exactly — output schema, allowed "
        f"category keys, length caps, evidence requirements. Use the exact file "
        f"paths below; do not infer locations.\n\n"
        f"Inputs (already on disk):\n"
        f"- case result JSON:  {case_result_path}\n"
        f"{traj_line}\n"
        f"Output:\n"
        f"- write your JSON analysis to:  {output_path}\n"
        f"- the file must contain ONLY valid JSON conforming to the schema in "
        f"  {PROMPT_PATH}; no prose, code fences, or commentary outside the JSON.\n"
        f"- do NOT include any `_`-prefixed fields; the runner adds those.\n"
    )


def _validate(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "output is not a JSON object"
    if "failure_category" not in data:
        return False, "missing 'failure_category'"
    missing = [f for f in _REQUIRED_FIELDS if f not in data]
    if missing:
        return False, f"missing fields: {', '.join(missing)}"
    return True, ""


def analyze_case(case_result: dict[str, Any], *, run_id: str | None = None) -> dict[str, Any] | None:
    """Run codex on one failed case and write ``failure_analysis.json``.

    Returns the written analysis dict on success, or None if skipped/failed.
    Never raises — failure analysis must never bring down a benchmark run, so
    all errors are caught, logged, and recorded in a ``.status.json`` sidecar.
    """
    case_id = str(case_result.get("case_id", "?"))
    agent = _agent()
    binary = _binary(agent)
    model = _model(agent)
    reasoning = _cfg("DBAGENT_FAILURE_CODEX_REASONING", "medium")
    timeout = int(_cfg("DBAGENT_FAILURE_CODEX_TIMEOUT", "600"))

    case_dir = _case_dir(case_result)
    if case_dir is None or not case_dir.exists():
        logger.warning("failure_analysis_skip case=%s reason=no_case_dir", case_id)
        return None

    case_result_path = case_dir / "result.json"
    if not case_result_path.exists():
        # Fall back to the path embedded in the payload.
        embedded = (case_result.get("artifacts") or {}).get("case_result_path")
        if embedded and Path(embedded).exists():
            case_result_path = Path(embedded)
        else:
            logger.warning("failure_analysis_skip case=%s reason=no_result_json", case_id)
            return None

    traj = (case_result.get("logs") or {}).get("trajectory")
    trajectory_path = Path(traj) if traj else (case_dir / "trajectory.json")

    output_path = case_dir / OUTPUT_NAME
    status_path = case_dir / STATUS_NAME

    if not agent_available(agent):
        logger.warning("failure_analysis_skip case=%s reason=agent_not_found agent=%s binary=%s", case_id, agent, binary)
        return None

    status_path.write_text(json.dumps({
        "state": "RUNNING", "started_at": _now_iso(), "agent": agent, "model": model,
    }, indent=2))

    prompt = _build_prompt(case_id, case_result_path, trajectory_path, output_path)
    # Grant the agent (claude) Read/Write on the dirs holding the inputs + output.
    allow_dirs = [case_dir]
    if trajectory_path.exists() and trajectory_path.parent != case_dir:
        allow_dirs.append(trajectory_path.parent)
    cmd = _build_cmd(prompt, agent=agent, binary=binary, model=model,
                     reasoning=reasoning, allow_dirs=allow_dirs)

    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        elapsed = time.monotonic() - t0
        status_path.write_text(json.dumps({
            "state": "FAILED", "error": f"timeout after {timeout}s", "elapsed_s": elapsed,
        }, indent=2))
        logger.warning("failure_analysis_timeout case=%s after=%ss", case_id, timeout)
        return None
    except Exception as exc:  # codex missing mid-flight, OS error, etc.
        status_path.write_text(json.dumps({"state": "FAILED", "error": str(exc)}, indent=2))
        logger.warning("failure_analysis_error case=%s error=%s", case_id, exc)
        return None

    elapsed = time.monotonic() - t0

    if proc.returncode != 0:
        tail = (proc.stderr or "")[-STDERR_TAIL_BYTES:]
        status_path.write_text(json.dumps({
            "state": "FAILED", "returncode": proc.returncode, "stderr_tail": tail,
        }, indent=2))
        logger.warning("failure_analysis_rc case=%s rc=%s", case_id, proc.returncode)
        return None

    if not output_path.exists():
        status_path.write_text(json.dumps({
            "state": "FAILED_PARSE", "error": "codex returned rc=0 but wrote no output file",
        }, indent=2))
        logger.warning("failure_analysis_nooutput case=%s", case_id)
        return None

    raw = output_path.read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        status_path.write_text(json.dumps({"state": "FAILED_PARSE", "error": str(exc)}, indent=2))
        logger.warning("failure_analysis_badjson case=%s error=%s", case_id, exc)
        return None

    ok, err = _validate(data)
    if not ok:
        status_path.write_text(json.dumps({"state": "FAILED_PARSE", "error": err}, indent=2))
        logger.warning("failure_analysis_invalid case=%s error=%s", case_id, err)
        return None

    # Normalize the category and attach objective metadata the model must not own.
    evaluation = case_result.get("evaluation") or {}
    data["failure_category"] = normalize_category(data.get("failure_category"))
    data["attribution"] = normalize_attribution(data.get("attribution"))
    data.setdefault("case_id", case_id)
    data["_meta"] = {
        "agent": agent,
        "model": model,
        "elapsed_s": round(elapsed, 2),
        "analyzed_at": _now_iso(),
        "error_type": evaluation.get("error_type"),
        "score": evaluation.get("score"),
        "run_id": run_id or case_result.get("run_id"),
    }
    output_path.write_text(json.dumps(data, indent=2))

    # Success marker is the analysis file's existence; drop the status sidecar.
    if status_path.exists():
        status_path.unlink()

    logger.info("failure_analysis_done case=%s category=%s attribution=%s elapsed=%.1fs",
                case_id, data["failure_category"], data["attribution"], elapsed)
    return data


def _run_agent(prompt: str, *, agent: str, binary: str, model: str, reasoning: str,
               timeout: int, allow_dirs: list[Path] | None = None) -> tuple[bool, str]:
    """Run a one-shot agent invocation. Returns (ok, stderr_tail)."""
    cmd = _build_cmd(prompt, agent=agent, binary=binary, model=model,
                     reasoning=reasoning, allow_dirs=allow_dirs)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f"timeout after {timeout}s"
    except Exception as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or "")[-STDERR_TAIL_BYTES:]
    return True, ""


def summarize_run(run_dir: str | Path, *, run_id: str | None = None) -> dict | None:
    """Aggregate per-case analyses into ``failure_summary.json`` (deterministic
    stats + an LLM narrative). Returns the written summary, or None on skip.

    Never raises. Always writes the deterministic stats even if the codex
    narrative step is unavailable or fails, so the report still answers
    "what issues, what %, who's responsible" from counts alone.
    """
    from .aggregate import aggregate
    from .loader import load_run

    run_dir = Path(run_dir)
    run = load_run(run_dir)
    analyzed = [c for c in run.failed if c.analysis_state == "DONE" and c.analysis]
    if not analyzed:
        logger.info("failure_summary_skip reason=no_analyses run_dir=%s", run_dir)
        return None

    stats = aggregate(run)
    summary: dict[str, Any] = {
        "run_id": run_id or run.run_id,
        "benchmark_id": run.benchmark_id,
        "generated_at": _now_iso(),
        "agent": _agent(),
        "stats": stats,
        "narrative": None,
    }

    agent = _agent()
    binary = _binary(agent)
    model = _model(agent)
    reasoning = _cfg("DBAGENT_FAILURE_CODEX_REASONING", "medium")
    timeout = int(_cfg("DBAGENT_FAILURE_CODEX_TIMEOUT", "600"))

    if agent_available(agent):
        digest = {
            "stats": stats,
            "cases": [
                {
                    "case_id": c.case_id,
                    "failure_category": c.failure_category,
                    "attribution": c.attribution,
                    "summary": (c.analysis or {}).get("summary"),
                    "fix_suggestion": (c.analysis or {}).get("fix_suggestion"),
                }
                for c in analyzed
            ],
        }
        input_path = run_dir / ".failure_summary_input.json"
        output_path = run_dir / ".failure_summary_narrative.json"
        input_path.write_text(json.dumps(digest, indent=2))

        # Code-grounding: let the summary call read harness/benchmark source so
        # its harness/benchmark suggestions cite real file:function locations.
        # On by default; disable for a faster, digest-only summary.
        read_source = _cfg("DBAGENT_FAILURE_SUMMARY_READ_SOURCE", "1").strip().lower() \
            not in {"0", "false", "no", "off"}
        # claude needs explicit dir grants: the scratch input/output in run_dir,
        # plus the source roots when read_source is on.
        allow_dirs = [run_dir]
        if read_source:
            allow_dirs += [HARNESS_ROOT, BENCHMARK_ROOT]
            source_lines = (
                f"harness_root (read for `harness` suggestions):  {HARNESS_ROOT}\n"
                f"benchmark_root (read for `benchmark` suggestions):  {BENCHMARK_ROOT}\n"
                f"You MAY read source files under those roots (read-only) to ground "
                f"the harness/benchmark suggestions and to flag attribution_corrections.\n"
            )
        else:
            source_lines = (
                "Do NOT read source code; base harness/benchmark suggestions on the "
                "digest alone.\n"
            )
        prompt = (
            f"Synthesize a run-level failure summary. Follow the rules and output "
            f"schema in `{SUMMARY_PROMPT_PATH}` exactly.\n\n"
            f"Input digest (read it):  {input_path}\n"
            f"{source_lines}"
            f"Write your JSON summary to:  {output_path}\n"
            f"Write ONLY valid JSON conforming to the schema; no prose or code fences.\n"
        )
        ok, errtail = _run_agent(prompt, agent=agent, binary=binary, model=model,
                                 reasoning=reasoning, timeout=timeout,
                                 allow_dirs=allow_dirs)
        if ok and output_path.exists():
            narrative = _read_json_safe(output_path)
            if isinstance(narrative, dict):
                summary["narrative"] = narrative
            else:
                logger.warning("failure_summary_narrative_badjson run_dir=%s", run_dir)
        else:
            logger.warning("failure_summary_narrative_failed run_dir=%s err=%s", run_dir, errtail)
        # Clean up scratch files.
        for p in (input_path, output_path):
            if p.exists():
                p.unlink()

    (run_dir / SUMMARY_NAME).write_text(json.dumps(summary, indent=2))
    logger.info("failure_summary_written run_dir=%s analyzed=%d top_attr=%s",
                run_dir, len(analyzed), stats.get("top_attribution"))
    return summary


def _read_json_safe(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def backfill_run(run_dir: str | Path, *, force: bool = False,
                 max_workers: int | None = None,
                 case_ids: list[str] | None = None) -> dict[str, Any]:
    """Analyze the failed cases of an EXISTING run, then summarize + bake.

    The after-the-fact path: run the benchmark first (no --failure-analysis),
    then call this to attach analyses without re-running the agent. Idempotent —
    cases already having ``failure_analysis.json`` are skipped unless ``force``.

    Pass ``case_ids`` to restrict analysis to specific case(s); anything
    not in that set is ignored.

    Returns counts so the CLI can report what it did. Explicit invocation, so it
    ignores ``is_enabled()`` (the env/flag switch) — but it still needs the agent CLI.
    """
    from .loader import load_run
    from .render import build_html

    run_dir = Path(run_dir)
    agent = _agent()
    if not agent_available(agent):
        logger.warning("backfill aborted: %s binary not found on PATH", _binary(agent))
        return {"analyzed": 0, "skipped": 0, "failed": 0, "error": f"{agent} not found"}

    run = load_run(run_dir)
    failed_cases = run.failed
    if case_ids is not None:
        wanted = set(case_ids)
        failed_cases = [c for c in failed_cases if c.case_id in wanted]
        missing = wanted - {c.case_id for c in failed_cases}
        if missing:
            logger.warning("backfill: requested case(s) not in this run's failures — skipping: %s", ", ".join(sorted(missing)))
    todo = [c for c in failed_cases if force or c.analysis_state != "DONE"]
    already = len(failed_cases) - len(todo)
    logger.info("backfill_start run_dir=%s failed=%d todo=%d already_done=%d force=%s",
                run_dir, len(failed_cases), len(todo), already, force)

    analyzed = failed = 0
    if todo:
        workers = max_workers or int(_cfg("DBAGENT_FAILURE_MAX_WORKERS", "2"))
        from concurrent.futures import ThreadPoolExecutor

        def _one(case_id: str):
            payload = _read_json_safe(run_dir / "cases" / case_id / "result.json")
            if payload is None:
                return None
            return analyze_case(payload, run_id=run.run_id)

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="backfill") as pool:
            for result in pool.map(_one, [c.case_id for c in todo]):
                if result is not None:
                    analyzed += 1
                else:
                    failed += 1

    # Re-summarize only when something changed (new analyses, --force, or no
    # summary yet) so repeat backfills don't burn a codex call for nothing.
    if analyzed or force or not (run_dir / SUMMARY_NAME).exists():
        summarize_run(run_dir, run_id=run.run_id)
    # Always rebake the HTML — cheap, no codex, keeps the report current.
    try:
        (run_dir / "failure_report.html").write_text(build_html(run_dir), encoding="utf-8")
    except Exception:
        logger.exception("backfill: report bake failed run_dir=%s", run_dir)

    logger.info("backfill_done run_dir=%s analyzed=%d skipped=%d failed=%d",
                run_dir, analyzed, already, failed)
    return {"analyzed": analyzed, "skipped": already, "failed": failed}


def main():
    """CLI: analyze the failed cases of an existing run dir (backfill)."""
    import argparse

    p = argparse.ArgumentParser(
        prog="python -m dbagent.failure_analysis.analyzer",
        description="Backfill failure analysis onto an existing run directory.",
    )
    p.add_argument("--run", type=Path, required=True, help="path to a runs/<run_id> directory")
    p.add_argument("--case", action="append", default=None, metavar="CASE_ID",
                   help="only analyze this failed case (repeatable, or comma-separated). "
                        "Default: all failed cases.")
    p.add_argument("--force", action="store_true",
                   help="re-analyze cases that already have failure_analysis.json")
    p.add_argument("--agent", choices=[AGENT_CODEX, AGENT_CLAUDE], default=None,
                   help="coding-agent CLI to use (default: codex, or $DBAGENT_FAILURE_AGENT)")
    args = p.parse_args()
    if not args.run.exists():
        raise SystemExit(f"run dir not found: {args.run}")
    if args.agent:
        os.environ["DBAGENT_FAILURE_AGENT"] = args.agent

    # Allow both repeated --case and comma-separated values in one flag.
    case_ids = None
    if args.case:
        case_ids = [cid.strip() for item in args.case for cid in item.split(",") if cid.strip()]

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    result = backfill_run(args.run, force=args.force, case_ids=case_ids)
    print(f"backfill done: analyzed={result['analyzed']} skipped={result['skipped']} "
          f"failed={result['failed']}")
    print(f"report: {args.run / 'failure_report.html'}")


if __name__ == "__main__":
    main()
