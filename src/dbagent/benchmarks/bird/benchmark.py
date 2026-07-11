from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
from dbagent.benchmarks.base import BenchmarkAdapter, BenchmarkCase, EvaluationRecord, TaskSpec

from .setup import bird_dev_ready, prepare_bird_dev
from .utils import _normalize_sql, _execute_sql, _results_match

class BirdBenchmark(BenchmarkAdapter):
    benchmark_id = "bird"
    docker_execution_scope = "run"
    docker_image = "dbagent-bird-agent"
    dockerfile_path = None
    docker_build_context = None

    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir.expanduser().resolve()
        self.dockerfile_path = self.workdir / "src" / "dbagent" / "benchmarks" / "bird" / "Dockerfile"
        self.docker_build_context = self.workdir
        self.bird_root = self.workdir / "datasets" / "bird_dev"
        # Dataset file is overridable via BIRD_DEV_FILE (default dev.json). A value
        # ending in .jsonl/.ndjson is parsed line-by-line (see iter_cases); an
        # absolute path is used as-is, otherwise it is resolved under bird_root.
        # Lets us point BIRD at a subset like dev500.jsonl without a code change.
        dev_file = os.environ.get("BIRD_DEV_FILE", "dev.json")
        dev_path = Path(dev_file)
        self.dev_json_path = dev_path if dev_path.is_absolute() else self.bird_root / dev_file
        self.db_root = self.bird_root / "dev_databases"
        self.docker_host_workspace = self.db_root
        self.downloads_dir = self.workdir / "downloads"
        self.archive_path = self.downloads_dir / "bird_dev.zip"
        self._prepare_dataset_if_needed()

    def iter_cases(
        self,
        split: str,
        limit: int | None = None,
    ) -> list[BenchmarkCase]:
        if split != "dev":
            raise ValueError(f"BIRD currently supports only split=dev, got {split}")
        text = self.dev_json_path.read_text()
        if self.dev_json_path.suffix in (".jsonl", ".ndjson"):
            data = [json.loads(line) for line in text.splitlines() if line.strip()]
        else:
            data = json.loads(text)

        indices = list(range(len(data)))
        if limit is not None:
            indices = indices[:limit]

        return [
            BenchmarkCase(
                case_id=str(index),
                case_index=index,
                split=split,
                payload=data[index],
            )
            for index in indices
        ]

    def build_task(self, case: BenchmarkCase) -> TaskSpec:
        item = case.payload
        db_id = item["db_id"]
        db_path = self.db_root / db_id / f"{db_id}.sqlite"
        knowledge = item.get("evidence", "")
        prompt = self._build_prompt(question=item["question"], db_path=db_path, knowledge=knowledge)
        return TaskSpec(
            benchmark_id=self.benchmark_id,
            case_id=case.case_id,
            case_index=case.case_index,
            split=case.split,
            prompt=prompt,
            user_question=item["question"],
            db_type="sqlite",
            db_path=str(db_path),
            input_record={
                "question": item["question"],
                "db_id": db_id,
                "db_path": str(db_path),
                "evidence": knowledge,
                "difficulty": item.get("difficulty", ""),
                "question_id": item.get("question_id"),
            },
            reference={
                "gold_sql": item.get("SQL", ""),
                "question_id": item.get("question_id"),
            },
            metadata={
                "task_workspace": str(self.db_root),
            },
        )

    def evaluate_prediction(self, task: TaskSpec, prediction_sql: str) -> EvaluationRecord:
        gold_sql = task.reference.get("gold_sql", "")
        db_path_str = task.input_record.get("db_path")
        normalized_pred = _normalize_sql(prediction_sql)
        normalized_gold = _normalize_sql(gold_sql)

        exact_match = bool(normalized_pred) and normalized_pred == normalized_gold
        details: dict[str, Any] = {
            "normalized_prediction": normalized_pred,
            "normalized_gold": normalized_gold,
            "exact_match": exact_match,
        }

        if not db_path_str:
            # No database to execute against; fall back to exact text match only.
            details["evaluation_error_reason"] = "missing_db_path"
            return EvaluationRecord(
                passed=exact_match,
                score=1.0 if exact_match else 0.0,
                mode="exact_match",
                details=details,
                error_type=None if exact_match else "evaluation_error",
            )

        db_path = Path(db_path_str)
        pred_ok, pred_result = _execute_sql(db_path, normalized_pred or prediction_sql)
        gold_ok, gold_result = _execute_sql(db_path, normalized_gold or gold_sql)
        details["prediction_execution"] = pred_result
        details["gold_execution"] = gold_result

        if pred_ok and gold_ok:
            execution_match = _results_match(pred_result, gold_result)
            details["execution_match"] = execution_match
            passed = execution_match or exact_match
            return EvaluationRecord(
                passed=passed,
                score=1.0 if passed else 0.0,
                mode="execution_match",
                details=details,
                error_type=None if passed else "wrong_answer",
            )

        return EvaluationRecord(
            passed=exact_match,
            score=1.0 if exact_match else 0.0,
            mode="execution_match",
            details=details,
            error_type="execution_error",
        )


    def export_predictions(self, run_dir: Path, sample_results: list[dict]) -> Path:
        payload: dict[str, str] = {}
        for sample in sample_results:
            case_index = sample["case_index"]
            db_id = sample["input"]["db_id"]
            prediction = sample["prediction"]["final_sql"]
            payload[str(case_index)] = f"{prediction}\t----- bird -----\t{db_id}"

        output_path = run_dir / "predictions.json"
        output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
        return output_path

    @staticmethod
    def _build_prompt(question: str, db_path: Path, knowledge: str) -> str:
        prompt = f"SQLite database path: {db_path}\n\n"
        if knowledge:
            prompt += (
                f"External Knowledge: {knowledge}\n\n"
                "The External Knowledge above defines how terms in the question map to this database -- "
                "treat those mappings as authoritative when writing your SQL.\n\n"
            )
        prompt += f"Question: {question}\n\n"
        prompt += (
            "Write a SQL query to answer this question. "
            "Only give the SQL query without any explanation or notes as the final answer."
        )
        return prompt

    def _prepare_dataset_if_needed(self) -> None:
        if bird_dev_ready(self.bird_root):
            return

        prepare_bird_dev(
            output_dir=self.bird_root,
            archive=self.archive_path,
            force=False,
            skip_download=False,
        )
