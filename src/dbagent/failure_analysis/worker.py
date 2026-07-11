"""Cloudflare D1-polled failure-analysis worker.

This worker is intentionally separate from the benchmark runner. It watches the
D1 registry for terminal runs whose failure analysis is pending, downloads the
corresponding WebDAV artifacts, runs a configured analysis-agent CLI in a temp
job directory, uploads the generated analysis artifacts, and updates D1 status
columns.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import logging
import os
import posixpath
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import tomllib
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

from dbagent.failure_analysis import upload as webdav
from dbagent.failure_analysis.analyzer import (
    OUTPUT_NAME,
    PROMPT_PATH,
    SUMMARY_NAME,
    SUMMARY_PROMPT_PATH,
    _validate,
)
from dbagent.failure_analysis.taxonomy import (
    ATTRIBUTIONS,
    CATEGORIES,
    normalize_attribution,
    normalize_category,
)
from dbagent.results.d1_run_store import AnalysisCase, AnalysisRun, D1RunStore

logger = logging.getLogger(__name__)

DEFAULT_POLL_SECONDS = 30
DEFAULT_RUN_LIMIT = 1
DEFAULT_CASE_LIMIT = 5
DEFAULT_AGENT_TIMEOUT = 900
SUMMARY_REQUIRED_FIELDS = ("overall_summary", "key_findings", "suggestions", "recommended_focus")

# --- Success-case analysis (mirror of the failure pipeline) ---------------
SUCCESS_PROMPT_PATH = PROMPT_PATH.parent / "successcase.md"
SUCCESS_SUMMARY_PROMPT_PATH = PROMPT_PATH.parent / "successcasesummary.md"
SUCCESS_OUTPUT_NAME = "success_analysis.json"
SUCCESS_SUMMARY_NAME = "success_summary.json"
SUCCESS_DUMP_NAME = "dump.json"
SUCCESS_CASE_REQUIRED_FIELDS = (
    "success_pattern",
    "guidance_dependency",
    "primary_driver",
    "harness_lever",
    "summary",
    "winning_move",
    "transferable_lesson",
)
SUCCESS_SUMMARY_REQUIRED_FIELDS = (
    "overall_summary",
    "winning_patterns",
    "transferable_fixes",
    "guidance_reliance",
    "recommended_focus",
)
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

AGENT_COPILOT = "copilot"
AGENT_OPENCODE = "opencode"
ANALYSIS_SLOTS = ("gpt", "claude", "deepseek")
CLAUDE_MODEL_ALIASES = {"claude", "anthropic", "fable"}
REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_CONFIG_PATH = REPO_ROOT / "failure_analysis_worker.toml"
DEFAULT_WORKER_LOG_PATH = Path("logs") / "failure_analysis_worker.log"
PERSISTENT_JOB_ROOT = Path("/tmp/dbagent-failure-analysis")
_ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


class ShutdownController:
    """Coordinate graceful and forced worker shutdown across worker threads.

    The first SIGINT/SIGTERM is a drain request: stop claiming new work, let
    active case analyses finish and persist, then reset the run to pending if
    summary generation has not completed. A second signal escalates to force:
    terminate active agent subprocesses so their case/run claims are reset to
    pending by the existing failure paths.
    """

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._force = threading.Event()
        self._lock = threading.Lock()
        self._signal_count = 0
        self._last_signal = "unknown"

    def request(self, signum: int | None = None) -> None:
        with self._lock:
            self._signal_count += 1
            signal_count = self._signal_count
            self._last_signal = _signal_name(signum)

        if signal_count == 1:
            self._stop.set()
            return

        self._stop.set()
        self._force.set()

    def stop_requested(self) -> bool:
        return self._stop.is_set()

    def force_requested(self) -> bool:
        return self._force.is_set()

    def wait(self, timeout: float) -> bool:
        return self._stop.wait(timeout)

    def status(self) -> tuple[int, str, bool, bool]:
        with self._lock:
            return self._signal_count, self._last_signal, self._stop.is_set(), self._force.is_set()


def _signal_name(signum: int | None) -> str:
    if signum is None:
        return "unknown"
    try:
        return signal.Signals(signum).name
    except ValueError:
        return str(signum)


_SHUTDOWN = ShutdownController()

@dataclass(frozen=True, slots=True)
class ProviderConfig:
    key: str
    enabled: bool
    binary: str
    models: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    poll_seconds: float
    run_limit: int
    case_limit: int
    timeout: int
    log_level: str
    log_file: Path
    providers: dict[str, ProviderConfig]
    shared_case_queue: bool = False
    concurrent_agents: bool = False
    analyze_success: bool = True


def _normalize_provider(provider: str) -> str:
    raw = provider.strip().lower().replace("_", "-")
    if raw in {"github-copilot", "copilot-cli"}:
        raw = AGENT_COPILOT
    if raw == "open-code":
        raw = AGENT_OPENCODE
    if raw not in {AGENT_COPILOT, AGENT_OPENCODE}:
        raise ValueError(f"unsupported failure-analysis worker provider: {provider}")
    return raw


def _require_config_table(value: Any, *, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} must be a TOML table")
    return value


def _require_config_str(value: Any, *, path: str) -> str:
    if not isinstance(value, str):
        raise RuntimeError(f"{path} must be a string")
    out = value.strip()
    if not out:
        raise RuntimeError(f"{path} must not be empty")
    return out


def _require_config_bool(value: Any, *, path: str) -> bool:
    if not isinstance(value, bool):
        raise RuntimeError(f"{path} must be a boolean")
    return value


def _require_config_int(value: Any, *, path: str, minimum: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{path} must be an integer")
    if value < minimum:
        raise RuntimeError(f"{path} must be >= {minimum}")
    return value


def _require_config_float(value: Any, *, path: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{path} must be a number")
    out = float(value)
    if out < minimum:
        raise RuntimeError(f"{path} must be >= {minimum}")
    return out


def _require_config_models(value: Any, *, path: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise RuntimeError(f"{path} must be an array of strings")
    out = []
    seen = set()
    for idx, item in enumerate(value):
        model = _require_config_str(item, path=f"{path}[{idx}]")
        key = model.lower()
        if key not in seen:
            seen.add(key)
            out.append(model)
    return tuple(out)


def _resolve_config_path(value: Any, *, path: str, default: Path) -> Path:
    if value is None:
        raw = default
    else:
        raw = Path(_require_config_str(value, path=path))
    if not raw.is_absolute():
        raw = REPO_ROOT / raw
    return raw


def _load_worker_config(path: Path = WORKER_CONFIG_PATH) -> WorkerConfig:
    try:
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
    except FileNotFoundError as exc:
        raise RuntimeError(f"missing failure-analysis worker config: {path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise RuntimeError(f"invalid failure-analysis worker config {path}: {exc}") from exc

    data = _require_config_table(payload, path=str(path))
    providers_table = _require_config_table(data.get("providers"), path="providers")
    providers: dict[str, ProviderConfig] = {}
    defaults = {
        AGENT_COPILOT: ProviderConfig(key=AGENT_COPILOT, enabled=False, binary="copilot", models=()),
        AGENT_OPENCODE: ProviderConfig(key=AGENT_OPENCODE, enabled=False, binary="opencode", models=()),
    }
    providers.update(defaults)

    for raw_name, raw_value in providers_table.items():
        key = _normalize_provider(str(raw_name))
        table = _require_config_table(raw_value, path=f"providers.{raw_name}")
        providers[key] = ProviderConfig(
            key=key,
            enabled=_require_config_bool(table.get("enabled", False), path=f"providers.{raw_name}.enabled"),
            binary=_require_config_str(table.get("binary", defaults[key].binary), path=f"providers.{raw_name}.binary"),
            models=_require_config_models(table.get("models", []), path=f"providers.{raw_name}.models"),
        )

    return WorkerConfig(
        poll_seconds=_require_config_float(data.get("poll_seconds", DEFAULT_POLL_SECONDS), path="poll_seconds", minimum=1.0),
        run_limit=_require_config_int(data.get("run_limit", DEFAULT_RUN_LIMIT), path="run_limit", minimum=1),
        case_limit=_require_config_int(data.get("case_limit", DEFAULT_CASE_LIMIT), path="case_limit", minimum=1),
        timeout=_require_config_int(data.get("timeout", DEFAULT_AGENT_TIMEOUT), path="timeout", minimum=1),
        log_level=_require_config_str(data.get("log_level", "INFO"), path="log_level"),
        log_file=_resolve_config_path(data.get("log_file"), path="log_file", default=DEFAULT_WORKER_LOG_PATH),
        providers=providers,
        shared_case_queue=_require_config_bool(data.get("shared_case_queue", False), path="shared_case_queue"),
        concurrent_agents=_require_config_bool(data.get("concurrent_agents", False), path="concurrent_agents"),
        analyze_success=_require_config_bool(data.get("analyze_success", True), path="analyze_success"),
    )


@dataclass(frozen=True, slots=True)
class AnalysisAgent:
    key: str
    model_name: str | None
    meta_agent: str
    analysis_slot: str
    binary: str
    model: str | None
    timeout: int


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _display_model(agent: AnalysisAgent) -> str:
    return (agent.model or "default").strip() or "default"


def _model_name_for_artifact(model: str | None) -> str | None:
    raw = (model or "").strip()
    if not raw:
        return None
    slug = raw.lower().replace("/", "-")
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"[^a-z0-9._-]+", "-", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-._")
    return slug or None


def _require_model_name(agent: AnalysisAgent) -> str:
    if agent.model_name and agent.model_name.strip():
        return agent.model_name
    raise RuntimeError(
        "remote failure-analysis upload requires an explicit worker model; "
        f"configure models in {WORKER_CONFIG_PATH.name}"
    )


def _artifact_root(run_id: str, artifact_root_path: str | None) -> str:
    return artifact_root_path or webdav.run_root_remote_path(run_id)


def _artifact_path(run_id: str, artifact_root_path: str | None, *parts: str) -> str:
    return posixpath.join(_artifact_root(run_id, artifact_root_path).rstrip("/"), *parts)


def _read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _safe_extract_tar(payload: bytes, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
        for member in archive.getmembers():
            if member.issym() or member.islnk():
                raise ValueError(f"unsafe tar link member: {member.name}")
            target = (dest_dir / member.name).resolve()
            if target != dest_root and dest_root not in target.parents:
                raise ValueError(f"unsafe tar member path: {member.name}")
        archive.extractall(dest_dir)


def _download_required(remote_path: str, dest_path: Path, *, binary: bool = True) -> None:
    payload = webdav.download_file(remote_path)
    if payload is None:
        raise RuntimeError(f"failed to download WebDAV artifact: {remote_path}")
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if binary:
        dest_path.write_bytes(payload)
    else:
        dest_path.write_text(payload.decode("utf-8"), encoding="utf-8")


def _download_run_inputs(run_id: str, artifact_root_path: str | None, job_dir: Path) -> None:
    run_json_path = _artifact_path(run_id, artifact_root_path, "run.json")
    snapshot_path = _artifact_path(run_id, artifact_root_path, "source_snapshot.tar.gz")
    _download_required(run_json_path, job_dir / "run.json", binary=False)
    snapshot_payload = webdav.download_file(snapshot_path)
    if snapshot_payload is None:
        raise RuntimeError(f"failed to download WebDAV artifact: {snapshot_path}")
    _safe_extract_tar(snapshot_payload, job_dir / "source_snapshot")


def _download_case(run_id: str, artifact_root_path: str | None, case_id: str, job_dir: Path) -> Path:
    remote_path = _artifact_path(run_id, artifact_root_path, "cases", f"{case_id}.tar.gz")
    payload = webdav.download_file(remote_path)
    if payload is None:
        raise RuntimeError(f"failed to download WebDAV artifact: {remote_path}")
    case_dir = job_dir / "case"
    _safe_extract_tar(payload, case_dir)
    result_path = case_dir / "result.json"
    if not result_path.is_file():
        raise RuntimeError(f"case archive missing result.json: {remote_path}")
    return case_dir


def _copy_prompt_files(job_dir: Path) -> tuple[Path, Path]:
    prompt_dir = job_dir / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    analysis_prompt = prompt_dir / "analysis.md"
    summary_prompt = prompt_dir / "summary.md"
    shutil.copy2(PROMPT_PATH, analysis_prompt)
    shutil.copy2(SUMMARY_PROMPT_PATH, summary_prompt)
    return analysis_prompt, summary_prompt


def _build_case_prompt(case_id: str, job_dir: Path, case_dir: Path, output_path: Path, prompt_path: Path) -> str:
    trajectory_path = case_dir / "trajectory.json"
    source_snapshot_dir = job_dir / "source_snapshot"
    source_repo_dir = source_snapshot_dir / "dbagent"
    trajectory_line = (
        f"- trajectory JSON: {trajectory_path}\n"
        if trajectory_path.exists()
        else "- trajectory JSON: (not available for this case)\n"
    )
    prompt = (
        f"Analyze failed dbAgent case `{case_id}` and write one structured JSON analysis file.\n\n"
        f"Follow the rubric and output schema in `{prompt_path}` exactly.\n"
        f"Focus only on this job directory: `{job_dir}`.\n"
        f"Only read files inside `{job_dir}`. Do not inspect or rely on any file outside this folder.\n\n"
        f"Focus on this case directory for case-specific artifacts: `{case_dir}`.\n\n"
        f"Inputs:\n"
        f"- run JSON: {job_dir / 'run.json'}\n"
        f"- source snapshot directory: {source_snapshot_dir}\n"
        f"- source snapshot repository root: {source_repo_dir}\n"
        f"- case directory: {case_dir}\n"
        f"- case result JSON: {case_dir / 'result.json'}\n"
        f"{trajectory_line}\n"
        f"Output:\n"
        f"- write ONLY valid JSON to `{output_path}`\n"
        f"- do not write prose, Markdown fences, or commentary outside the JSON file\n"
        f"- do not include `_`-prefixed fields; the worker adds metadata\n"
    )
    logger.info("analysis_case_prompt case_id=%s prompt=%s", case_id, prompt)
    return prompt


def _build_summary_prompt(job_dir: Path, digest_path: Path, output_path: Path, prompt_path: Path) -> str:
    return (
        f"Synthesize a run-level failure summary for dbAgent.\n\n"
        f"Follow the rubric and output schema in `{prompt_path}` exactly.\n"
        f"Focus only on this job directory: `{job_dir}`.\n"
        f"Only read files inside `{job_dir}`. Do not inspect or rely on any file outside this folder.\n"
        f"Read the digest JSON at `{digest_path}`.\n"
        f"You may read source files under `{job_dir / 'source_snapshot'}` to ground harness/benchmark suggestions.\n\n"
        f"Output:\n"
        f"- write ONLY valid JSON to `{output_path}`\n"
        f"- do not write prose, Markdown fences, or commentary outside the JSON file\n"
    )


def _analysis_slot_for_model(model: str) -> str:
    raw = (model or "").strip().lower()
    if not raw:
        raise ValueError("analysis model is required")

    parts = [part for part in re.split(r"[^a-z0-9]+", raw) if part]
    part_set = set(parts)

    if "deepseek" in raw or any(part.startswith("deepseek") for part in part_set):
        return "deepseek"
    if any(alias in raw for alias in CLAUDE_MODEL_ALIASES) or any(
        any(part.startswith(alias) for alias in CLAUDE_MODEL_ALIASES)
        for part in part_set
    ):
        return "claude"
    if (
        "gpt" in raw
        or "openai" in raw
        or any(part.startswith("gpt") for part in part_set)
        or any(part in {"o1", "o3", "o4"} for part in part_set)
    ):
        return "gpt"

    allowed = ", ".join(ANALYSIS_SLOTS)
    raise ValueError(f"unsupported analysis model {model!r}; could not map to analysis slot ({allowed})")


def _selected_agent(provider: str, model: str, *, binary: str, timeout: int) -> AnalysisAgent:
    key = _normalize_provider(provider)
    resolved_model = model.strip()
    if not resolved_model:
        raise RuntimeError(f"failure-analysis worker provider {provider!r} has an empty model entry")
    slot = _analysis_slot_for_model(resolved_model)
    if key == AGENT_OPENCODE:
        return AnalysisAgent(
            key=AGENT_OPENCODE,
            model_name=_model_name_for_artifact(resolved_model),
            meta_agent="opencode",
            analysis_slot=slot,
            binary=binary,
            model=resolved_model,
            timeout=timeout,
        )

    return AnalysisAgent(
        key=AGENT_COPILOT,
        model_name=_model_name_for_artifact(resolved_model),
        meta_agent="github_copilot",
        analysis_slot=slot,
        binary=binary,
        model=resolved_model,
        timeout=timeout,
    )


def _validate_unique_analysis_slots(agents: list[AnalysisAgent]) -> None:
    seen: dict[str, str] = {}
    for agent in agents:
        prior = seen.get(agent.analysis_slot)
        if prior is not None:
            raise ValueError(
                f"analysis models {prior!r} and {agent.model!r} both map to D1 slot {agent.analysis_slot!r}; "
                "configure at most one model per slot"
            )
        seen[agent.analysis_slot] = agent.model or ""


def _build_agents(config: WorkerConfig) -> list[AnalysisAgent]:
    agents: list[AnalysisAgent] = []
    for key in (AGENT_COPILOT, AGENT_OPENCODE):
        provider = config.providers.get(key)
        if provider is None or not provider.enabled:
            continue
        if not provider.models:
            raise RuntimeError(f"failure-analysis worker provider {key!r} is enabled but has no models configured")
        for model in provider.models:
            agents.append(_selected_agent(provider=key, model=model, binary=provider.binary, timeout=config.timeout))
    if not agents:
        raise RuntimeError("failure-analysis worker config must enable at least one provider with at least one model")
    return agents


def _preflight_agents(agents: list[AnalysisAgent]) -> None:
    for agent in agents:
        if shutil.which(agent.binary) is None:
            raise RuntimeError(f"failure-analysis worker binary not found on PATH: {agent.binary}")


def _configure_logging(config: WorkerConfig) -> None:
    config.log_file.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )
    formatter.converter = time.gmtime
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    file_handler = logging.FileHandler(config.log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        handlers=[stream_handler, file_handler],
        force=True,
    )


def _install_shutdown_signal_handlers() -> None:
    def _handler(signum: int, _frame: object) -> None:
        _SHUTDOWN.request(signum)

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)


def _log_shutdown_notice(action: str) -> None:
    signal_count, signal_name, stop, force = _SHUTDOWN.status()
    if not stop:
        return
    logger.warning(
        "failure_analysis_worker_shutdown_observed signal=%s count=%d mode=%s action=%s",
        signal_name,
        signal_count,
        "force" if force else "graceful",
        action,
    )


def _create_job_dir(prefix: str) -> Path:
    PERSISTENT_JOB_ROOT.mkdir(parents=True, exist_ok=True)
    job_dir = Path(tempfile.mkdtemp(prefix=prefix, dir=PERSISTENT_JOB_ROOT))
    logger.info("analysis_job_dir_created path=%s", job_dir)
    return job_dir


def _copilot_cmd(prompt: str, job_dir: Path, *, agent: AnalysisAgent) -> list[str]:
    cmd = [
        agent.binary,
        "-C",
        str(job_dir),
        "--add-dir",
        str(job_dir),
        "--yolo",
        "--no-custom-instructions",
        "--no-remote",
        "--no-remote-export",
        "--no-color",
        "--stream",
        "off",
        "--log-level",
        "info",
        "-s",
    ]
    if agent.model:
        cmd += ["--model", agent.model]
    cmd += ["-p", prompt]
    return cmd

def _opencode_cmd(prompt: str, job_dir: Path, *, agent: AnalysisAgent) -> list[str]:
    cmd = [
        agent.binary,
        "run",
        "--dir",
        str(job_dir),
        "--log-level",
        "INFO",
        "--dangerously-skip-permissions",
    ]
    if agent.model:
        cmd += ["--model", agent.model]
    cmd.append(prompt)
    return cmd


def _agent_cmd(prompt: str, job_dir: Path, *, agent: AnalysisAgent) -> list[str]:
    if agent.key == AGENT_OPENCODE:
        return _opencode_cmd(prompt, job_dir, agent=agent)
    return _copilot_cmd(prompt, job_dir, agent=agent)


def _drain_agent_stdout(stream: Any, *, prefix: str) -> None:
    try:
        for raw_line in iter(stream.readline, ""):
            clean_line = _ANSI_RE.sub("", raw_line).rstrip()
            if not clean_line:
                continue
            logger.info("%s %s", prefix, clean_line)
    except Exception:
        logger.exception("%s stdout_drain_failed", prefix)


def _terminate_agent_process(proc: subprocess.Popen[str], *, prefix: str, force: bool) -> None:
    if proc.poll() is not None:
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    logger.warning("%s terminate signal=%s pid=%s", prefix, _signal_name(sig), proc.pid)
    try:
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, sig)
        elif force:
            proc.kill()
        else:
            proc.terminate()
    except ProcessLookupError:
        return
    except Exception:
        logger.exception("%s terminate_failed signal=%s pid=%s", prefix, _signal_name(sig), proc.pid)


def _stop_agent_process(proc: subprocess.Popen[str], *, prefix: str) -> None:
    _terminate_agent_process(proc, prefix=prefix, force=False)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _terminate_agent_process(proc, prefix=prefix, force=True)
        proc.wait()


def _run_agent(prompt: str, job_dir: Path, *, agent: AnalysisAgent, target: str) -> tuple[bool, str, float]:
    cmd = _agent_cmd(prompt, job_dir, agent=agent)
    started = time.monotonic()
    prefix = f"[{agent.key} {target}]"
    logger.info(
        "%s spawn cwd=%s cmd=%s",
        prefix,
        job_dir,
        cmd,
    )
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=job_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
    except Exception as exc:
        return False, str(exc), time.monotonic() - started

    assert proc.stdout is not None
    # Drain stdout on a background thread so logs stay streaming while the main
    # thread enforces a timeout over the full child-process lifetime.
    reader = threading.Thread(
        target=_drain_agent_stdout,
        args=(proc.stdout,),
        kwargs={"prefix": prefix},
        name=f"failure-analysis-{agent.key}-{target}",
        daemon=True,
    )
    reader.start()

    returncode: int | None = None
    graceful_shutdown_logged = False
    try:
        deadline = started + agent.timeout
        while True:
            if _SHUTDOWN.force_requested():
                _log_shutdown_notice("terminate_active_agent")
                _stop_agent_process(proc, prefix=prefix)
                elapsed = time.monotonic() - started
                return False, "shutdown requested", elapsed
            if _SHUTDOWN.stop_requested() and not graceful_shutdown_logged:
                _log_shutdown_notice("wait_for_active_agent")
                logger.warning(
                    "%s graceful_shutdown_waiting pid=%s action=let_active_agent_finish "
                    "note=send_SIGINT_or_SIGTERM_again_to_force_reset_pending",
                    prefix,
                    proc.pid,
                )
                graceful_shutdown_logged = True

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _stop_agent_process(proc, prefix=prefix)
                elapsed = time.monotonic() - started
                return False, f"timeout after {agent.timeout}s", elapsed

            try:
                returncode = proc.wait(timeout=min(1.0, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
    finally:
        proc.stdout.close()
        reader.join(timeout=1.0)
        if reader.is_alive():
            logger.warning("%s stdout_drain_thread_still_alive", prefix)

    elapsed = time.monotonic() - started
    if returncode != 0:
        return False, f"{agent.key} exited {returncode}", elapsed
    return True, "", elapsed


def _normalize_case_analysis(
    data: dict[str, Any],
    *,
    run_id: str,
    case_id: str,
    agent: AnalysisAgent,
    elapsed_s: float,
) -> dict[str, Any]:
    data["failure_category"] = normalize_category(data.get("failure_category"))
    data["attribution"] = normalize_attribution(data.get("attribution"))
    data["failed_phase"] = _norm_choice(
        data.get("failed_phase"), ("phase1", "phase2"), "n/a"
    )
    data.setdefault("case_id", case_id)
    data["_meta"] = {
        "agent": agent.meta_agent,
        "model": _display_model(agent),
        "analysis_channel": agent.analysis_slot,
        "analysis_slot": agent.analysis_slot,
        "elapsed_s": round(elapsed_s, 2),
        "analyzed_at": _now_iso(),
        "run_id": run_id,
    }
    return data


def _build_case_record(
    *,
    state: str,
    agent: AnalysisAgent,
    analysis: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "state": state,
        "error": error,
        "updated_at": _now_iso(),
        "model": _display_model(agent),
        "analysis": analysis,
        "_meta": {
            "agent": agent.meta_agent,
            "analysis_channel": agent.analysis_slot,
            "analysis_slot": agent.analysis_slot,
            "model_name": _require_model_name(agent),
        },
    }


def _read_remote_json_artifact(remote_path: str) -> dict[str, Any] | None:
    payload = webdav.download_file(remote_path)
    if payload is None:
        return None
    text = payload.decode("utf-8", errors="replace").strip()
    if not text:
        # Empty remote file (e.g. a 0-byte artifact from an interrupted/partial
        # write under eventual consistency). Treat as absent so the upsert can
        # recreate it instead of failing the whole case forever.
        logger.warning("remote_json_artifact_empty path=%s treating_as_absent", remote_path)
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("remote_json_artifact_corrupt path=%s error=%s treating_as_absent", remote_path, exc)
        return None
    if not isinstance(data, dict):
        logger.warning("remote_json_artifact_not_object path=%s treating_as_absent", remote_path)
        return None
    return data


def _merge_case_record_document(
    existing: dict[str, Any] | None,
    *,
    case_id: str,
    model_name: str,
    record: dict[str, Any],
) -> dict[str, Any]:
    document = dict(existing or {})
    analyses = document.get("analyses")
    if analyses is None:
        analyses = {}
    if not isinstance(analyses, dict):
        raise RuntimeError(f"invalid case failure-analysis artifact for case {case_id}: analyses is not an object")
    analyses = dict(analyses)
    analyses[model_name] = record
    document["case_id"] = case_id
    document["updated_at"] = _now_iso()
    document["analyses"] = analyses
    return document


# The per-case/summary artifacts are shared objects: several analysis channels
# (one per model) upsert their own entry into the same JSON document via a
# read-modify-write. The WebDAV backend (Koofr) is eventually consistent and
# ignores conditional writes (`If-Match`), so a stale read during one channel's
# merge can silently drop a sibling model's entry. `_atomic_upsert_record`
# hardens the read-modify-write: it unions two reads so sibling entries are not
# lost to a single stale read, then reads back and retries until it confirms its
# own entry actually persisted.
_UPSERT_VERIFY_ATTEMPTS = 4
_UPSERT_VERIFY_BACKOFF_SECONDS = 1.5


def _union_documents(
    a: dict[str, Any] | None,
    b: dict[str, Any] | None,
    *,
    container_key: str,
) -> dict[str, Any] | None:
    """Merge two reads of the same artifact, preserving every entry in the
    ``container_key`` sub-object. ``b`` (the later read) wins on key conflicts."""
    if a is None:
        return b
    if b is None:
        return a
    base = dict(b)
    ca = a.get(container_key)
    cb = b.get(container_key)
    ca = ca if isinstance(ca, dict) else {}
    cb = cb if isinstance(cb, dict) else {}
    merged_container = dict(ca)
    merged_container.update(cb)
    base[container_key] = merged_container
    return base


def _atomic_upsert_record(
    remote_path: str,
    *,
    container_key: str,
    entry_key: str,
    expected_entry: dict[str, Any],
    merge_fn: Callable[[dict[str, Any] | None], dict[str, Any]],
    label: str,
) -> bool:
    """Read-modify-write ``container_key[entry_key]`` under eventual consistency.

    Unions two reads before merging (so a single stale read cannot drop a sibling
    entry), then verifies the write by reading it back and confirming our entry is
    present and equal to what we wrote. Retries with backoff on failure."""
    last_err = "unknown"
    for attempt in range(1, _UPSERT_VERIFY_ATTEMPTS + 1):
        first = _read_remote_json_artifact(remote_path)
        second = _read_remote_json_artifact(remote_path)
        existing = _union_documents(first, second, container_key=container_key)
        merged = merge_fn(existing)
        if webdav.put_file(
            remote_path,
            json.dumps(merged, indent=2).encode("utf-8"),
            content_type="application/json",
        ):
            readback = _read_remote_json_artifact(remote_path)
            container = readback.get(container_key) if isinstance(readback, dict) else None
            persisted = container.get(entry_key) if isinstance(container, dict) else None
            if persisted == expected_entry:
                if attempt > 1:
                    logger.info("upsert_verify_ok label=%s path=%s attempts=%d", label, remote_path, attempt)
                return True
            last_err = "readback_entry_missing_or_mismatch"
        else:
            last_err = "put_failed"
        if attempt < _UPSERT_VERIFY_ATTEMPTS:
            logger.warning(
                "upsert_verify_retry label=%s path=%s attempt=%d/%d error=%s",
                label, remote_path, attempt, _UPSERT_VERIFY_ATTEMPTS, last_err,
            )
            time.sleep(_UPSERT_VERIFY_BACKOFF_SECONDS * (2 ** (attempt - 1)))
    logger.warning(
        "upsert_verify_failed label=%s path=%s attempts=%d error=%s",
        label, remote_path, _UPSERT_VERIFY_ATTEMPTS, last_err,
    )
    return False


def _upsert_case_record(
    run_id: str,
    artifact_root_path: str | None,
    case_id: str,
    model_name: str,
    payload: dict[str, Any],
) -> bool:
    remote_path = webdav.analysis_case_output_remote_path(run_id, case_id, artifact_root_path)
    return _atomic_upsert_record(
        remote_path,
        container_key="analyses",
        entry_key=model_name,
        expected_entry=payload,
        merge_fn=lambda existing: _merge_case_record_document(
            existing, case_id=case_id, model_name=model_name, record=payload
        ),
        label=f"case:{case_id}:{model_name}",
    )


def analyze_case_with_agent(
    *,
    run_id: str,
    artifact_root_path: str | None,
    case: AnalysisCase,
    agent: AnalysisAgent,
) -> dict[str, Any]:
    job_dir = _create_job_dir(
        prefix=f"dbagent-analysis-{agent.key}-{agent.model_name}-{run_id}-{case.case_id}-"
    )
    analysis_prompt, _ = _copy_prompt_files(job_dir)
    _download_run_inputs(run_id, artifact_root_path, job_dir)
    case_dir = _download_case(run_id, artifact_root_path, case.case_id, job_dir)
    output_path = case_dir / OUTPUT_NAME
    prompt = _build_case_prompt(case.case_id, job_dir, case_dir, output_path, analysis_prompt)
    ok, error, elapsed = _run_agent(prompt, job_dir, agent=agent, target=f"case:{case.case_id}")
    if not ok:
        raise RuntimeError(error)
    raw = _read_json(output_path)
    if raw is None:
        raise RuntimeError(f"{agent.key} did not write valid JSON to {output_path}")
    valid, validation_error = _validate(raw)
    if not valid:
        raise RuntimeError(validation_error)
    return _normalize_case_analysis(raw, run_id=run_id, case_id=case.case_id, agent=agent, elapsed_s=elapsed)


def _distribution(counts: Counter, total: int, meta: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    out = []
    for key, count in counts.most_common():
        entry = meta.get(key, {})
        out.append(
            {
                "key": key,
                "label": entry.get("label", key),
                "color": entry.get("color", "#475569"),
                "count": count,
                "pct": round(100.0 * count / total, 1) if total else 0.0,
            }
        )
    return out


def _build_digest(run_id: str, analyses: list[dict[str, Any]], target_count: int) -> dict[str, Any]:
    cat_counts: Counter = Counter()
    attr_counts: Counter = Counter()
    for analysis in analyses:
        cat_counts[normalize_category(analysis.get("failure_category"))] += 1
        attr_counts[normalize_attribution(analysis.get("attribution"))] += 1
    analyzed_count = len(analyses)
    return {
        "stats": {
            "failed_cases": target_count,
            "analyzed_cases": analyzed_count,
            "pending_cases": max(target_count - analyzed_count, 0),
            "coverage_pct": round(100.0 * analyzed_count / target_count, 1) if target_count else 0.0,
            "by_category": _distribution(cat_counts, analyzed_count, CATEGORIES),
            "by_attribution": _distribution(attr_counts, analyzed_count, ATTRIBUTIONS),
            "top_category": cat_counts.most_common(1)[0][0] if cat_counts else None,
            "top_attribution": attr_counts.most_common(1)[0][0] if attr_counts else None,
        },
        "cases": [
            {
                "case_id": analysis.get("case_id"),
                "failure_category": normalize_category(analysis.get("failure_category")),
                "attribution": normalize_attribution(analysis.get("attribution")),
                "summary": analysis.get("summary"),
                "fix_suggestion": analysis.get("fix_suggestion"),
            }
            for analysis in analyses
        ],
        "models": sorted({str(((analysis.get("_meta") or {}).get("model") or "default")) for analysis in analyses}),
        "run_id": run_id,
    }


def _extract_completed_analysis(data: Any, *, case_id: str, model_name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid completed failure-analysis artifact for case {case_id}: payload is not a JSON object")
    analyses = data.get("analyses")
    if not isinstance(analyses, dict):
        raise RuntimeError(f"invalid completed failure-analysis artifact for case {case_id}: analyses is not an object")
    entry = analyses.get(model_name)
    if not isinstance(entry, dict):
        raise RuntimeError(f"missing failure-analysis entry for case {case_id} model {model_name}")
    state = str(entry.get("state") or "").upper()
    if state != "COMPLETED":
        raise RuntimeError(f"incomplete failure-analysis artifact for case {case_id} model {model_name}: state={state or 'UNKNOWN'}")
    candidate = entry.get("analysis")
    if not isinstance(candidate, dict):
        raise RuntimeError(f"invalid completed failure-analysis artifact for case {case_id} model {model_name}: missing analysis object")

    valid, validation_error = _validate(candidate)
    if not valid:
        raise RuntimeError(f"invalid completed failure-analysis artifact for case {case_id}: {validation_error}")
    return candidate


def _download_completed_case_analyses(
    *,
    run_id: str,
    artifact_root_path: str | None,
    cases: list[AnalysisCase],
    model_name: str,
) -> list[dict[str, Any]]:
    analyses: list[dict[str, Any]] = []
    for case in cases:
        remote_path = webdav.analysis_case_output_remote_path(run_id, case.case_id, artifact_root_path)
        data = _read_remote_json_artifact(remote_path)
        if data is None:
            raise RuntimeError(f"missing completed failure-analysis artifact for case {case.case_id}")
        analyses.append(_extract_completed_analysis(data, case_id=case.case_id, model_name=model_name))
    return analyses


def _validate_summary(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "summary output is not a JSON object"
    missing = [field for field in SUMMARY_REQUIRED_FIELDS if field not in data]
    if missing:
        return False, f"missing summary fields: {', '.join(missing)}"
    focus = data.get("recommended_focus")
    if focus not in ATTRIBUTIONS:
        data["recommended_focus"] = normalize_attribution(focus)
    return True, ""


def _merge_summary_document(
    existing: dict[str, Any] | None,
    *,
    run_id: str,
    model_name: str,
    summary: dict[str, Any],
) -> dict[str, Any]:
    document = dict(existing or {})
    summaries = document.get("summaries")
    if summaries is None:
        summaries = {}
    if not isinstance(summaries, dict):
        raise RuntimeError("invalid failure_summary.json: summaries is not an object")
    summaries = dict(summaries)
    summaries[model_name] = summary
    document["run_id"] = run_id
    document["generated_at"] = _now_iso()
    document["summaries"] = summaries
    return document


def _upsert_summary_record(
    run_id: str,
    artifact_root_path: str | None,
    *,
    model_name: str,
    summary: dict[str, Any],
) -> bool:
    remote_path = webdav.analysis_summary_remote_path(run_id, artifact_root_path)
    return _atomic_upsert_record(
        remote_path,
        container_key="summaries",
        entry_key=model_name,
        expected_entry=summary,
        merge_fn=lambda existing: _merge_summary_document(
            existing, run_id=run_id, model_name=model_name, summary=summary
        ),
        label=f"summary:{run_id}:{model_name}",
    )


def summarize_run_with_agent(
    *,
    run_id: str,
    artifact_root_path: str | None,
    completed_cases: list[AnalysisCase],
    target_count: int,
    agent: AnalysisAgent,
) -> dict[str, Any] | None:
    if not completed_cases:
        return None
    analyses = _download_completed_case_analyses(
        run_id=run_id,
        artifact_root_path=artifact_root_path,
        cases=completed_cases,
        model_name=agent.model_name,
    )
    digest = _build_digest(run_id, analyses, target_count)
    job_dir = _create_job_dir(prefix=f"dbagent-analysis-summary-{agent.key}-{agent.model_name}-{run_id}-")
    _, summary_prompt = _copy_prompt_files(job_dir)
    _download_run_inputs(run_id, artifact_root_path, job_dir)
    digest_path = job_dir / ".failure_summary_input.json"
    output_path = job_dir / SUMMARY_NAME
    _write_json(digest_path, digest)
    prompt = _build_summary_prompt(job_dir, digest_path, output_path, summary_prompt)
    ok, error, elapsed = _run_agent(prompt, job_dir, agent=agent, target=f"summary:{run_id}")
    if not ok:
        raise RuntimeError(error)
    raw = _read_json(output_path)
    valid, validation_error = _validate_summary(raw)
    if not valid:
        raise RuntimeError(validation_error)
    summary = {
        "run_id": run_id,
        "benchmark_id": None,
        "generated_at": _now_iso(),
        "agent": agent.meta_agent,
        "model_name": _require_model_name(agent),
        "models": digest["models"],
        "stats": digest["stats"],
        "narrative": raw,
        "_meta": {
            "elapsed_s": round(elapsed, 2),
            "model": _display_model(agent),
            "analysis_channel": agent.analysis_slot,
            "analysis_slot": agent.analysis_slot,
        },
    }
    return summary


def _copy_success_prompt_files(job_dir: Path) -> tuple[Path, Path]:
    prompt_dir = job_dir / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    case_prompt = prompt_dir / "successcase.md"
    summary_prompt = prompt_dir / "successcasesummary.md"
    shutil.copy2(SUCCESS_PROMPT_PATH, case_prompt)
    shutil.copy2(SUCCESS_SUMMARY_PROMPT_PATH, summary_prompt)
    return case_prompt, summary_prompt


def _build_success_case_prompt(case_id: str, job_dir: Path, case_dir: Path, output_path: Path, prompt_path: Path) -> str:
    trajectory_path = case_dir / "trajectory.json"
    source_snapshot_dir = job_dir / "source_snapshot"
    source_repo_dir = source_snapshot_dir / "dbagent"
    trajectory_line = (
        f"- trajectory JSON: {trajectory_path}\n"
        if trajectory_path.exists()
        else "- trajectory JSON: (not available for this case)\n"
    )
    prompt = (
        f"Analyze passing dbAgent case `{case_id}` and write one structured JSON success-analysis file.\n\n"
        f"Follow the rubric and output schema in `{prompt_path}` exactly.\n"
        f"Focus only on this job directory: `{job_dir}`.\n"
        f"Only read files inside `{job_dir}`. Do not inspect or rely on any file outside this folder.\n\n"
        f"Focus on this case directory for case-specific artifacts: `{case_dir}`.\n\n"
        f"Inputs:\n"
        f"- run JSON: {job_dir / 'run.json'}\n"
        f"- source snapshot directory: {source_snapshot_dir}\n"
        f"- source snapshot repository root: {source_repo_dir}\n"
        f"- case directory: {case_dir}\n"
        f"- case result JSON: {case_dir / 'result.json'}\n"
        f"{trajectory_line}\n"
        f"Output:\n"
        f"- write ONLY valid JSON to `{output_path}`\n"
        f"- do not write prose, Markdown fences, or commentary outside the JSON file\n"
        f"- do not include `_`-prefixed fields; the worker adds metadata\n"
    )
    logger.info("success_case_prompt case_id=%s prompt=%s", case_id, prompt)
    return prompt


def _build_success_summary_prompt(job_dir: Path, dump_path: Path, output_path: Path, prompt_path: Path) -> str:
    return (
        f"Synthesize a run-level success summary for dbAgent.\n\n"
        f"Follow the rubric and output schema in `{prompt_path}` exactly.\n"
        f"Focus only on this job directory: `{job_dir}`.\n"
        f"Only read files inside `{job_dir}`. Do not inspect or rely on any file outside this folder.\n"
        f"Read the digest JSON (dump.json) at `{dump_path}`.\n"
        f"You may read source files under `{job_dir / 'source_snapshot'}` (harness_root) to ground prompt/tool/evaluator fixes.\n\n"
        f"Output:\n"
        f"- write ONLY valid JSON to `{output_path}`\n"
        f"- do not write prose, Markdown fences, or commentary outside the JSON file\n"
    )


def _norm_choice(value: Any, allowed: tuple[str, ...], default: str) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in allowed else default


def _validate_success_case(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "success analysis output is not a JSON object"
    missing = [field for field in SUCCESS_CASE_REQUIRED_FIELDS if field not in data]
    if missing:
        return False, f"missing success-analysis fields: {', '.join(missing)}"
    return True, ""


def _normalize_success_case_analysis(
    data: dict[str, Any],
    *,
    run_id: str,
    case_id: str,
    agent: AnalysisAgent,
    elapsed_s: float,
) -> dict[str, Any]:
    data["success_pattern"] = _norm_choice(data.get("success_pattern"), SUCCESS_PATTERNS, "other")
    data["guidance_dependency"] = _norm_choice(data.get("guidance_dependency"), GUIDANCE_LEVELS, "none")
    data["primary_driver"] = _norm_choice(data.get("primary_driver"), SUCCESS_DRIVERS, "agent")
    data["harness_lever"] = _norm_choice(data.get("harness_lever"), HARNESS_LEVERS, "none")
    data.setdefault("case_id", case_id)
    data["_meta"] = {
        "agent": agent.meta_agent,
        "model": _display_model(agent),
        "analysis_channel": agent.analysis_slot,
        "analysis_slot": agent.analysis_slot,
        "elapsed_s": round(elapsed_s, 2),
        "analyzed_at": _now_iso(),
        "run_id": run_id,
    }
    return data


def _upsert_success_case_record(
    run_id: str,
    artifact_root_path: str | None,
    case_id: str,
    model_name: str,
    payload: dict[str, Any],
) -> bool:
    remote_path = webdav.success_analysis_case_output_remote_path(run_id, case_id, artifact_root_path)
    return _atomic_upsert_record(
        remote_path,
        container_key="analyses",
        entry_key=model_name,
        expected_entry=payload,
        merge_fn=lambda existing: _merge_case_record_document(
            existing, case_id=case_id, model_name=model_name, record=payload
        ),
        label=f"success_case:{case_id}:{model_name}",
    )


def _extract_completed_success_analysis(data: Any, *, case_id: str, model_name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid completed success-analysis artifact for case {case_id}: payload is not a JSON object")
    analyses = data.get("analyses")
    if not isinstance(analyses, dict):
        raise RuntimeError(f"invalid completed success-analysis artifact for case {case_id}: analyses is not an object")
    entry = analyses.get(model_name)
    if not isinstance(entry, dict):
        raise RuntimeError(f"missing success-analysis entry for case {case_id} model {model_name}")
    state = str(entry.get("state") or "").upper()
    if state != "COMPLETED":
        raise RuntimeError(f"incomplete success-analysis artifact for case {case_id} model {model_name}: state={state or 'UNKNOWN'}")
    candidate = entry.get("analysis")
    if not isinstance(candidate, dict):
        raise RuntimeError(f"invalid completed success-analysis artifact for case {case_id} model {model_name}: missing analysis object")
    valid, validation_error = _validate_success_case(candidate)
    if not valid:
        raise RuntimeError(f"invalid completed success-analysis artifact for case {case_id}: {validation_error}")
    return candidate


def analyze_success_case_with_agent(
    *,
    run_id: str,
    artifact_root_path: str | None,
    case: AnalysisCase,
    agent: AnalysisAgent,
) -> dict[str, Any]:
    job_dir = _create_job_dir(
        prefix=f"dbagent-success-{agent.key}-{agent.model_name}-{run_id}-{case.case_id}-"
    )
    case_prompt, _ = _copy_success_prompt_files(job_dir)
    _download_run_inputs(run_id, artifact_root_path, job_dir)
    case_dir = _download_case(run_id, artifact_root_path, case.case_id, job_dir)
    output_path = case_dir / SUCCESS_OUTPUT_NAME
    prompt = _build_success_case_prompt(case.case_id, job_dir, case_dir, output_path, case_prompt)
    ok, error, elapsed = _run_agent(prompt, job_dir, agent=agent, target=f"success:{case.case_id}")
    if not ok:
        raise RuntimeError(error)
    raw = _read_json(output_path)
    if raw is None:
        raise RuntimeError(f"{agent.key} did not write valid JSON to {output_path}")
    valid, validation_error = _validate_success_case(raw)
    if not valid:
        raise RuntimeError(validation_error)
    return _normalize_success_case_analysis(raw, run_id=run_id, case_id=case.case_id, agent=agent, elapsed_s=elapsed)


def _build_success_digest(run_id: str, analyses: list[dict[str, Any]], target_count: int) -> dict[str, Any]:
    pattern_counts: Counter = Counter()
    guidance_counts: Counter = Counter()
    driver_counts: Counter = Counter()
    lever_counts: Counter = Counter()
    for analysis in analyses:
        pattern_counts[_norm_choice(analysis.get("success_pattern"), SUCCESS_PATTERNS, "other")] += 1
        guidance_counts[_norm_choice(analysis.get("guidance_dependency"), GUIDANCE_LEVELS, "none")] += 1
        driver_counts[_norm_choice(analysis.get("primary_driver"), SUCCESS_DRIVERS, "agent")] += 1
        lever_counts[_norm_choice(analysis.get("harness_lever"), HARNESS_LEVERS, "none")] += 1
    analyzed_count = len(analyses)
    return {
        "stats": {
            "passed_cases": target_count,
            "analyzed_cases": analyzed_count,
            "pending_cases": max(target_count - analyzed_count, 0),
            "coverage_pct": round(100.0 * analyzed_count / target_count, 1) if target_count else 0.0,
            "by_success_pattern": _distribution(pattern_counts, analyzed_count, {}),
            "by_guidance_dependency": _distribution(guidance_counts, analyzed_count, {}),
            "by_primary_driver": _distribution(driver_counts, analyzed_count, {}),
            "by_harness_lever": _distribution(lever_counts, analyzed_count, {}),
            "top_success_pattern": pattern_counts.most_common(1)[0][0] if pattern_counts else None,
            "top_guidance_dependency": guidance_counts.most_common(1)[0][0] if guidance_counts else None,
            "top_harness_lever": lever_counts.most_common(1)[0][0] if lever_counts else None,
            "guidance_high_pct": round(100.0 * guidance_counts.get("high", 0) / analyzed_count, 1) if analyzed_count else 0.0,
            "actionable_lever_pct": round(100.0 * (analyzed_count - lever_counts.get("none", 0)) / analyzed_count, 1) if analyzed_count else 0.0,
        },
        "cases": [
            {
                "case_id": analysis.get("case_id"),
                "success_pattern": _norm_choice(analysis.get("success_pattern"), SUCCESS_PATTERNS, "other"),
                "guidance_dependency": _norm_choice(analysis.get("guidance_dependency"), GUIDANCE_LEVELS, "none"),
                "primary_driver": _norm_choice(analysis.get("primary_driver"), SUCCESS_DRIVERS, "agent"),
                "harness_lever": _norm_choice(analysis.get("harness_lever"), HARNESS_LEVERS, "none"),
                "summary": analysis.get("summary"),
                "transferable_lesson": analysis.get("transferable_lesson"),
            }
            for analysis in analyses
        ],
        "models": sorted({str(((analysis.get("_meta") or {}).get("model") or "default")) for analysis in analyses}),
        "run_id": run_id,
    }


def _validate_success_summary(data: Any) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "success summary output is not a JSON object"
    missing = [field for field in SUCCESS_SUMMARY_REQUIRED_FIELDS if field not in data]
    if missing:
        return False, f"missing success-summary fields: {', '.join(missing)}"
    data["recommended_focus"] = _norm_choice(data.get("recommended_focus"), SUCCESS_FOCUS, "prompt")
    return True, ""


def _upsert_success_summary_record(
    run_id: str,
    artifact_root_path: str | None,
    *,
    model_name: str,
    summary: dict[str, Any],
) -> bool:
    remote_path = webdav.success_analysis_summary_remote_path(run_id, artifact_root_path)
    return _atomic_upsert_record(
        remote_path,
        container_key="summaries",
        entry_key=model_name,
        expected_entry=summary,
        merge_fn=lambda existing: _merge_summary_document(
            existing, run_id=run_id, model_name=model_name, summary=summary
        ),
        label=f"success_summary:{run_id}:{model_name}",
    )


def summarize_success_run_with_agent(
    *,
    run_id: str,
    artifact_root_path: str | None,
    analyses: list[dict[str, Any]],
    target_count: int,
    agent: AnalysisAgent,
) -> dict[str, Any] | None:
    if not analyses:
        return None
    digest = _build_success_digest(run_id, analyses, target_count)
    job_dir = _create_job_dir(prefix=f"dbagent-success-summary-{agent.key}-{agent.model_name}-{run_id}-")
    _, summary_prompt = _copy_success_prompt_files(job_dir)
    _download_run_inputs(run_id, artifact_root_path, job_dir)
    dump_path = job_dir / SUCCESS_DUMP_NAME
    output_path = job_dir / SUCCESS_SUMMARY_NAME
    _write_json(dump_path, digest)
    # Publish the digest (dump.json) alongside the summary so it is inspectable.
    webdav.put_file(
        webdav.success_analysis_dump_remote_path(run_id, artifact_root_path),
        json.dumps(digest, indent=2).encode("utf-8"),
        content_type="application/json",
    )
    prompt = _build_success_summary_prompt(job_dir, dump_path, output_path, summary_prompt)
    ok, error, elapsed = _run_agent(prompt, job_dir, agent=agent, target=f"success-summary:{run_id}")
    if not ok:
        raise RuntimeError(error)
    raw = _read_json(output_path)
    valid, validation_error = _validate_success_summary(raw)
    if not valid:
        raise RuntimeError(validation_error)
    summary = {
        "run_id": run_id,
        "benchmark_id": None,
        "generated_at": _now_iso(),
        "agent": agent.meta_agent,
        "model_name": _require_model_name(agent),
        "models": digest["models"],
        "stats": digest["stats"],
        "narrative": raw,
        "_meta": {
            "elapsed_s": round(elapsed, 2),
            "model": _display_model(agent),
            "analysis_channel": agent.analysis_slot,
            "analysis_slot": agent.analysis_slot,
        },
    }
    ok = _upsert_success_summary_record(
        run_id,
        artifact_root_path,
        model_name=_require_model_name(agent),
        summary=summary,
    )
    if not ok:
        raise RuntimeError("failed to upload run success-analysis summary")
    return summary


def _ensure_success_case_analysis(
    *,
    run_id: str,
    artifact_root_path: str | None,
    case: AnalysisCase,
    agent: AnalysisAgent,
) -> dict[str, Any]:
    """Analyze one passing case, or reuse an already-uploaded analysis (dedup)."""
    remote_path = webdav.success_analysis_case_output_remote_path(run_id, case.case_id, artifact_root_path)
    existing = _read_remote_json_artifact(remote_path)
    if existing is not None:
        try:
            reused = _extract_completed_success_analysis(existing, case_id=case.case_id, model_name=agent.model_name)
            logger.info(
                "success_case_reused provider=%s slot=%s model=%s run_id=%s case_id=%s",
                agent.key, agent.analysis_slot, _display_model(agent), run_id, case.case_id,
            )
            return reused
        except RuntimeError:
            pass  # not completed for this model yet -> (re)analyze
    logger.info(
        "success_case_start provider=%s slot=%s model=%s run_id=%s case_id=%s",
        agent.key, agent.analysis_slot, _display_model(agent), run_id, case.case_id,
    )
    analysis = analyze_success_case_with_agent(
        run_id=run_id, artifact_root_path=artifact_root_path, case=case, agent=agent
    )
    if not _upsert_success_case_record(
        run_id,
        artifact_root_path,
        case.case_id,
        agent.model_name,
        _build_case_record(state="COMPLETED", agent=agent, analysis=analysis),
    ):
        raise RuntimeError("failed to upload success-analysis output")
    logger.info(
        "success_case_done provider=%s slot=%s model=%s run_id=%s case_id=%s",
        agent.key, agent.analysis_slot, _display_model(agent), run_id, case.case_id,
    )
    return analysis


def process_run_success(
    store: D1RunStore,
    run: AnalysisRun,
    *,
    agent: AnalysisAgent,
    case_limit: int | None = None,
) -> None:
    """Best-effort success-case analysis pipeline, parallel to the failure one.

    Selects this run's passing cases, analyzes each (deduped via WebDAV so it is
    safe to re-enter), and once every passing case is analyzed for this model,
    builds ``dump.json`` and the run-level ``success_summary.json``. Never raises
    into the failure flow.
    """
    try:
        cases = store.list_analysis_cases(
            run_id=run.run_id,
            analysis_channel=agent.analysis_slot,
            statuses=("passed",),
        )
    except Exception:
        logger.exception("success_run_list_cases_failed slot=%s run_id=%s", agent.analysis_slot, run.run_id)
        return
    passed = [case for case in cases if case.status == "passed"]
    if not passed:
        logger.info("success_run_no_passed_cases slot=%s run_id=%s", agent.analysis_slot, run.run_id)
        return

    logger.info(
        "success_run_start provider=%s slot=%s model=%s run_id=%s passed=%d",
        agent.key, agent.analysis_slot, _display_model(agent), run.run_id, len(passed),
    )
    analyses: list[dict[str, Any]] = []
    had_failure = False
    lock = threading.Lock()

    def _one(case: AnalysisCase) -> dict[str, Any] | None:
        nonlocal had_failure
        if _SHUTDOWN.stop_requested():
            return None
        try:
            return _ensure_success_case_analysis(
                run_id=run.run_id, artifact_root_path=run.artifact_root_path, case=case, agent=agent
            )
        except Exception as exc:
            logger.warning(
                "success_case_failed provider=%s slot=%s model=%s run_id=%s case_id=%s error=%s",
                agent.key, agent.analysis_slot, _display_model(agent), run.run_id, case.case_id, exc,
            )
            with lock:
                had_failure = True
            return None

    max_workers = max(1, min(case_limit or 1, len(passed)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        for result in executor.map(_one, passed):
            if result is not None:
                analyses.append(result)

    if had_failure or len(analyses) < len(passed):
        logger.info(
            "success_run_partial slot=%s run_id=%s analyzed=%d passed=%d had_failure=%s",
            agent.analysis_slot, run.run_id, len(analyses), len(passed), had_failure,
        )
        return

    try:
        summarize_success_run_with_agent(
            run_id=run.run_id,
            artifact_root_path=run.artifact_root_path,
            analyses=analyses,
            target_count=len(passed),
            agent=agent,
        )
    except Exception:
        logger.exception("success_run_summary_failed slot=%s run_id=%s", agent.analysis_slot, run.run_id)
        return

    logger.info(
        "success_run_done provider=%s slot=%s model=%s run_id=%s passed=%d",
        agent.key, agent.analysis_slot, _display_model(agent), run.run_id, len(passed),
    )


def process_case(store: D1RunStore, run: AnalysisRun, case: AnalysisCase, *, agent: AnalysisAgent, shared_case_queue: bool = False) -> bool:
    if _SHUTDOWN.stop_requested():
        _log_shutdown_notice("skip_case_before_claim")
        logger.info(
            "analysis_case_skip_shutdown slot=%s run_id=%s case_id=%s",
            agent.analysis_slot,
            run.run_id,
            case.case_id,
        )
        return False

    claimed = store.claim_case_analysis(
        run_id=run.run_id,
        case_id=case.case_id,
        analysis_channel=agent.analysis_slot,
        dedup=shared_case_queue,
    )
    if claimed is None:
        logger.info("analysis_case_claim_skip slot=%s run_id=%s case_id=%s", agent.analysis_slot, run.run_id, case.case_id)
        return True

    try:
        logger.info("analysis_case_start provider=%s slot=%s model=%s run_id=%s case_id=%s status=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, case.case_id, claimed.status)
        _upsert_case_record(
            run.run_id,
            run.artifact_root_path,
            case.case_id,
            agent.model_name,
            _build_case_record(state="RUNNING", agent=agent),
        )
        analysis = analyze_case_with_agent(run_id=run.run_id, artifact_root_path=run.artifact_root_path, case=claimed, agent=agent)
        if not _upsert_case_record(
            run.run_id,
            run.artifact_root_path,
            case.case_id,
            agent.model_name,
            _build_case_record(state="COMPLETED", agent=agent, analysis=analysis),
        ):
            raise RuntimeError("failed to upload failure-analysis output")
        store.set_case_analysis_status(run_id=run.run_id, case_id=case.case_id, status="completed", analysis_channel=agent.analysis_slot)
        logger.info("analysis_case_done provider=%s slot=%s model=%s run_id=%s case_id=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, case.case_id)
        return True
    except Exception as exc:
        logger.warning("analysis_case_failed_reset_pending provider=%s slot=%s model=%s run_id=%s case_id=%s error=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, case.case_id, exc)
        _upsert_case_record(
            run.run_id,
            run.artifact_root_path,
            case.case_id,
            agent.model_name,
            _build_case_record(state="PENDING", agent=agent, error=str(exc)),
        )
        store.set_case_analysis_status(run_id=run.run_id, case_id=case.case_id, status="pending", analysis_channel=agent.analysis_slot)
        return False


def process_run(
    store: D1RunStore,
    run: AnalysisRun,
    *,
    agent: AnalysisAgent,
    case_limit: int | None = None,
    shared_case_queue: bool = False,
    analyze_success: bool = True,
) -> bool:
    if _SHUTDOWN.stop_requested():
        _log_shutdown_notice("skip_run_before_claim")
        logger.info("analysis_run_skip_shutdown slot=%s run_id=%s", agent.analysis_slot, run.run_id)
        return False

    # Claim the run-level slot first so only one slot/model advances this run at a time.
    if not store.claim_run_analysis(run_id=run.run_id, analysis_channel=agent.analysis_slot):
        logger.info("analysis_run_claim_skip slot=%s run_id=%s", agent.analysis_slot, run.run_id)
        return False

    logger.info("analysis_run_start provider=%s slot=%s model=%s run_id=%s artifact_root=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, run.artifact_root_path)
    try:
        if _SHUTDOWN.stop_requested():
            _log_shutdown_notice("reset_run_after_claim")
            store.set_run_analysis_status(run_id=run.run_id, status="pending", analysis_channel=agent.analysis_slot)
            logger.info("analysis_run_shutdown_after_claim_reset_pending slot=%s run_id=%s", agent.analysis_slot, run.run_id)
            return False

        pending_cases = store.list_analysis_cases(
            run_id=run.run_id,
            analysis_channel=agent.analysis_slot,
            analysis_status="pending",
            limit=case_limit,
            exclude_sibling_completed=shared_case_queue,
        )
        had_failure = False
        if pending_cases:
            max_workers = min(case_limit or 1, len(pending_cases))
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_case = {}
                for case in pending_cases:
                    if _SHUTDOWN.stop_requested():
                        _log_shutdown_notice("stop_submitting_cases")
                        had_failure = True
                        logger.info(
                            "analysis_case_submission_stop_shutdown slot=%s run_id=%s next_case_id=%s",
                            agent.analysis_slot,
                            run.run_id,
                            case.case_id,
                        )
                        break
                    future_to_case[executor.submit(process_case, store, run, case, agent=agent, shared_case_queue=shared_case_queue)] = case.case_id
                for future in concurrent.futures.as_completed(future_to_case):
                    case_id = future_to_case[future]
                    try:
                        if not future.result():
                            had_failure = True
                    except Exception:
                        had_failure = True
                        logger.exception(
                            "analysis_case_unhandled_exception provider=%s slot=%s model=%s run_id=%s case_id=%s",
                            agent.key,
                            agent.analysis_slot,
                            _display_model(agent),
                            run.run_id,
                            case_id,
                        )

        target_cases = store.list_analysis_cases(run_id=run.run_id, analysis_channel=agent.analysis_slot)
        if not target_cases:
            if analyze_success:
                process_run_success(store, run, agent=agent, case_limit=case_limit)
            store.set_run_analysis_status(run_id=run.run_id, status="completed", analysis_channel=agent.analysis_slot)
            logger.info("analysis_run_done_no_targets slot=%s run_id=%s", agent.analysis_slot, run.run_id)
            return True

        completed_cases = [case for case in target_cases if case.analysis_status == "completed"]
        if shared_case_queue:
            # Under a shared/deduped queue each case is analyzed by exactly one
            # model, so this channel's own completed count will not reach the full
            # target. The run is done once no case is left unanalyzed by ANY model.
            coverage_incomplete = store.count_unanalyzed_cases(run_id=run.run_id) > 0
        else:
            coverage_incomplete = len(completed_cases) < len(target_cases)
        if had_failure or coverage_incomplete:
            store.set_run_analysis_status(run_id=run.run_id, status="pending", analysis_channel=agent.analysis_slot)
            logger.info(
                "analysis_run_reset_pending provider=%s slot=%s model=%s run_id=%s completed=%d target=%d had_failure=%s",
                agent.key,
                agent.analysis_slot,
                _display_model(agent),
                run.run_id,
                len(completed_cases),
                len(target_cases),
                had_failure,
            )
            return False

        if _SHUTDOWN.stop_requested():
            _log_shutdown_notice("reset_run_before_summary")
            store.set_run_analysis_status(run_id=run.run_id, status="pending", analysis_channel=agent.analysis_slot)
            logger.info(
                "analysis_run_shutdown_before_summary_reset_pending provider=%s slot=%s model=%s run_id=%s completed=%d target=%d",
                agent.key,
                agent.analysis_slot,
                _display_model(agent),
                run.run_id,
                len(completed_cases),
                len(target_cases),
            )
            return False

        # In shared-queue mode a model summarizes only the subset it analyzed; if
        # it analyzed nothing (the sibling covered the run), skip the summary.
        summary_target = len(completed_cases) if shared_case_queue else len(target_cases)
        if completed_cases:
            summary = summarize_run_with_agent(
                run_id=run.run_id,
                artifact_root_path=run.artifact_root_path,
                completed_cases=completed_cases,
                target_count=summary_target,
                agent=agent,
            )
            if summary is not None:
                ok = _upsert_summary_record(
                    run.run_id,
                    run.artifact_root_path,
                    model_name=_require_model_name(agent),
                    summary=summary,
                )
                if not ok:
                    raise RuntimeError("failed to upload run failure-analysis summary")

        if analyze_success:
            process_run_success(store, run, agent=agent, case_limit=case_limit)
        store.set_run_analysis_status(run_id=run.run_id, status="completed", analysis_channel=agent.analysis_slot)
        logger.info("analysis_run_done provider=%s slot=%s model=%s run_id=%s target_cases=%d completed=%d shared_queue=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, len(target_cases), len(completed_cases), shared_case_queue)
        return True
    except Exception as exc:
        logger.warning("analysis_run_failed_reset_pending provider=%s slot=%s model=%s run_id=%s error=%s", agent.key, agent.analysis_slot, _display_model(agent), run.run_id, exc)
        store.set_run_analysis_status(run_id=run.run_id, status="pending", analysis_channel=agent.analysis_slot)
        return False


def poll_once(
    store: D1RunStore,
    *,
    run_limit: int,
    case_limit: int | None,
    run_id: str | None,
    agent: AnalysisAgent,
    shared_case_queue: bool = False,
    run_ids: list[str] | None = None,
    analyze_success: bool = True,
) -> int:
    runs = store.list_pending_analysis_runs(
        analysis_channel=agent.analysis_slot, limit=run_limit, run_id=run_id, run_ids=run_ids
    )
    processed = 0
    for run in runs:
        if _SHUTDOWN.stop_requested():
            _log_shutdown_notice("stop_polling_runs")
            logger.info("analysis_poll_stop_shutdown slot=%s", agent.analysis_slot)
            break
        process_run(store, run, agent=agent, case_limit=case_limit, shared_case_queue=shared_case_queue, analyze_success=analyze_success)
        processed += 1
    return processed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m dbagent.failure_analysis.worker",
        description="Poll Cloudflare D1 and run provider-backed failure analysis for WebDAV-backed dbAgent runs.",
    )
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    parser.add_argument("--run", dest="run_id", default=None, help="only process this run_id")
    parser.add_argument(
        "--no-reclaim",
        dest="no_reclaim",
        action="store_true",
        help=(
            "skip the startup reset of stale 'running' analysis markers. Use this for a "
            "SECONDARY/priority worker started while another worker is already running, so "
            "its boot does not clobber the primary worker's in-flight 'running' states. The "
            "primary worker should keep reclaim ON so it self-heals after a hard kill."
        ),
    )
    parser.add_argument(
        "--runs",
        dest="runs",
        default=None,
        help=(
            "comma-separated allow-list of run_ids to restrict this worker to (priority "
            "worker). Both models are spread across ONLY these runs; the worker idles once "
            "they are all fully analyzed. Combine with --no-reclaim for a secondary worker."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = _load_worker_config()
    _configure_logging(config)
    _install_shutdown_signal_handlers()
    load_dotenv(override=True)

    run_ids = [r.strip() for r in args.runs.split(",")] if args.runs else None
    run_ids = [r for r in run_ids if r] if run_ids else None

    store = D1RunStore.from_env()
    if store is None:
        raise SystemExit("Cloudflare D1 credentials are not configured")
    if not webdav.is_enabled():
        raise SystemExit("WebDAV credentials are not configured")

    agents = _build_agents(config)
    _validate_unique_analysis_slots(agents)
    _preflight_agents(agents)
    for agent in agents:
        _require_model_name(agent)
    case_limit = config.case_limit
    provider_models: dict[str, list[str]] = {}
    for agent in agents:
        provider_models.setdefault(agent.key, []).append(_display_model(agent))
    provider_summary = ", ".join(
        f"{provider}(models={','.join(models)})"
        for provider, models in provider_models.items()
    )
    logger.info(
        "failure_analysis_worker_start providers=%s once=%s run_id=%s run_ids=%s poll_seconds=%s run_limit=%s case_limit=%s shared_case_queue=%s concurrent_agents=%s analyze_success=%s no_reclaim=%s config_path=%s log_path=%s",
        provider_summary,   
        args.once,
        args.run_id,
        ",".join(run_ids) if run_ids else None,
        config.poll_seconds,
        config.run_limit,
        case_limit,
        config.shared_case_queue,
        config.concurrent_agents,
        config.analyze_success,
        args.no_reclaim,
        WORKER_CONFIG_PATH,
        config.log_file,
    )
    if args.no_reclaim:
        logger.info("failure_analysis_worker_reclaim_skipped reason=--no-reclaim")
    else:
        try:
            reclaimed = store.reclaim_stale_running_analysis()
            if reclaimed["runs"] or reclaimed["cases"]:
                logger.info(
                    "failure_analysis_worker_reclaimed_stale_running runs=%d cases=%d",
                    reclaimed["runs"],
                    reclaimed["cases"],
                )
        except Exception:
            logger.exception("failure_analysis_worker_reclaim_stale_running_failed")
    while True:
        if _SHUTDOWN.stop_requested():
            _log_shutdown_notice("exit_before_poll")
            logger.info("failure_analysis_worker_shutdown_complete reason=before_poll")
            return

        try:
            count = 0
            if config.concurrent_agents and len(agents) > 1:
                # Run each model's poll in its own thread so the two models
                # analyze DIFFERENT runs at the same time (each blocks on its own
                # batch). Run-level and case-level claims are atomic in D1, so the
                # threads cannot double-claim the same run/case.
                with concurrent.futures.ThreadPoolExecutor(max_workers=len(agents)) as executor:
                    futures = {
                        executor.submit(
                            poll_once,
                            store,
                            run_limit=config.run_limit,
                            case_limit=case_limit,
                            run_id=args.run_id,
                            agent=agent,
                            shared_case_queue=config.shared_case_queue,
                            run_ids=run_ids,
                            analyze_success=config.analyze_success,
                        ): agent.analysis_slot
                        for agent in agents
                    }
                    for future in concurrent.futures.as_completed(futures):
                        slot = futures[future]
                        try:
                            count += future.result()
                        except Exception:
                            logger.exception("failure_analysis_worker_agent_poll_failed slot=%s", slot)
            else:
                for agent in agents:
                    if _SHUTDOWN.stop_requested():
                        _log_shutdown_notice("stop_agent_loop")
                        logger.info("failure_analysis_worker_agent_loop_stop_shutdown")
                        break
                    count += poll_once(
                        store,
                        run_limit=config.run_limit,
                        case_limit=case_limit,
                        run_id=args.run_id,
                        agent=agent,
                        shared_case_queue=config.shared_case_queue,
                        run_ids=run_ids,
                        analyze_success=config.analyze_success,
                    )
            logger.info("failure_analysis_worker_poll_done runs_seen=%d", count)
        except Exception:
            logger.exception("failure_analysis_worker_poll_failed")

        if args.once:
            return
        if _SHUTDOWN.stop_requested():
            _log_shutdown_notice("exit_after_poll")
            logger.info("failure_analysis_worker_shutdown_complete reason=after_poll")
            return
        _SHUTDOWN.wait(max(config.poll_seconds, 1.0))


if __name__ == "__main__":
    main()
