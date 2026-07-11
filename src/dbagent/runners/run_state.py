from __future__ import annotations

import logging
import subprocess
import tarfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

from dbagent.config import AgentConfig, ConnectorConfig, ExperimentConfig
from dbagent.results.models import RunRecord
from dbagent.results.summary import build_evaluation_summary, build_token_stats
from dbagent.results.writer import ResultWriter


def _git_metadata(repo_root: Path) -> dict[str, Any] | None:
    """Capture the repo state at run start for reproducibility."""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        short_commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        commit_subject = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        commit_time = subprocess.run(
            ["git", "log", "-1", "--pretty=%cI"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    return {
        "commit": commit,
        "short_commit": short_commit,
        "commit_subject": commit_subject,
        "commit_time": commit_time,
        "branch": branch,
        "dirty": bool(status.strip()),
    }


def _snapshot_source(src_dir: Path, dest_archive: Path) -> bool:
    """Tar-gzip the agent source tree into the run folder for reproducibility.

    Captures the exact ``src/dbagent`` used for the run (working-tree state,
    including any uncommitted edits the git metadata flags as ``dirty``).
    Skips ``__pycache__`` and compiled artifacts. Best-effort: failures are
    logged and do not abort the run.
    """
    if not src_dir.is_dir():
        return False
    try:
        with tarfile.open(dest_archive, "w:gz") as archive:
            for path in sorted(src_dir.rglob("*")):
                if not path.is_file():
                    continue
                if "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo"):
                    continue
                archive.add(path, arcname=path.relative_to(src_dir.parent))
        return True
    except OSError:
        logger.exception("source_snapshot_failed src=%s dest=%s", src_dir, dest_archive)
        return False


def finalize_run_outputs(
    *,
    run_record: RunRecord,
    run_id: str,
    run_dir: Path,
    writer: ResultWriter,
    cases: list[Any],
    case_results: list[dict[str, Any]],
    predictions_path: Path,
    run_log_path: Path,
    finished_at: datetime | None = None,
) -> tuple[Path, Path, Path]:
    evaluation_summary = build_evaluation_summary(
        run_id=run_id,
        run_dir=run_dir,
        cases=cases,
        case_results=case_results,
        predictions_path=predictions_path,
    )
    evaluation_summary_path = writer.write_evaluation_summary(evaluation_summary)

    passed_cases = sum(1 for payload in case_results if (payload.get("evaluation") or {}).get("passed"))
    completed_cases = len(case_results)
    run_record.total_cases = len(cases)
    run_record.completed_cases = completed_cases
    run_record.passed_cases = passed_cases
    run_record.failed_cases = completed_cases - passed_cases
    run_record.accuracy = round(passed_cases / completed_cases * 100, 2) if completed_cases else 0.0
    run_record.token_stats = build_token_stats(case_results)
    run_record.output_paths = {
        "run_dir": str(run_dir),
        "run_log": str(run_log_path),
        "predictions": str(predictions_path),
        "evaluation_summary": str(evaluation_summary_path),
        "cases_dir": str(writer.cases_dir),
    }
    run_record.finished_at = (finished_at or datetime.now(timezone.utc)).isoformat()
    run_path = writer.write_run(run_record)
    return run_path, evaluation_summary_path, predictions_path


class RunState:
    def __init__(
        self,
        *,
        run_id: str,
        run_dir: Path,
        benchmark_id: str,
        split: str,
        connector_config: ConnectorConfig,
        agent_config: AgentConfig,
        experiment_config: ExperimentConfig,
        started_at: datetime,
        failure_analysis: bool = False,
        success_analysis: bool = False,
        failure_agent: str | None = None,
    ) -> None:
        self.run_id = run_id
        self.run_dir = run_dir
        self.case_result_payloads: list[dict[str, Any]] = []
        self.passed_cases = 0
        self.failed_cases = 0
        self.repo_root = Path(__file__).resolve().parents[3]
        self.run_record = RunRecord(
            run_id=run_id,
            benchmark_id=benchmark_id,
            split=split,
            config={
                "connector": asdict(connector_config),
                "agent": asdict(agent_config),
                "experiment": {
                    "split": experiment_config.split,
                    "limit": experiment_config.limit,
                    "indices": experiment_config.indices,
                    "tags": experiment_config.tags,
                    "tag": experiment_config.tag,
                },
                "failure_analysis": failure_analysis,
                "success_analysis": success_analysis,
                "failure_agent": failure_agent,
            },
            started_at=started_at.isoformat(),
            git=_git_metadata(self.repo_root),
        )

    def initialize(self, writer: ResultWriter) -> Path:
        snapshot_path = self.run_dir / "source_snapshot.tar.gz"
        if _snapshot_source(self.repo_root / "src" / "dbagent", snapshot_path):
            logger.info("source_snapshot_written path=%s", snapshot_path)
        return writer.write_run(self.run_record)

    def record_case_result(self, payload: dict[str, Any]) -> None:
        evaluation = payload.get("evaluation") or {}
        if evaluation.get("passed"):
            self.passed_cases += 1
        else:
            self.failed_cases += 1
        self.case_result_payloads.append(payload)

    def finalize(
        self,
        *,
        writer: ResultWriter,
        cases: list[Any],
        predictions_path: Path,
        run_log_path: Path,
    ) -> tuple[Path, Path, Path]:
        return finalize_run_outputs(
            run_record=self.run_record,
            run_id=self.run_id,
            run_dir=self.run_dir,
            writer=writer,
            cases=cases,
            case_results=self.case_result_payloads,
            predictions_path=predictions_path,
            run_log_path=run_log_path,
        )
