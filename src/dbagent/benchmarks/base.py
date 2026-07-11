from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class BenchmarkCase:
    # stable string id for artifact paths (e.g. samples/{case_id}.json)
    case_id: str
    # position in the dataset (int)
    case_index: int
    split: str
    payload: dict[str, Any]


@dataclass(slots=True)
class TaskSpec:
    benchmark_id: str
    case_id: str
    case_index: int
    split: str
    prompt: str
    user_question: str
    db_type: str
    db_path: str | None
    input_record: dict[str, Any]
    reference: dict[str, Any]
    metadata: dict[str, Any] = field(default_factory=dict)


# error_type is None when a case passed; otherwise it is one of these:
# - "wrong_answer": the prediction ran but is not correct
# - "execution_error": the prediction is syntactically correct but fails at runtime
# - "runtime_error": agent crashed or timed out (no prediction produced)
# - "data_error": benchmark input/gold data is missing before the agent can run
# - "evaluation_error": the evaluation step could not score the case (e.g. db path
#   missing); see EvaluationRecord.details for the specific reason
# - "other": other error types
ERROR_TYPES = ("wrong_answer", "execution_error", "runtime_error", "data_error", "evaluation_error", "other")


@dataclass(slots=True)
class EvaluationRecord:
    # whether the prediction passed the evaluation
    passed: bool
    # 1.0 if passed, 0.0 if failed (TODO: partial credit?)
    score: float
    # evaluation mode (e.g., exact_match, execution_match)
    mode: str
    # debug / evidence for scoring
    details: dict[str, Any] = field(default_factory=dict)
    # error type: None when passed, otherwise one of ERROR_TYPES (see above).
    error_type: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class CaseOutcome:
    """Result of running one case: what the agent produced, how it scored, and the
    raw agent output the runner records. Returned by ``BenchmarkAdapter.run_case``.
    """
    # prediction payload persisted under CaseResult.prediction. Keys:
    # raw_text, final_sql, final_artifact_path.
    prediction: dict[str, Any]
    # host-side scoring of the prediction.
    evaluation: EvaluationRecord
    # the agent output dict (AgentRunOutput.to_dict) the runner reads for
    # llm_call_count / usage / trajectory_path / llm_responses_path. For a
    # multi-pass case this is the aggregated final-pass output.
    agent_output: dict[str, Any]


class BenchmarkAdapter(ABC):
    benchmark_id: str
    docker_execution_scope = "case"
    docker_image: str | None = None
    dockerfile_path: Path | None = None
    docker_build_context: Path | None = None

    def start_run(self, run_dir: Path) -> None:
        """Optional hook for benchmarks that need per-run workspaces."""
        pass

    def finish_run(self, run_dir: Path) -> None:
        """Optional hook for benchmarks that need per-run cleanup."""
        pass

    def get_evaluation_prediction(
        self,
        task: TaskSpec,
        prediction: dict[str, Any],
    ) -> str:
        return str(prediction.get("final_sql") or "")

    def run_case(self, task: TaskSpec, run_agent: Callable[..., dict]) -> CaseOutcome:
        """Drive one case from task to scored outcome.

        The default is a single agent pass followed by host-side scoring. A
        benchmark needing a different protocol (e.g. BIRD-Interact-a's strict
        two-phase interaction, where Phase 2 is only revealed after Phase 1 passes)
        overrides this and may call ``run_agent`` more than once.

        ``run_agent(**kwargs)`` runs exactly one agent pass into this case's
        container and returns the agent output dict; the benchmark stays free of
        container/IO knowledge. Recognised kwargs (see the runner): ``phase_label``,
        ``prompt_override``, ``agent_kwargs_override``.
        """
        output = run_agent()
        prediction = {
            "raw_text": output["final_text"],
            "final_sql": output["final_sql"],
            "final_artifact_path": output["final_artifact_path"],
        }
        prediction_value = self.get_evaluation_prediction(task, prediction)
        evaluation = self.evaluate_prediction(task, prediction_value or "")
        return CaseOutcome(prediction=prediction, evaluation=evaluation, agent_output=output)

    @abstractmethod
    def iter_cases(
        self,
        split: str,  # dataset partition, e.g. "dev", "train", "test"
        limit: int | None = None,  # first N cases in dataset order; None = all
    ) -> list[BenchmarkCase]:
        raise NotImplementedError

    @abstractmethod
    def build_task(self, case: BenchmarkCase) -> TaskSpec:
        raise NotImplementedError

    @abstractmethod
    def evaluate_prediction(self, task: TaskSpec, prediction_sql: str) -> EvaluationRecord:
        raise NotImplementedError

    @abstractmethod
    def export_predictions(
        self,
        run_dir: Path,
        sample_results: list[dict[str, Any]],
    ) -> Path:
        raise NotImplementedError

    @abstractmethod
    def _prepare_dataset_if_needed(self) -> None:
        raise NotImplementedError
