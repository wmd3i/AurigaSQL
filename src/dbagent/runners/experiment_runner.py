from __future__ import annotations

import getpass
import json
import time
import logging
import os
import signal
import shutil
import shlex
import threading
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import asdict
from functools import partial
from datetime import datetime, timezone
from pathlib import Path
import traceback

from dbagent.benchmarks.base import BenchmarkAdapter, TaskSpec
from dbagent.config import AgentConfig, ConnectorConfig, ExperimentConfig, RunnerConfig
from dbagent.connectors.litellm_connector import LiteLLMConnector
from dbagent.connectors.model_configs import (
    get_model_config,
    get_model_config_env_vars,
    has_model_config,
    rewrite_api_base_for_runtime,
    rewrite_model_config_base_urls,
)
from dbagent.results.models import CaseResult
from dbagent.results.writer import ResultWriter
from dbagent.runners.case_selection import select_cases
from dbagent.runners.ipc import IpcResponder
from dbagent.runners.container_service import CONTAINER_WORKSPACE, ContainerService
from dbagent.runners.rerun import plan_rerun
from dbagent.runners.run_state import RunState

logger = logging.getLogger(__name__)


def _sanitize_run_tag(tag: str | None) -> str:
    """Normalize a user-supplied run tag into a filesystem-safe run_id suffix.

    Keeps alphanumerics, dot, dash, and underscore; collapses any other run of
    characters (spaces, slashes, etc.) into a single underscore. Returns "" when
    the tag is empty or has no usable characters.
    """
    if not tag:
        return ""
    import re

    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", tag.strip())
    return cleaned.strip("_")


