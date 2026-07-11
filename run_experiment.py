#!/usr/bin/env python3
"""CLI for running text2sql benchmarks through the dbAgent framework."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
SRC_ROOT = WORKDIR / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

# Load .env before importing dbagent: dataset sources (e.g. the BIRD-Interact
# Google Drive IDs) are read from os.environ at import time and MUST come from
# .env — there are no hardcoded defaults in this tree.
from dotenv import load_dotenv

load_dotenv(WORKDIR / ".env", override=True)

from dbagent.benchmarks import build_benchmark, default_split
from dbagent.config import AgentConfig, ConnectorConfig, ExperimentConfig, RunnerConfig
from dbagent.runners.case_selection import load_indices_file, parse_indices
from dbagent.runners.rerun import ERROR_TYPE_FILTERS, RERUN_MODES


def _resolve_max_steps(benchmark_id: str, max_steps: int | None) -> int | None:
    if max_steps is not None:
        return max_steps
    if benchmark_id == "spider2-dbt":
        return 30
    return None


def _indices_argument(value: str) -> list[int]:
    try:
        return parse_indices(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _indices_file_argument(value: str) -> list[int]:
    try:
        return load_indices_file(Path(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def run_experiment(args: argparse.Namespace) -> Path:
    from dbagent.runners.experiment_runner import ExperimentRunner

    # The analyzer reads its agent CLI from the environment; the flag just sets it.
    if getattr(args, "failure_agent", None):
        os.environ["DBAGENT_FAILURE_AGENT"] = args.failure_agent

    resume_run_id = None
    if args.resume:
        # Re-run an existing run in place (configs come from run.json)
        from dbagent.runners.rerun import load_run_config

        rerun = load_run_config(Path(args.resume))
        connector_config = rerun.connector_config
        agent_config = rerun.agent_config
        experiment_config = rerun.experiment_config
        benchmark = build_benchmark(WORKDIR, rerun.benchmark_id, experiment_config.split)
        resume_run_id = rerun.run_id
    else:
        connector_config = ConnectorConfig(
            provider=args.provider,
            model=args.model,
            api_key_env=args.api_key_env,
            base_url=args.base_url,
            user_sim_model=args.user_sim_model,
        )
        agent_config = AgentConfig(
            yolo=True,
            max_steps=_resolve_max_steps(args.benchmark, args.max_steps),
        )
        # Resolve the split before building the benchmark: bird-interact sets up
        # split-specific data and a split-specific Postgres image at construction.
        split = args.split if args.split is not None else default_split(args.benchmark)
        benchmark = build_benchmark(WORKDIR, args.benchmark, split)
        indices = args.indices if args.indices is not None else args.indices_file
        experiment_config = ExperimentConfig(
            split=split,
            limit=args.num_samples,
            indices=indices,
            tag=args.tag,
        )

    runner = ExperimentRunner(
        workdir=WORKDIR,
        benchmark=benchmark,
        connector_config=connector_config,
        agent_config=agent_config,
        experiment_config=experiment_config,
        runner_config=RunnerConfig(
            output_root=WORKDIR / "runs",
            verbose=args.verbose,
            throttle_secs=args.throttle_secs,
            failure_analysis=args.failure_analysis,
            success_analysis=args.success_analysis,
            upload_cases=not args.no_upload_cases,
            concurrency=args.concurrency,
            memory=args.memory,
            embedding_model=args.embedding_model,
            embedding_base_url=args.embedding_base_url,
            memory_top_k=args.memory_top_k,
            memory_tau=args.memory_tau,
        ),
    )
    result = runner.run(resume_run_id=resume_run_id, rerun_mode=args.rerun_mode, rerun_error_type=args.filter)
    predictions_path = Path(result["predictions_path"])
    passed = result["passed_cases"]
    total = result["total_cases"]
    accuracy = result["accuracy"]
    print(f"Done. {passed}/{total} success (accuracy: {accuracy:.2f}%)")
    print(f"Predictions saved to {predictions_path}")
    print(f"Run dir: {result['run_dir']}")
    print(f"Run record: {result['run_path']}")
    # Failure report only exists when analysis ran (--failure-analysis). When it
    # didn't, point at how to generate it after the fact.
    report_path = Path(result["run_dir"]) / "failure_report.html"
    if report_path.exists():
        print(f"Failure report: {report_path}")
        _offer_viewer(Path(result["run_dir"]))
    else:
        print(f"Failure report: not generated (re-run with --failure-analysis, "
              f"or backfill: python -m dbagent.failure_analysis.analyzer --run {result['run_dir']})")
    return predictions_path


def _offer_viewer(run_dir: Path, port: int = 8770) -> None:
    """Prompt to launch the read-only viewer server for the failure report.

    Skipped silently when stdin is not interactive (e.g. running under nohup /
    a pipe), so it never blocks an unattended run. Blocks on serve_forever once
    started; Ctrl-C stops the server and returns.
    """
    try:
        answer = input("Start the failure-analysis viewer server? [y/N] ").strip().lower()
    except EOFError:
        return  # non-interactive: don't block
    if answer not in {"y", "yes"}:
        return
    from dbagent.failure_analysis.serve import BIND, make_server

    server = make_server(run_dir, port)
    print(f"Serving failure report at http://{BIND}:{port}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run text2sql experiment via the dbAgent framework")
    parser.add_argument("--resume", type=str, default=None, help="Re-run an existing run dir in place; config is read from its run.json")
    parser.add_argument("--rerun-mode", type=str, default="incomplete", choices=RERUN_MODES, help="Which cases to re-run (only with --resume): incomplete=missing result.json, failed=also re-run non-passing cases")
    parser.add_argument("--filter", type=str, default=None, choices=ERROR_TYPE_FILTERS, help="Sub-filter for --rerun-mode failed: re-run only failures of this error_type (incomplete cases are still re-run)")
    parser.add_argument("--benchmark", type=str, default="bird", help="Benchmark to run")
    parser.add_argument("--split", type=str, default=None, help="Dataset split override (e.g. bird-interact-a: lite/full; defaults per benchmark)")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--num_samples", type=int, default=None, help="Limit to the first N samples")
    selection.add_argument(
        "--indices",
        type=_indices_argument,
        default=None,
        help="Run zero-based dataset indices separated by commas (for example: 0,5,12)",
    )
    selection.add_argument(
        "--indices-file",
        type=_indices_file_argument,
        default=None,
        help="Read zero-based dataset indices separated by commas or whitespace from a file",
    )
    parser.add_argument("--tag", type=str, default=None, help="Free-form label appended to the run_id (e.g. han_bird_2026-07-03-16-37-51_{tag}) and recorded in run.json")
    parser.add_argument("--verbose", action="store_true", help="Print each question result")
    parser.add_argument("--failure-analysis", action="store_true", help="Analyze failed cases with a coding-agent CLI during the run (off unless passed; writes failure_analysis.json + failure_report.html). Backfill an existing run instead with: python -m dbagent.failure_analysis.analyzer --run <dir>")
    parser.add_argument("--success-analysis", action="store_true", help="Analyze PASSED cases with a coding-agent CLI after the run to mine harness-optimization levers (off unless passed; writes success_analysis.json + success_dump.json + success_summary.json). Backfill an existing run instead with: python -m dbagent.failure_analysis.success_analyzer --run <dir>")
    parser.add_argument("--failure-agent", choices=["codex", "claude"], default=None, help="Coding-agent CLI for failure analysis: codex (default) or claude (Claude Code). Sets $DBAGENT_FAILURE_AGENT.")
    parser.add_argument("--no-upload-cases", action="store_true", help="Disable automatic WebDAV uploads for this run even when WEBDAV_URL/WEBDAV_USER/WEBDAV_PASSWORD are configured.")
    parser.add_argument("--throttle_secs", type=float, default=0.0, help="Seconds to sleep between cases (e.g. 4.0 for Gemini free tier)")
    parser.add_argument("--concurrency", type=int, default=1, help="Number of cases to run in parallel (default 1 = sequential). Bounded by provider rate limits.")
    parser.add_argument("--memory", action="store_true", help="Enable per-run exemplar memory: retrieve verified {question -> SQL} exemplars from earlier passing cases (same db_id) and inject them into the prompt. Requires --concurrency 1.")
    parser.add_argument("--embedding_model", type=str, default="st:Qwen/Qwen3-Embedding-0.6B", help="Embedding model for --memory (host-side). 'st:<hf_id>' = local sentence-transformers (default Qwen3-Embedding-0.6B); otherwise a litellm model string, e.g. 'ollama/<name>' against an embeddings-enabled Ollama.")
    parser.add_argument("--embedding_base_url", type=str, default="http://localhost:11434", help="Base URL for the embedding model (host-side). Default: local Ollama.")
    parser.add_argument("--memory_top_k", type=int, default=3, help="Max exemplars to retrieve per case (--memory).")
    parser.add_argument("--memory_tau", type=float, default=0.60, help="Min cosine similarity to inject an exemplar / count as 'fired' (--memory). Calibrated for Qwen3-Embedding-0.6B on BIRD.")
    parser.add_argument("--provider", type=str, default="gemini", help="Connector provider, e.g. gemini")
    parser.add_argument("--model", type=str, default="gemini/gemini-flash-latest", help="Model name for the selected provider")
    parser.add_argument("--api_key_env", type=str, default="GEMINI_API_KEY", help="Environment variable containing the API key")
    parser.add_argument("--user_sim_model", type=str, default=None, help="Model for the BIRD-Interact ask() user simulator (defaults to --model)")
    parser.add_argument("--max_steps", type=int, default=None, help="Maximum number of agent turns per case")
    parser.add_argument(
        "--base_url",
        type=str,
        default=None,
        help="Provider base URL.",
    )
    run_experiment(parser.parse_args())