class ExperimentRunner:
    def __init__(
        self,
        *,
        workdir: Path,  # Agent working directory (project root).
        benchmark: BenchmarkAdapter,
        connector_config: ConnectorConfig,
        agent_config: AgentConfig,
        experiment_config: ExperimentConfig,
        runner_config: RunnerConfig,
    ) -> None:
        self.workdir = workdir
        self.benchmark = benchmark
        self.connector_config = connector_config
        self.agent_config = agent_config
        self.experiment_config = experiment_config
        self.runner_config = runner_config
        self.connector = LiteLLMConnector(connector_config)

        # Background pool for failure analysis: we fire each
        # failed case into this pool to avoid blocking the benchmark loop.
        self._failure_pool = ThreadPoolExecutor(
            max_workers=int(os.environ.get("DBAGENT_FAILURE_MAX_WORKERS", "2")),
            thread_name_prefix="failure-analysis",
        )
        self._failure_futures: list[Future] = []
        # Background pool for per-case upload: each finished case's dir is archived
        # and uploaded to WebDAV storage without blocking the loop.
        self._upload_pool = ThreadPoolExecutor(
            max_workers=int(os.environ.get("DBAGENT_UPLOAD_MAX_WORKERS", "3")),
            thread_name_prefix="case-upload",
        )
        self._upload_futures: list[Future] = []
        # Rolling deterministic tallies for the mid-run summary (no LLM).
        self._error_type_counts: dict[str, int] = {}
        self._seen_cases = 0
        self._passed_cases = 0
        self._run_registry = None
        self._run_registry_warned = False
        # Per-run exemplar memory (created in run() when runner_config.memory is set).
        self._memory = None

    def run(self, resume_run_id: str | None = None, rerun_mode: str = "incomplete", rerun_error_type: str | None = None) -> dict[str, Path | str]:
        started_at = datetime.now(timezone.utc)
        if resume_run_id:
            run_id = resume_run_id
        else:
            username = getpass.getuser()
            run_id = f"{username}_{self.benchmark.benchmark_id}_{started_at.strftime('%Y-%m-%d-%H-%M-%S')}"
            tag = _sanitize_run_tag(self.experiment_config.tag)
            if tag:
                run_id = f"{run_id}_{tag}"
        run_dir = self.runner_config.output_root / run_id
        writer = ResultWriter(run_dir)
        self._memory = self._build_memory_store(run_dir) if self.runner_config.memory else None
        run_log_path = run_dir / "run.log"
        run_log_handler, previous_log_level = self._attach_run_log_handler(run_log_path)
        run_docker_service = None
        previous_signal_handlers = self._install_termination_handlers()

        try:
            docker_scope = self._resolve_docker_scope()
            docker_image = self._resolve_docker_image()
            self._ensure_docker_image(docker_image)
            logger.info(
                "run_started run_id=%s benchmark=%s split=%s limit=%s indices=%s provider=%s model=%s output_dir=%s",
                run_id,
                self.benchmark.benchmark_id,
                self.experiment_config.split,
                self.experiment_config.limit,
                self.experiment_config.indices,
                self.connector.provider_name,
                self.connector.model_name,
                run_dir,
            )
            start_run = getattr(self.benchmark, "start_run", None)
            if callable(start_run):
                logger.info("benchmark_start_run benchmark=%s run_dir=%s", self.benchmark.benchmark_id, run_dir)
                start_run(run_dir)

            if docker_scope == "run":
                docker_host_workspace = self._resolve_docker_host_workspace()
                run_docker_service = ContainerService(
                    image=docker_image,
                    case_id=run_id,
                )
                logger.info(
                    "docker_container_starting scope=run run_id=%s image=%s workspace=%s",
                    run_id,
                    docker_image,
                    docker_host_workspace,
                )
                run_docker_service.start(
                    docker_host_workspace,
                    extra_mounts=[run_dir],
                    env=self._docker_env(),
                    code_src=self.workdir / "src",
                )
                logger.info(
                    "docker_container_started scope=run run_id=%s container=%s",
                    run_id,
                    run_docker_service.container_name,
                )

            run_state = RunState(
                run_id=run_id,
                run_dir=run_dir,
                benchmark_id=self.benchmark.benchmark_id,
                split=self.experiment_config.split,
                connector_config=self.connector_config,
                agent_config=self.agent_config,
                experiment_config=self.experiment_config,
                started_at=started_at,
                failure_analysis=self.runner_config.failure_analysis,
                success_analysis=self.runner_config.success_analysis,
            )
            run_path = run_state.initialize(writer)
            logger.info("run_record_written path=%s", self._format_path(run_path, run_dir))
            self._register_run_upload(run_id=run_id, run_dir=run_dir)

            all_cases = self.benchmark.iter_cases(
                split=self.experiment_config.split,
                limit=None,
            )
            dataset_cases = len(all_cases)
            if self.experiment_config.indices is not None:
                cases = select_cases(all_cases, self.experiment_config.indices)
            elif self.experiment_config.limit is not None:
                cases = all_cases[: self.experiment_config.limit]
            else:
                cases = all_cases
            logger.info("cases_loaded count=%d", len(cases))

            if resume_run_id:
                # Re-run: execute only the selected subset and carry forward the
                # already-good results so finalize() covers the full dataset.
                plan = plan_rerun(run_dir, cases, rerun_mode, rerun_error_type)
                for payload in plan.carry_forward:
                    run_state.record_case_result(payload)
                cases_to_run = plan.to_run
                logger.info(
                    "run_resumed run_id=%s mode=%s error_type=%s carry_forward=%d to_run=%d",
                    run_id, rerun_mode, rerun_error_type, len(plan.carry_forward), len(cases_to_run),
                )
            else:
                cases_to_run = cases

            planned_cases = len(cases) if resume_run_id else len(cases_to_run)
            self._register_run_registry(
                run_id=run_id,
                owner=getpass.getuser(),
                benchmark_id=self.benchmark.benchmark_id,
                split=self.experiment_config.split,
                provider=self.connector.provider_name,
                model=self.connector.model_name,
                started_at=run_state.run_record.started_at,
                dataset_cases=dataset_cases,
                planned_cases=planned_cases,
                git=run_state.run_record.git,
                tag=_sanitize_run_tag(self.experiment_config.tag) or None,
            )

            total_to_run = len(cases_to_run)
            concurrency = max(1, self.runner_config.concurrency)

            def _run_one(index: int, case):
                return self._run_case(
                    run_id=run_id,
                    run_dir=run_dir,
                    writer=writer,
                    case=case,
                    index=index,
                    total_cases=total_to_run,
                    docker_scope=docker_scope,
                    docker_image=docker_image,
                    run_docker_service=run_docker_service,
                )

            # Bookkeeping stays on the main thread, so RunState/registry/counters
            # need no locking even when cases run concurrently.
            def _record(index: int, case_result, payload) -> None:
                run_state.record_case_result(payload)
                self._record_case_registry(payload)
                self._analyze_on_the_fly(payload)
                self._upload_on_the_fly(payload)
                if self.runner_config.verbose:
                    print(
                        f"[{index}/{total_to_run}] case={case_result.case_id} db={case_result.input.get('db_id')} "
                        f"status={case_result.status}"
                    )

            if concurrency == 1:
                for index, case in enumerate(cases_to_run, start=1):
                    if index > 1 and self.runner_config.throttle_secs > 0:
                        logger.info("throttle_sleep seconds=%.2f before_case_index=%d", self.runner_config.throttle_secs, index)
                        time.sleep(self.runner_config.throttle_secs)
                    case_result, payload = _run_one(index, case)
                    _record(index, case_result, payload)
            else:
                logger.info("concurrent_run workers=%d total=%d", concurrency, total_to_run)
                pending = enumerate(cases_to_run, start=1)
                with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="case") as pool:
                    in_flight: dict[Future, int] = {}

                    # Keep at most `concurrency` cases in flight so completions are
                    # recorded as they finish (not after every case is submitted) and
                    # memory stays bounded on large runs.
                    def _submit_next() -> bool:
                        nxt = next(pending, None)
                        if nxt is None:
                            return False
                        index, case = nxt
                        if index > 1 and self.runner_config.throttle_secs > 0:
                            time.sleep(self.runner_config.throttle_secs)
                        in_flight[pool.submit(_run_one, index, case)] = index
                        return True

                    for _ in range(concurrency):
                        if not _submit_next():
                            break
                    while in_flight:
                        done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                        for fut in done:
                            index = in_flight.pop(fut)
                            case_result, payload = fut.result()
                            _record(index, case_result, payload)
                            _submit_next()

            # Concurrency records cases in completion order; restore case_index order
            # so exported predictions and the summary are deterministic across runs.
            run_state.case_result_payloads.sort(
                key=lambda p: p.get("case_index") if isinstance(p.get("case_index"), int) else -1
            )
            predictions_path = self.benchmark.export_predictions(run_dir, run_state.case_result_payloads)
            logger.info("predictions_exported path=%s", self._format_path(predictions_path, run_dir))
            run_path, evaluation_summary_path, predictions_path = run_state.finalize(
                writer=writer,
                cases=cases,
                predictions_path=predictions_path,
                run_log_path=run_log_path,
            )
            logger.info("evaluation_summary_written path=%s", self._format_path(evaluation_summary_path, run_dir))
            logger.info("run_finished run_id=%s total=%d completed=%d passed=%d failed=%d accuracy=%.2f predictions_path=%s evaluation_summary_path=%s run_record_path=%s run_log_path=%s", run_id, run_state.run_record.total_cases, run_state.run_record.completed_cases, run_state.run_record.passed_cases, run_state.run_record.failed_cases, run_state.run_record.accuracy, self._format_path(predictions_path, run_dir), self._format_path(evaluation_summary_path, run_dir), self._format_path(run_path, run_dir), self._format_path(run_log_path, run_dir))
            self._register_run_upload(run_id=run_id, run_dir=run_dir)
            self._update_run_registry_status(
                run_id=run_id,
                status="completed",
                finished_at=run_state.run_record.finished_at,
            )

            # Join background per-case uploads.
            self._finish_uploads()

            # Join background failure analyses, aggregate, and bake the report.
            self._finish_failure_analysis(run_dir)

            # Success analysis (opt-in): mine PASSED cases for harness levers.
            self._finish_success_analysis(run_dir)

            return {
                "run_id": run_id,
                "run_dir": run_dir,
                "run_path": run_path,
                "run_log_path": run_log_path,
                "predictions_path": predictions_path,
                "evaluation_summary_path": evaluation_summary_path,
                "total_cases": run_state.run_record.total_cases,
                "passed_cases": run_state.run_record.passed_cases,
                "accuracy": run_state.run_record.accuracy,
            }
        except Exception:
            if "run_id" in locals():
                self._update_run_registry_status(
                    run_id=run_id,
                    status="failed",
                    finished_at=datetime.now(timezone.utc).isoformat(),
                )
            logger.exception("run_exception run_id=%s", run_id)
            raise
        finally:
            if run_docker_service is not None:
                logger.info("docker_container_stopping scope=run run_id=%s container=%s", run_id, run_docker_service.container_name)
                run_docker_service.stop()
            finish_run = getattr(self.benchmark, "finish_run", None)
            if callable(finish_run):
                try:
                    logger.info("benchmark_finish_run benchmark=%s run_dir=%s", self.benchmark.benchmark_id, run_dir)
                    finish_run(run_dir)
                except Exception:
                    logger.exception("benchmark_finish_run_failed benchmark=%s run_dir=%s", self.benchmark.benchmark_id, run_dir)
            self._failure_pool.shutdown(wait=False)
            self._upload_pool.shutdown(wait=False)
            self._restore_termination_handlers(previous_signal_handlers)
            self._detach_run_log_handler(run_log_handler, previous_log_level)

    @staticmethod
    def _install_termination_handlers() -> dict[int, signal.Handlers]:
        if threading.current_thread() is not threading.main_thread():
            logger.warning("termination_handlers_not_installed reason=not_main_thread")
            return {}

        previous_handlers: dict[int, signal.Handlers] = {}

        def _handle_termination(signum, _frame) -> None:
            signal_name = signal.Signals(signum).name
            logger.warning("termination_signal_received signal=%s", signal_name)
            # A second signal should terminate immediately if Docker itself is
            # stuck while the first signal is trying to clean up.
            signal.signal(signum, signal.SIG_DFL)
            ContainerService.stop_all()
            raise SystemExit(128 + signum)

        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, _handle_termination)
        return previous_handlers

    @staticmethod
    def _restore_termination_handlers(previous_handlers: dict[int, signal.Handlers]) -> None:
        if threading.current_thread() is not threading.main_thread():
            return
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)

    @staticmethod
    def _attach_run_log_handler(run_log_path: Path) -> tuple[logging.Handler, int]:
        run_log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(run_log_path, encoding="utf-8")
        handler.setLevel(logging.DEBUG)
        formatter = logging.Formatter(fmt="%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%SZ")
        # Log in UTC so host-side log timestamps line up with container output.
        formatter.converter = time.gmtime
        handler.setFormatter(formatter)
        package_logger = logging.getLogger("dbagent")
        previous_level = package_logger.level
        package_logger.addHandler(handler)
        package_logger.setLevel(min(package_logger.level or logging.DEBUG, logging.DEBUG))
        return handler, previous_level

    @staticmethod
    def _detach_run_log_handler(handler: logging.Handler, previous_log_level: int) -> None:
        package_logger = logging.getLogger("dbagent")
        package_logger.removeHandler(handler)
        package_logger.setLevel(previous_log_level)
        handler.close()

    @staticmethod
    def _format_path(path: str | Path | None, base_dir: Path) -> str | None:
        if path is None:
            return None
        path_obj = Path(path)
        try:
            return str(path_obj.resolve().relative_to(base_dir.resolve()))
        except Exception:
            return str(path)

    def _analyze_on_the_fly(self, case_result: dict) -> None:
        """Per-case hook fired as each case completes.

        Two layers:
        - Deterministic: roll up pass rate + error_type counts
          and print a mid-run summary.
        - LLM (background): for FAILED cases only, fire codex into a bounded
          pool that writes ``cases/<id>/failure_analysis.json``. We never block
          the loop on it and we never let it raise into the run.
        """
        evaluation = case_result.get("evaluation") or {}
        passed = bool(evaluation.get("passed"))

        # --- deterministic layer -------------------------------------------
        self._seen_cases += 1
        if passed:
            self._passed_cases += 1
        else:
            etype = evaluation.get("error_type") or "unknown"
            self._error_type_counts[etype] = self._error_type_counts.get(etype, 0) + 1

        if self.runner_config.verbose and self._seen_cases % 10 == 0:
            rate = 100.0 * self._passed_cases / self._seen_cases
            buckets = ", ".join(f"{k}={v}" for k, v in sorted(self._error_type_counts.items())) or "none"
            print(f"[summary] cases={self._seen_cases} pass_rate={rate:.1f}% failures: {buckets}")

        # --- LLM layer (failures only, background) -------------------------
        # TODO: optionally also analyze false-positive
        # passes — cases where evaluation.details.execution_match is True but
        # exact_match is False. Those pass on result-equality while the SQL may
        # be semantically wrong.
        if passed:
            return
        try:
            from dbagent.failure_analysis import analyzer as failure_analyzer
        except Exception:  # pragma: no cover - import guard
            logger.exception("failure analyzer import failed; skipping analysis")
            return
        # Enabled by the --failure-analysis flag (RunnerConfig) OR the env var.
        # Default off: a plain run never spawns codex implicitly.
        if not (self.runner_config.failure_analysis or failure_analyzer.is_enabled()):
            return
        if not failure_analyzer.codex_available():
            if not getattr(self, "_codex_warned", False):
                logger.warning("failure_analysis disabled: codex binary not found on PATH")
                self._codex_warned = True
            return
        run_id = case_result.get("run_id")
        fut = self._failure_pool.submit(failure_analyzer.analyze_case, case_result, run_id=run_id)
        self._failure_futures.append(fut)

    def _upload_on_the_fly(self, case_result: dict) -> None:
        """Per-case hook: archive this case's dir and upload it to WebDAV.

        Fired for EVERY case (pass or fail), into a bounded background pool so it
        never blocks the loop. Enabled by default when WebDAV credentials are
        configured, unless the run explicitly disables uploads via
        RunnerConfig.upload_cases.
        Best-effort: the uploader never raises into the run.
        """
        try:
            from dbagent.failure_analysis import upload as case_upload
        except Exception:  # pragma: no cover - import guard
            logger.exception("case upload import failed; skipping upload")
            return
        if not self.runner_config.upload_cases:
            return
        if not case_upload.is_enabled():
            if not getattr(self, "_upload_warned", False):
                logger.warning(
                    "case upload enabled but %s is not set; skipping uploads",
                    case_upload.SERVER_URL_ENV,
                )
                self._upload_warned = True
            return
        run_id = case_result.get("run_id")
        fut = self._upload_pool.submit(case_upload.upload_case, case_result, run_id=run_id)
        self._upload_futures.append(fut)

    def _resolve_run_registry(self):
        if self._run_registry is not None:
            return self._run_registry
        try:
            from dbagent.results.d1_run_store import D1RunStore
        except Exception:
            if not self._run_registry_warned:
                logger.exception("d1_registry_import_failed")
                self._run_registry_warned = True
            return None
        self._run_registry = D1RunStore.from_env()
        if self._run_registry is None and not self._run_registry_warned:
            logger.info(
                "d1_registry_disabled missing one of %s/%s/%s",
                "CLOUDFLARE_API_TOKEN",
                "CLOUDFLARE_ACCOUNT_ID",
                "CLOUDFLARE_D1_DATABASE_ID",
            )
            self._run_registry_warned = True
        return self._run_registry

    def _artifact_root_registry_path(self, run_id: str) -> str | None:
        try:
            from dbagent.failure_analysis import upload as case_upload
        except Exception:
            return None
        if not case_upload.is_enabled():
            return None
        return case_upload.run_root_remote_path(run_id)

    def _register_run_registry(
        self,
        *,
        run_id: str,
        owner: str,
        benchmark_id: str,
        split: str,
        provider: str,
        model: str,
        started_at: str,
        dataset_cases: int,
        planned_cases: int,
        git: dict | None = None,
        tag: str | None = None,
    ) -> None:
        registry = self._resolve_run_registry()
        if registry is None:
            logger.info(
                "d1_run_write_failed run_id=%s reason=registry_unavailable benchmark_id=%s split=%s provider=%s model=%s",
                run_id,
                benchmark_id,
                split,
                provider,
                model,
            )
            return
        logger.info(
            "d1_run_write_started run_id=%s owner=%s benchmark_id=%s split=%s provider=%s model=%s dataset_cases=%d planned_cases=%d",
            run_id,
            owner,
            benchmark_id,
            split,
            provider,
            model,
            dataset_cases,
            planned_cases,
        )
        try:
            registry.upsert_run_started(
                run_id=run_id,
                owner=owner,
                benchmark_id=benchmark_id,
                split=split,
                provider=provider,
                model=model,
                started_at=started_at,
                dataset_cases=dataset_cases,
                planned_cases=planned_cases,
                artifact_root_path=self._artifact_root_registry_path(run_id),
                git_commit=str((git or {}).get("commit") or ""),
                git_branch=str((git or {}).get("branch") or ""),
                tag=tag,
            )
            logger.info(
                "d1_run_write_succeeded run_id=%s owner=%s benchmark_id=%s split=%s provider=%s model=%s",
                run_id,
                owner,
                benchmark_id,
                split,
                provider,
                model,
            )
        except Exception:
            logger.exception(
                "d1_run_write_failed run_id=%s owner=%s benchmark_id=%s split=%s provider=%s model=%s",
                run_id,
                owner,
                benchmark_id,
                split,
                provider,
                model,
            )
            logger.error("d1_registry_run_start_failed run_id=%s", run_id)

    def _update_run_registry_status(self, *, run_id: str, status: str, finished_at: str | None) -> None:
        registry = self._resolve_run_registry()
        if registry is None:
            return
        try:
            registry.update_run_status(
                run_id=run_id,
                status=status,
                finished_at=finished_at,
                artifact_root_path=self._artifact_root_registry_path(run_id),
            )
        except Exception:
            logger.exception("d1_registry_run_update_failed run_id=%s status=%s", run_id, status)

    def _record_case_registry(self, case_result: dict) -> None:
        registry = self._resolve_run_registry()
        if registry is None:
            logger.info(
                "d1_case_write_failed run_id=%s case_id=%s reason=registry_unavailable",
                case_result.get("run_id"),
                case_result.get("case_id"),
            )
            return
        run_id = case_result.get("run_id")
        case_id = case_result.get("case_id")
        if not run_id or not case_id:
            logger.info(
                "d1_case_write_failed run_id=%s case_id=%s reason=missing_identifiers",
                run_id,
                case_id,
            )
            return
        evaluation = case_result.get("evaluation") or {}
        if case_result.get("status") == "success":
            status = "passed"
        elif evaluation.get("error_type") in {"runtime_error", "data_error"}:
            status = "error"
        else:
            status = "failed"
        logger.info(
            "d1_case_write_started run_id=%s case_id=%s status=%s case_result_status=%s error_type=%s",
            run_id,
            case_id,
            status,
            case_result.get("status"),
            evaluation.get("error_type"),
        )
        try:
            registry.upsert_case_result(
                run_id=str(run_id),
                case_id=str(case_id),
                status=status,
            )
            logger.info(
                "d1_case_write_succeeded run_id=%s case_id=%s status=%s",
                run_id,
                case_id,
                status,
            )
        except Exception:
            logger.exception(
                "d1_case_write_failed run_id=%s case_id=%s status=%s",
                run_id,
                case_id,
                status,
            )
            logger.error("d1_registry_case_update_failed run_id=%s case_id=%s", run_id, case_id)

    def _register_run_upload(self, *, run_id: str, run_dir: Path) -> None:
        """Best-effort run-bundle upload to WebDAV storage."""
        try:
            from dbagent.failure_analysis import upload as case_upload
        except Exception:  # pragma: no cover - import guard
            logger.exception("run upload import failed; skipping registration")
            return
        if not self.runner_config.upload_cases:
            return
        if not case_upload.is_enabled():
            if not getattr(self, "_upload_warned", False):
                logger.warning(
                    "case upload enabled but %s is not set; skipping uploads",
                    case_upload.SERVER_URL_ENV,
                )
                self._upload_warned = True
            return
        case_upload.register_run(run_id=run_id, run_dir=run_dir, repo_root=self.workdir)

    def _finish_uploads(self) -> None:
        """Join background per-case uploads after the case loop. No-op when none
        were submitted. Bounded wait so a hung server can't wedge the run."""
        if not self._upload_futures:
            return
        pending = [f for f in self._upload_futures if not f.done()]
        if pending:
            logger.info("case_upload_join pending=%d", len(pending))
        try:
            join_timeout = int(os.environ.get("DBAGENT_UPLOAD_JOIN_TIMEOUT", "600"))
        except ValueError:
            join_timeout = 600
        deadline = time.monotonic() + join_timeout
        for fut in self._upload_futures:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                fut.result(timeout=remaining)
            except Exception as exc:
                logger.warning("case_upload_future error=%s", exc)

    def _finish_failure_analysis(self, run_dir: Path) -> None:
        """Join background failure-analysis jobs, then bake the static report.

        Called once after the case loop. Bounded wait so a hung codex can't
        wedge the run forever; whatever finished gets baked.

        No-op when nothing was submitted (failure analysis off, no failures, or
        no codex): we don't summarize or write failure_report.html for a run
        that didn't analyze anything. Use ``failure_analyzer.backfill_run`` to
        analyze such a run after the fact.
        """
        if not self._failure_futures:
            return
        pending = [f for f in self._failure_futures if not f.done()]
        if pending:
            logger.info("failure_analysis_join pending=%d", len(pending))
        try:
            join_timeout = int(os.environ.get("DBAGENT_FAILURE_JOIN_TIMEOUT", "1800"))
        except ValueError:
            join_timeout = 1800
        deadline = time.monotonic() + join_timeout
        for fut in self._failure_futures:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                fut.result(timeout=remaining)
            except Exception as exc:
                logger.warning("failure_analysis_future error=%s", exc)

        # Run-level aggregation: typical issues + %, and suggestions attributed
        # to llm / harness / benchmark. Writes failure_summary.json.
        try:
            from dbagent.failure_analysis import analyzer as failure_analyzer
            failure_analyzer.summarize_run(run_dir)
        except Exception:
            logger.exception("failure_summary aggregation failed run_dir=%s", run_dir)

        # Bake the static report from whatever analyses landed on disk.
        try:
            from dbagent.failure_analysis.render import build_html
            html = build_html(run_dir)
            report_path = run_dir / "failure_report.html"
            report_path.write_text(html, encoding="utf-8")
            logger.info("failure_report_written path=%s", self._format_path(report_path, run_dir))
        except Exception:
            logger.exception("failure_report bake failed run_dir=%s", run_dir)

    def _finish_success_analysis(self, run_dir: Path) -> None:
        """Analyze PASSED cases for harness-optimization levers (opt-in).

        Runs once after the case loop, only when enabled by the
        ``--success-analysis`` flag (RunnerConfig) or the ``DBAGENT_SUCCESS_ANALYSIS``
        env var. Unlike failure analysis this is a bulk end-of-run pass (not a
        per-case background job): it reuses the same code path as the CLI
        backfill. Best-effort — never raises into the run.
        """
        try:
            from dbagent.failure_analysis import success_analyzer
        except Exception:  # pragma: no cover - import guard
            logger.exception("success analyzer import failed; skipping analysis")
            return
        if not (self.runner_config.success_analysis or success_analyzer.is_enabled()):
            return
        if not success_analyzer.agent_available():
            logger.warning("success_analysis disabled: coding-agent binary not found on PATH")
            return
        try:
            result = success_analyzer.analyze_run(run_dir)
            logger.info(
                "success_analysis_done run_dir=%s analyzed=%d skipped=%d failed=%d",
                self._format_path(run_dir, run_dir), result.get("analyzed", 0),
                result.get("skipped", 0), result.get("failed", 0),
            )
        except Exception:
            logger.exception("success_analysis failed run_dir=%s", run_dir)

    def _resolve_docker_scope(self) -> str:
        configured_scope = getattr(self.benchmark, "docker_execution_scope", "case")
        if configured_scope not in {"case", "run"}:
            raise RuntimeError(f"Unsupported Docker scope: {configured_scope}")
        return configured_scope

    def _resolve_docker_image(self) -> str:
        docker_image = getattr(self.benchmark, "docker_image", None)
        if not docker_image:
            raise RuntimeError(
                f"Benchmark {self.benchmark.benchmark_id!r} does not define a Docker image"
            )
        return docker_image

    def _resolve_docker_host_workspace(self) -> Path:
        host_workspace = getattr(self.benchmark, "docker_host_workspace", None)
        # We use docker_host_workspace defined in each benchmark to mount the workspace into the container.
        if not host_workspace:
            raise RuntimeError(
                f"Benchmark {self.benchmark.benchmark_id!r} does not define docker_host_workspace"
            )
        return Path(host_workspace)

    def _ensure_docker_image(self, docker_image: str) -> None:
        dockerfile_path = getattr(self.benchmark, "dockerfile_path", None)
        build_context = getattr(self.benchmark, "docker_build_context", None)
        if dockerfile_path is None or build_context is None:
            raise RuntimeError(f"Benchmark {self.benchmark.benchmark_id!r} does not define dockerfile_path/build_context")
        logger.info("docker_image_check image=%s dockerfile=%s context=%s", docker_image, self._format_path(dockerfile_path, self.workdir), self._format_path(build_context, self.workdir))
        ContainerService.ensure_image(
            docker_image,
            dockerfile_path=Path(dockerfile_path),
            build_context=Path(build_context),
        )
        logger.info("docker_image_ready image=%s", docker_image)

    def _docker_env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        if has_model_config(self.connector_config.model):
            for env_name in get_model_config_env_vars(self.connector_config.model):
                env_value = os.getenv(env_name)
                if not env_value:
                    raise RuntimeError(f"Missing environment variable: {env_name}")
                env[env_name] = env_value
        else:
            env[self.connector_config.api_key_env] = self.connector.api_key
            # Bedrock authenticates from the environment (bearer token + region),
            # not a single api_key var, so forward the AWS env the in-container
            # litellm call needs. No-op for non-Bedrock providers (vars unset).
            for env_name in ("AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION_NAME", "AWS_REGION", "AWS_SESSION_TOKEN"):
                env_value = os.getenv(env_name)
                if env_value:
                    env[env_name] = env_value
        if os.getenv("LITELLM_DEBUG"):
            env["LITELLM_DEBUG"] = os.getenv("LITELLM_DEBUG", "")
        return env

    def _run_agent_in_docker(
        self,
        *,
        docker_service: ContainerService,
        task: TaskSpec,
        case_dir: Path,
        task_workspace: Path | None,
        run_log_path: Path,
        prompt_override: str | None = None,
        agent_kwargs_override: dict | None = None,
        phase_label: str | None = None,
        user_sim_config: dict | None = None,
        submit_eval_config: dict | None = None,
    ) -> dict:
        # phase_label disambiguates the per-invocation payload/output files when a
        # benchmark drives more than one agent pass into the same case container
        # (e.g. BIRD-Interact-a Phase 1 / Phase 2). Defaults keep single-pass names.
        suffix = f"_{phase_label}" if phase_label else ""
        worker_input_path = case_dir / f"agent_input{suffix}.json"
        worker_output_path = case_dir / f"agent_output{suffix}.json"
        agent_kwargs = dict(task.metadata.get("agent_kwargs") or {})
        if agent_kwargs_override:
            agent_kwargs.update(agent_kwargs_override)

        # Host-side IPC channel for the ``ask`` and ``submit`` actions. The ground
        # truth they need (user-sim context, gold SQL / test cases) stays in this
        # (host) process; only the shared IPC directory path crosses to the
        # container, and only an answer / pass-fail verdict crosses back. A single
        # responder serves both, dispatching each request by its "kind".
        ipc_responder = None
        simulator = (
            user_sim_config["factory"](self._build_user_sim_caller())
            if user_sim_config
            else None
        )
        scorer = submit_eval_config["scorer"] if submit_eval_config else None
        if simulator is not None or scorer is not None:
            ipc_dir = case_dir / f"ipc{suffix}"
            ipc_responder = IpcResponder(ipc_dir, simulator=simulator, scorer=scorer)
            container_ipc_dir = docker_service.container_path_for(ipc_dir)
            if container_ipc_dir is None:
                raise RuntimeError(f"Docker IPC dir is outside mounted paths: {ipc_dir}")
            agent_kwargs["ipc_dir"] = str(container_ipc_dir)

        # The agent runs inside the container, where localhost/127.0.0.1 is the
        # container itself; rewrite a host-local LLM base_url to the bridged host
        # alias so the agent can reach a host service (e.g. a local Ollama daemon).
        # The host-side user simulator keeps the original base_url (it is not
        # containerized), so a single --base_url localhost works for both sides.
        container_connector = asdict(self.connector_config)
        container_connector["base_url"] = rewrite_api_base_for_runtime(
            self.connector_config.base_url,
            runtime="container",
        )

        prompt = task.prompt if prompt_override is None else prompt_override
        if task_workspace is None:
            raise RuntimeError(f"Missing task_workspace for case {task.case_id}")
        host_workdir = task_workspace
        container_workdir = docker_service.container_path_for(host_workdir)
        if container_workdir is None:
            raise RuntimeError(f"Docker workspace is outside mounted paths: {host_workdir}")
        # TODO: if we are concern about the prompt, we can remove rewrite_workspace_path_for_container().
        prompt = self._rewrite_workspace_path_for_container(
            prompt,
            host_workdir=host_workdir,
            container_workdir=container_workdir,
        )
        container_db_path = self._container_db_path(
            docker_service=docker_service,
            db_path=task.db_path,
        )
        container_log_dir = docker_service.container_path_for(case_dir)
        container_run_log_path = docker_service.container_path_for(run_log_path)
        container_worker_input_path = docker_service.container_path_for(worker_input_path)
        container_worker_output_path = docker_service.container_path_for(worker_output_path)
        if (
            container_log_dir is None
            or container_run_log_path is None
            or container_worker_input_path is None
            or container_worker_output_path is None
        ):
            raise RuntimeError("Docker case artifacts are outside mounted paths")

        payload = {
            "workdir": str(container_workdir),
            "log_dir": str(container_log_dir),
            "run_log_path": str(container_run_log_path),
            "task_workspace": str(container_workdir),
            "connector_config": container_connector,
            "agent_config": asdict(self.agent_config),
            "task": {
                "prompt": prompt,
                "db_type": task.db_type,
                "db_path": container_db_path,
                "user_question": task.user_question,
                "case_id": task.case_id,
                # Extra keyword args a benchmark wants passed to the agent (e.g.
                # BIRD-Interact's knowledge/column data and budget). The runner
                # stays benchmark-agnostic and forwards this blob verbatim
                "agent_kwargs": agent_kwargs,
            },
        }
        
        worker_input_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        if worker_output_path.exists():
            worker_output_path.unlink()

        worker_workdir = container_workdir
        command = (
            "python -m dbagent.runners.agent_worker "
            f"--input {shlex.quote(str(container_worker_input_path))} "
            f"--output {shlex.quote(str(container_worker_output_path))}"
        )
        logger.info(
            "docker_agent_started case_id=%s container=%s input=%s output=%s",
            task.case_id,
            docker_service.container_name,
            self._format_path(worker_input_path, case_dir),
            self._format_path(worker_output_path, case_dir),
        )
        if ipc_responder is not None:
            ipc_responder.start()
        try:
            result = docker_service.exec(command, worker_workdir)
        finally:
            if ipc_responder is not None:
                ipc_responder.stop()
        if result.returncode != 0:
            raise RuntimeError(f"Docker agent worker failed: {result.output}")
        if not worker_output_path.exists():
            raise FileNotFoundError(f"Docker agent worker did not write output: {worker_output_path}")
        output = json.loads(worker_output_path.read_text(encoding="utf-8"))
        output = self._rewrite_output_paths_for_host(output, docker_service=docker_service)
        self._preserve_phase_artifacts(
            output,
            phase_label=phase_label,
            worker_output_path=worker_output_path,
        )
        logger.info(
            "docker_agent_finished case_id=%s container=%s output_chars=%d",
            task.case_id,
            docker_service.container_name,
            len(result.output),
        )
        return output

    @staticmethod
    def _preserve_phase_artifacts(
        output: dict,
        *,
        phase_label: str | None,
        worker_output_path: Path,
    ) -> None:
        """Keep per-phase logs when a benchmark runs multiple agent passes.

        SQLAgent always writes ``trajectory.json`` inside the case directory.
        Multi-phase benchmarks such as BIRD-Interact-a run the agent twice, so
        the second pass would otherwise overwrite the first pass trajectory.
        The worker output files are already phase-suffixed; mirror that for the
        trajectory path while keeping ``trajectory.json`` as the latest pass.
        """
        if not phase_label:
            return
        trajectory_path_value = output.get("trajectory_path")
        if not trajectory_path_value:
            return
        trajectory_path = Path(trajectory_path_value)
        if not trajectory_path.exists():
            return
        phase_trajectory_path = trajectory_path.with_name(f"{trajectory_path.stem}_{phase_label}{trajectory_path.suffix}")
        shutil.copyfile(trajectory_path, phase_trajectory_path)
        output["trajectory_path"] = str(phase_trajectory_path)
        worker_output_path.write_text(
            json.dumps(output, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    @staticmethod
    def _rewrite_workspace_path_for_container(
        text: str,
        *,
        host_workdir: Path,
        container_workdir: Path,
    ) -> str:
        host_text = str(host_workdir.expanduser().resolve())
        container_text = str(container_workdir)
        if host_text == container_text:
            return text
        return text.replace(host_text, container_text)

    @staticmethod
    def _container_db_path(
        *,
        docker_service: ContainerService,
        db_path: str | None,
    ) -> str | None:
        # Example: host /host/ws/db.sqlite -> container /workspace/db.sqlite.
        if not db_path:
            return db_path
        path = Path(db_path)
        if not path.is_absolute():
            return db_path
        container_path = docker_service.container_path_for(path)
        # Postgres DSNs like postgres://... are left unchanged.
        if container_path is None or not str(container_path).startswith(str(CONTAINER_WORKSPACE)):
            return db_path
        return str(container_path)

    @staticmethod
    def _rewrite_output_paths_for_host(
        output: dict,
        *,
        docker_service: ContainerService,
    ) -> dict:
        # Example: /workspace/trajectory.json -> /host/ws/cases/case1/trajectory.json.
        for key in ("trajectory_path", "llm_responses_path"):
            value = output.get(key)
            if not value:
                continue
            host_path = docker_service.host_path_for(Path(value))
            if host_path is not None:
                output[key] = str(host_path)
        return output

    def _build_memory_store(self, run_dir: Path):
        """Construct the per-run exemplar MemoryStore (host-side).

        Enforces sequential execution: online accumulation needs case i-1's write
        to land before case i is built, which only concurrency==1 guarantees.
        """
        if max(1, self.runner_config.concurrency) != 1:
            raise RuntimeError(
                "--memory requires --concurrency 1 (online accumulation needs sequential order)"
            )
        from dbagent.memory import Embedder, MemoryStore

        model = self.runner_config.embedding_model or "st:Qwen/Qwen3-Embedding-0.6B"
        base = self.runner_config.embedding_base_url or "http://localhost:11434"
        embedder = Embedder(model=model, api_base=base, api_key=os.getenv("OLLAMA_API_KEY"))
        mem_dir = run_dir / "memory"
        store = MemoryStore(
            mem_dir / "lancedb",
            embedder,
            top_k=self.runner_config.memory_top_k,
            tau=self.runner_config.memory_tau,
            log_path=mem_dir / "retrievals.jsonl",
        )
        logger.info(
            "memory_enabled embedding_model=%s base=%s top_k=%d tau=%.2f dir=%s",
            model, base, self.runner_config.memory_top_k, self.runner_config.memory_tau, mem_dir,
        )
        return store

    @staticmethod
    def _inject_memory_block(prompt: str, block: str) -> str:
        """Insert a retrieved-memory block before the ``Question:`` marker.

        Falls back to appending when no marker is present so injection is
        benchmark-agnostic.
        """
        marker = "Question:"
        idx = prompt.find(marker)
        if idx == -1:
            return f"{prompt}\n\n{block}"
        return f"{prompt[:idx]}{block}\n{prompt[idx:]}"

    def _build_user_sim_caller(self):
        """A plain-text LLM caller for the user simulator.

        Uses the configured user-sim model (falling back to the run's model) and
        the run's ``max_tokens`` so reasoning models have enough headroom to emit
        an answer rather than spending the whole budget on hidden reasoning.
        Signature is ``(messages) -> content``.
        """
        import litellm

        cfg = self.connector_config
        model = cfg.user_sim_model or cfg.model
        if has_model_config(model):
            router_cfg = rewrite_model_config_base_urls(
                get_model_config(model),
                runtime="host",
            )
            router = litellm.Router(
                model_list=router_cfg["model_list"],
                fallbacks=router_cfg.get("fallbacks"),
            )

            def call(messages: list[dict[str, str]]) -> str:
                response = router.completion(
                    model=router_cfg["entry_model"],
                    messages=messages,
                    temperature=0.0,
                    max_tokens=cfg.max_tokens,
                    # Align with official BIRD-Interact-ADK (shared/llm.py MAX_RETRIES=5):
                    # let litellm retry rate-limit / transient errors so a throttled
                    # user-sim call does not degrade straight to the unanswerable() /
                    # "I'm not sure" fallback (1:1 with each provider error).
                    num_retries=5,
                )
                return response.choices[0].message.content or ""

            return call

        api_key = self.connector.api_key
        api_base = cfg.base_url or None

        def call(messages: list[dict[str, str]]) -> str:
            response = litellm.completion(
                model=model,
                messages=messages,
                temperature=0.0,
                max_tokens=cfg.max_tokens,
                api_key=api_key,
                api_base=api_base,
                # Match the router branch / official ADK: retry transient failures.
                num_retries=5,
            )
            return response.choices[0].message.content or ""

        return call

    def _build_data_error_case_result(
        self,
        *,
        run_id: str,
        case,
        index: int,
        case_started: datetime,
        error: FileNotFoundError,
    ) -> CaseResult:
        input_record = dict(getattr(case, "payload", {}) or {})
        input_record.setdefault("instance_id", getattr(case, "case_id", f"case_{index}"))

        reference: dict[str, object] = {}
        gold_by_instance = getattr(self.benchmark, "gold_by_instance", None)
        if isinstance(gold_by_instance, dict):
            gold_record = gold_by_instance.get(input_record["instance_id"])
            if gold_record is not None:
                reference["gold_metadata"] = gold_record

        error_text = f"{error}\n{traceback.format_exc()}"
        return CaseResult(
            run_id=run_id,
            benchmark_id=self.benchmark.benchmark_id,
            split=getattr(case, "split", self.experiment_config.split),
            case_id=input_record["instance_id"],
            case_index=getattr(case, "case_index", index - 1),
            input=input_record,
            reference=reference,
            prediction={"raw_text": "", "final_sql": "", "final_artifact_path": None},
            evaluation={
                "passed": False,
                "score": 0.0,
                "mode": "data_error",
                "details": {"phase": "build_task", "error": str(error)},
                "error_type": "data_error",
            },
            status="failed",
            timing={
                "started_at": case_started.isoformat(),
                "finished_at": datetime.now(timezone.utc).isoformat(),
            },
            llm={
                "provider": self.connector.provider_name,
                "model": self.connector.model_name,
                "call_count": 0,
                "usage": {},
            },
            logs={},
            error=error_text,
        )

    def _persist_case_result(
        self,
        *,
        writer: ResultWriter,
        run_dir: Path,
        case_result: CaseResult,
        index: int,
        total_cases: int,
        case_t0: float,
    ) -> tuple[CaseResult, dict]:
        payload = case_result.to_dict()
        payload["artifacts"]["case_result_path"] = str(writer.case_result_path(case_result.case_id))
        case_result.artifacts["case_result_path"] = payload["artifacts"]["case_result_path"]
        case_result_path = writer.write_case_result(case_result)
        logger.info(
            "case_finished index=%d total=%d case_id=%s status=%s duration_secs=%.2f score=%s error_type=%s llm_calls=%s case_result_path=%s trajectory_path=%s llm_responses_path=%s",
            index,
            total_cases,
            case_result.case_id,
            case_result.status,
            time.monotonic() - case_t0,
            case_result.evaluation.get("score"),
            case_result.evaluation.get("error_type"),
            case_result.llm.get("call_count"),
            self._format_path(case_result_path, run_dir),
            self._format_path(case_result.logs.get("trajectory"), run_dir),
            self._format_path(case_result.logs.get("llm_responses"), run_dir),
        )
        return case_result, payload

    def _run_case(
        self,
        *,
        run_id: str,
        run_dir: Path,
        writer: ResultWriter,
        case,
        index: int,
        total_cases: int,
        docker_scope: str,
        docker_image: str,
        run_docker_service: ContainerService | None = None,
    ) -> tuple[CaseResult, dict]:
        case_started = datetime.now(timezone.utc)
        case_t0 = time.monotonic()
        try:
            task = self.benchmark.build_task(case)
        except FileNotFoundError as exc:
            logger.warning("case_data_error case_id=%s error=%s", getattr(case, "case_id", index), exc)
            case_result = self._build_data_error_case_result(
                run_id=run_id,
                case=case,
                index=index,
                case_started=case_started,
                error=exc,
            )
            return self._persist_case_result(
                writer=writer,
                run_dir=run_dir,
                case_result=case_result,
                index=index,
                total_cases=total_cases,
                case_t0=case_t0,
            )

        if self._memory is not None:
            # Retrieve same-DB exemplars from earlier passing cases and inject them
            # into the prompt (host-side). Never let memory break a case.
            try:
                hits, _r = self._memory.retrieve(task)
                if hits:
                    task.prompt = self._inject_memory_block(task.prompt, self._memory.format_block(hits))
                    logger.info("memory_injected case_id=%s exemplars=%d", task.case_id, len(hits))
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory_retrieve_error case_id=%s error=%s", task.case_id, exc)

        case_dir = writer.case_dir(task.case_id)
        # case_dir is bind-mounted into the agent container. On a rerun/resume the
        # previous attempt's result.json still sits here, and result.json carries
        # the ground truth (`reference.gold_sql`), so a re-running agent's bash
        # tool could read its own gold answer. Remove the stale copy before the
        # container starts; result.json is rewritten from scratch when the case
        # finishes. (On a first run there is nothing to remove.)
        stale_result = case_dir / "result.json"
        if stale_result.exists():
            stale_result.unlink()
            logger.info("stale_result_removed case_id=%s", task.case_id)
        metadata_workdir = task.metadata.get("task_workspace")
        if not metadata_workdir:
            raise RuntimeError(f"Missing task_workspace for case {task.case_id}")
        task_workspace = Path(metadata_workdir)
        docker_service = None
        active_docker_service = run_docker_service
        logger.info(
            "case_started index=%d total=%d case_id=%s case_index=%s db_type=%s db_id=%s instance_id=%s case_dir=%s",
            index,
            total_cases,
            task.case_id,
            task.case_index,
            task.db_type,
            task.input_record.get("db_id"),
            task.input_record.get("instance_id"),
            self._format_path(case_dir, run_dir),
        )
        try:
            if docker_scope == "case":
                docker_host_workspace = task_workspace or self.workdir
                docker_service = ContainerService(
                    image=docker_image,
                    case_id=task.case_id,
                )
                logger.info(
                    "docker_container_starting scope=case case_id=%s image=%s workspace=%s",
                    task.case_id,
                    docker_image,
                    docker_host_workspace,
                )
                docker_service.start(
                    docker_host_workspace,
                    # Mount only this case's dir and the run.log file -- NOT the
                    # whole run_dir. Mounting run_dir would expose every other
                    # case's cases/<id>/result.json (which carries the ground
                    # truth) to the agent's bash tool -- and with parallel case
                    # execution many sibling case dirs are present at once. The
                    # worker only needs this case dir (input/output/ipc) and
                    # run.log (to append its logs).
                    extra_mounts=[run_dir / "run.log", case_dir],
                    env=self._docker_env(),
                    code_src=self.workdir / "src",
                )
                active_docker_service = docker_service
                logger.info(
                    "docker_container_started scope=case case_id=%s container=%s",
                    task.case_id,
                    docker_service.container_name,
                )
            elif docker_scope != "run":
                raise RuntimeError(f"Unsupported Docker scope: {docker_scope}")

            if active_docker_service is None:
                raise RuntimeError("Docker agent service was not started")

            # The benchmark owns "task -> CaseOutcome"; the runner only provides
            # run_agent, a docker-agnostic callback that runs one agent pass into
            # this case's container (the benchmark may call it more than once, e.g.
            # BIRD-Interact-a's two-phase flow).
            run_agent = partial(
                self._run_agent_in_docker,
                docker_service=active_docker_service,
                task=task,
                case_dir=case_dir,
                task_workspace=task_workspace,
                run_log_path=run_dir / "run.log",
            )
            # Dispatch to the benchmark: default run_case is a single pass + scoring;
            # an override (e.g. BIRD-Interact-a) may drive several passes.
            outcome = self.benchmark.run_case(task, run_agent)
            prediction_payload, evaluation, output = (
                outcome.prediction, outcome.evaluation, outcome.agent_output
            )
            status = "success" if evaluation.passed else "failed"
            if self._memory is not None and evaluation.passed:
                # Write the verified exemplar so later same-DB cases can retrieve it.
                try:
                    self._memory.write(task, prediction_payload.get("final_sql"))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("memory_write_error case_id=%s error=%s", task.case_id, exc)
            logger.info(
                "evaluation_finished case_id=%s passed=%s score=%s mode=%s error_type=%s",
                task.case_id,
                evaluation.passed,
                evaluation.score,
                evaluation.mode,
                evaluation.error_type,
            )
            case_result = CaseResult(
                run_id=run_id,
                benchmark_id=self.benchmark.benchmark_id,
                split=task.split,
                case_id=task.case_id,
                case_index=task.case_index,
                input=task.input_record,
                reference=task.reference,
                prediction=prediction_payload,
                evaluation=evaluation.to_dict(),
                status=status,
                timing={
                    "started_at": case_started.isoformat(),
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                },
                llm={
                    "provider": self.connector.provider_name,
                    "model": self.connector.model_name,
                    "call_count": output["llm_call_count"],
                    "usage": output["usage"],
                },
                logs={
                    "trajectory": output["trajectory_path"],
                    "llm_responses": output["llm_responses_path"],
                },
            )
        except Exception as exc:
            error_text = f"{exc}\n{traceback.format_exc()}"
            logger.exception("case_exception case_id=%s error=%s", task.case_id, exc)
            case_result = CaseResult(
                run_id=run_id,
                benchmark_id=self.benchmark.benchmark_id,
                split=task.split,
                case_id=task.case_id,
                case_index=task.case_index,
                input=task.input_record,
                reference=task.reference,
                prediction={"raw_text": "", "final_sql": "", "final_artifact_path": None},
                evaluation={
                    "passed": False,
                    "score": 0.0,
                    "mode": "runtime_error",
                    "details": {},
                    "error_type": "runtime_error",
                },
                status="failed",
                timing={
                    "started_at": case_started.isoformat(),
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                },
                llm={
                    "provider": self.connector.provider_name,
                    "model": self.connector.model_name,
                    "call_count": 0,
                    "usage": {},
                },
                logs={},
                error=error_text,
            )
        finally:
            if docker_service is not None:
                logger.info(
                    "docker_container_stopping scope=case case_id=%s container=%s",
                    task.case_id,
                    docker_service.container_name,
                )
                docker_service.stop()

        return self._persist_case_result(
            writer=writer,
            run_dir=run_dir,
            case_result=case_result,
            index=index,
            total_cases=total_cases,
            case_t0=case_t0,
        )
