from __future__ import annotations

import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

from dbagent.benchmarks.base import BenchmarkAdapter, BenchmarkCase, EvaluationRecord, TaskSpec

from . import evaluator
from .setup import prepare_spider2_dbt


class Spider2DbtBenchmark(BenchmarkAdapter):
    benchmark_id = "spider2-dbt"
    docker_execution_scope = "case"
    docker_image = "dbagent-spider2-dbt-agent"
    dockerfile_path = None
    docker_build_context = None

    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir.expanduser().resolve()
        self.dockerfile_path = self.workdir / "src" / "dbagent" / "benchmarks" / "spider2_dbt" / "Dockerfile"
        self.docker_build_context = self.workdir
        self.datasets_root = self.workdir / "datasets"
        self.spider2_root = self.datasets_root / "Spider2"
        self.spider2_dbt_root = self.spider2_root / "spider2-dbt"
        self.examples_root = self.spider2_dbt_root / "examples"
        self.dataset_path = self.examples_root / "spider2-dbt.jsonl"
        self.gold_root = self.spider2_dbt_root / "evaluation_suite" / "gold"
        self.gold_metadata_path = self.gold_root / "spider2_eval.jsonl"
        self.run_dir: Path | None = None
        self.workspaces_dir: Path | None = None
        self.submission_dir: Path | None = None
        self._prepare_dataset_if_needed()
        self.gold_by_instance = self._load_gold_metadata()

    def start_run(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.workspaces_dir = run_dir / "workspaces"
        self.submission_dir = run_dir / "submission"
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)
        self.submission_dir.mkdir(parents=True, exist_ok=True)

    def iter_cases(self, split: str, limit: int | None = None) -> list[BenchmarkCase]:
        if split != "test":
            raise ValueError(f"Spider2-DBT currently supports only split=test, got {split}")
        data = self._load_jsonl(self.dataset_path)
        data, excluded_cases = self._exclude_data_error_cases(data)
        self._write_excluded_cases(excluded_cases)
        if limit is not None:
            data = data[:limit]
        # Per-case workspaces are keyed by instance_id; duplicates would collide under concurrency.
        counts = Counter(item["instance_id"] for item in data)
        dupes = sorted(iid for iid, n in counts.items() if n > 1)
        if dupes:
            raise ValueError(f"Duplicate instance_ids in dataset (unsafe for concurrency): {dupes}")
        return [
            BenchmarkCase(
                case_id=item["instance_id"],
                case_index=index,
                split=split,
                payload=item,
            )
            for index, item in enumerate(data)
        ]

    def build_task(self, case: BenchmarkCase) -> TaskSpec:
        if self.workspaces_dir is None:
            raise RuntimeError("Spider2DbtBenchmark.start_run must be called before build_task")
        item = case.payload
        instance_id = item["instance_id"]
        source_dir = self._validate_case_data(item)

        # Drop any prior workspace and re-copy source dir (including its .duckdb start DB) 
        # Hence, the agent always starts from an untouched copy.
        workspace_path = self.workspaces_dir / instance_id
        if workspace_path.exists():
            shutil.rmtree(workspace_path)
        shutil.copytree(source_dir, workspace_path)

        prompt = (
            f"Spider2-DBT instance: {instance_id}\n\n"
            f"Instruction:\n{item['instruction']}\n\n"
            f"Workspace: {workspace_path}\n\n"
            "Work only inside this workspace. Inspect the dbt project, edit SQL/YAML files "
            "as needed, run dbt locally, verify the produced artifact, and return the "
            "relative path of the final artifact to submit."
        )
        gold_record = self.gold_by_instance.get(instance_id, {})
        return TaskSpec(
            benchmark_id=self.benchmark_id,
            case_id=case.case_id,
            case_index=case.case_index,
            split=case.split,
            prompt=prompt,
            user_question=item["instruction"],
            db_type="duckdb",
            db_path=None,
            input_record={
                "instance_id": instance_id,
                "instruction": item["instruction"],
                "type": item.get("type", "DBT"),
            },
            reference={
                "gold_metadata": gold_record,
            },
            metadata={
                "task_workspace": str(workspace_path),
                "source_dir": str(source_dir),
            },
        )

    def get_evaluation_prediction(
        self,
        task: TaskSpec,
        prediction: dict[str, Any],
    ) -> str:
        return ""

    def evaluate_prediction(self, task: TaskSpec, prediction_sql: str) -> EvaluationRecord:
        instance_id = task.input_record["instance_id"]
        gold_record = self.gold_by_instance.get(instance_id)
        if not gold_record:
            return EvaluationRecord(
                passed=False,
                score=0.0,
                mode="spider2_dbt",
                details={"error": f"missing gold metadata for {instance_id}"},
                error_type="other",
            )

        answer = prediction_sql.strip()
        workspace_path = Path(task.metadata["task_workspace"])
        eval_metadata = gold_record["evaluation"]
        eval_metadatas = eval_metadata if isinstance(eval_metadata, list) else [eval_metadata]
        artifact_path, artifact_error = self._resolve_prediction_artifact(workspace_path, answer, eval_metadatas)
        details: dict[str, Any] = {
            "answer": answer,
            "artifact_path": str(artifact_path) if artifact_path else None,
            "artifact_error": artifact_error,
            "evaluations": [],
        }
        best_score = 0

        for metadata in eval_metadatas:
            score, eval_details = self._score_one(metadata, answer, artifact_path, instance_id)
            best_score = max(best_score, score)
            details["evaluations"].append(eval_details)

        passed = best_score == 1
        # Distinguish "scored and wrong" from "could not score": a sub-eval that
        # raised (comparator crash, missing gold artifact, unsupported func) is an
        # evaluation_error, not a wrong_answer. Otherwise these hide in the
        # wrong_answer bucket and a harness bug looks like a model failure.
        if passed:
            error_type = None
        elif any(e.get("failure_kind") == "evaluation_error" for e in details["evaluations"]):
            error_type = "evaluation_error"
        else:
            error_type = "wrong_answer"
        return EvaluationRecord(
            passed=passed,
            score=float(best_score),
            mode="spider2_dbt",
            details=details,
            error_type=error_type,
        )

    def export_predictions(self, run_dir: Path, sample_results: list[dict[str, Any]]) -> Path:
        submission_dir = run_dir / "submission"
        submission_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = submission_dir / "results_metadata.jsonl"
        entries: list[dict[str, Any]] = []

        for sample in sample_results:
            input_record = sample.get("input") or {}
            metadata = sample.get("metadata") or {}
            instance_id = input_record.get("instance_id") or sample["case_id"]
            task_workspace = metadata.get("task_workspace")
            answer = (sample["prediction"].get("final_artifact_path") or sample["prediction"].get("raw_text") or "").strip()
            gold_record = self.gold_by_instance.get(instance_id, {})
            eval_metadata = gold_record.get("evaluation", {})
            eval_metadatas = eval_metadata if isinstance(eval_metadata, list) else [eval_metadata]
            artifact_path = None
            if task_workspace:
                artifact_path, _ = self._resolve_prediction_artifact(Path(task_workspace), answer, eval_metadatas)
            if artifact_path and artifact_path.exists():
                instance_submission_dir = submission_dir / instance_id
                instance_submission_dir.mkdir(parents=True, exist_ok=True)
                destination = instance_submission_dir / artifact_path.name
                shutil.copy2(artifact_path, destination)
                entries.append(
                    {
                        "instance_id": instance_id,
                        "answer_type": "file",
                        "answer_or_path": artifact_path.name,
                    }
                )
            else:
                entries.append(
                    {
                        "instance_id": instance_id,
                        "answer_type": "answer",
                        "answer_or_path": answer,
                    }
                )

        with metadata_path.open("w", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return metadata_path

    def _prepare_dataset_if_needed(self) -> None:
        layout = prepare_spider2_dbt(self.workdir)
        self.datasets_root = layout["datasets_root"]
        self.spider2_root = layout["spider2_root"]
        self.spider2_dbt_root = layout["spider2_dbt_root"]
        self.examples_root = layout["examples_root"]
        self.dataset_path = layout["dataset_path"]
        self.gold_root = layout["gold_root"]
        self.gold_metadata_path = layout["gold_metadata_path"]

    def _score_one(
        self,
        eval_metadata: dict[str, Any],
        answer: str,
        artifact_path: Path | None,
        instance_id: str,
    ) -> tuple[int, dict[str, Any]]:
        func = eval_metadata["func"]
        params = dict(eval_metadata.get("parameters") or {})
        details: dict[str, Any] = {"func": func, "parameters": params}
        try:
            if func == "string_match":
                score = evaluator.string_match(answer, **params)
            elif func == "number_match":
                score = evaluator.number_match(answer, **params)
            elif func == "table_match":
                if artifact_path is None:
                    return 0, {**details, "error": "missing result artifact"}
                params["gold"] = self._resolve_gold_paths(instance_id, params["gold"], params.get("condition_tabs"))
                score = evaluator.table_match(artifact_path, **params)
            elif func == "duckdb_match":
                if artifact_path is None:
                    return 0, {**details, "error": "missing result artifact"}
                params["gold"] = self._resolve_gold_path(
                    instance_id,
                    params["gold"],
                    params.get("condition_tabs"),
                )
                score = evaluator.duckdb_match(artifact_path, **params)
            elif func == "tables_match":
                if artifact_path is None:
                    return 0, {**details, "error": "missing result artifact"}
                params["gold"] = self._resolve_gold_paths(instance_id, params["gold"], params.get("condition_tabs"))
                score = evaluator.tables_match([artifact_path], **params)
            else:
                return 0, {**details, "error": f"unsupported evaluation function: {func}", "failure_kind": "evaluation_error"}
        except Exception as exc:
            return 0, {**details, "error": str(exc), "failure_kind": "evaluation_error"}
        return int(score), {**details, "score": int(score)}

    def _resolve_gold_path(
        self,
        instance_id: str,
        relative_path: str | Path,
        condition_tabs: list[str] | None = None,
    ) -> Path:
        path = self.gold_root / instance_id / relative_path
        if path.exists():
            return path
        fallback = self._resolve_gold_filename_mismatch(instance_id, condition_tabs)
        if fallback is not None:
            return fallback
        raise FileNotFoundError(f"missing Spider2 gold artifact: {path}")

    def _resolve_gold_paths(
        self,
        instance_id: str,
        relative_paths: str | list[str],
        condition_tabs: list[str] | None = None,
    ) -> Path | list[Path]:
        if isinstance(relative_paths, list):
            return [self._resolve_gold_path(instance_id, path, condition_tabs) for path in relative_paths]
        return self._resolve_gold_path(instance_id, relative_paths, condition_tabs)

    def _resolve_gold_filename_mismatch(
        self,
        instance_id: str,
        condition_tabs: list[str] | None,
    ) -> Path | None:
        gold_dir = self.gold_root / instance_id
        if not gold_dir.exists():
            return None
        duckdb_files = sorted(gold_dir.glob("*.duckdb"))
        if not duckdb_files:
            return None
        if not condition_tabs:
            return duckdb_files[0] if len(duckdb_files) == 1 else None
        expected = set(condition_tabs)
        matching_files: list[Path] = []
        for candidate in duckdb_files:
            try:
                actual_tables = set(evaluator._duckdb_table_names(candidate))
            except Exception:
                continue
            if expected.issubset(actual_tables):
                matching_files.append(candidate)
        if len(matching_files) == 1:
            return matching_files[0]
        return None

    def _exclude_data_error_cases(self, data: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        runnable: list[dict[str, Any]] = []
        excluded: list[dict[str, Any]] = []
        for item in data:
            instance_id = item["instance_id"]
            try:
                self._validate_case_data(item)
            except FileNotFoundError as exc:
                excluded.append(
                    {
                        "case_id": instance_id,
                        "error_type": "data_error",
                        "reason": str(exc),
                    }
                )
            else:
                runnable.append(item)
        return runnable, excluded

    def _write_excluded_cases(self, excluded_cases: list[dict[str, Any]]) -> None:
        if self.run_dir is None:
            return
        path = self.run_dir / "excluded_cases.json"
        payload = {
            "benchmark_id": self.benchmark_id,
            "error_type": "data_error",
            "excluded_count": len(excluded_cases),
            "cases": excluded_cases,
        }
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    def _validate_case_data(self, item: dict[str, Any]) -> Path:
        instance_id = item["instance_id"]
        source_dir = self.examples_root / instance_id
        if not source_dir.exists():
            raise FileNotFoundError(f"Missing Spider2-DBT example directory: {source_dir}")
        if not any(source_dir.rglob("*.duckdb")):
            raise FileNotFoundError(
                "Spider2-DBT start database is missing for "
                f"{instance_id}: expected a .duckdb file under {source_dir}. "
                "Run the Spider2-DBT setup step first."
            )
        self._validate_start_database_tables(instance_id, source_dir)

        gold_record = self.gold_by_instance.get(instance_id, {})
        eval_metadata = gold_record.get("evaluation", {})
        eval_metadatas = eval_metadata if isinstance(eval_metadata, list) else [eval_metadata]
        for metadata in eval_metadatas:
            params = metadata.get("parameters") or {}
            gold_value = params.get("gold")
            if gold_value is not None:
                resolved_gold = self._resolve_gold_paths(instance_id, gold_value, params.get("condition_tabs"))
                self._validate_gold_tables(instance_id, resolved_gold, params.get("condition_tabs"))
        return source_dir

    def _validate_gold_tables(
        self,
        instance_id: str,
        gold_paths: Path | list[Path],
        condition_tabs: list[str] | None,
    ) -> None:
        if not condition_tabs:
            return
        paths = gold_paths if isinstance(gold_paths, list) else [gold_paths]
        duckdb_paths = [path for path in paths if path.suffix == ".duckdb"]
        if not duckdb_paths:
            return

        actual_tables: set[str] = set()
        for path in duckdb_paths:
            actual_tables.update(evaluator._duckdb_table_names(path))

        missing = sorted(set(condition_tabs) - actual_tables)
        if missing:
            gold_names = ", ".join(path.name for path in duckdb_paths)
            raise FileNotFoundError(
                "Spider2-DBT gold database is missing expected tables for "
                f"{instance_id}: missing {', '.join(missing)} in {gold_names}"
            )

    def _validate_start_database_tables(self, instance_id: str, source_dir: Path) -> None:
        expected_tables = self._declared_source_tables(source_dir)
        if not expected_tables:
            return

        actual_tables: set[str] = set()
        for db_path in source_dir.rglob("*.duckdb"):
            actual_tables.update(table.lower() for table in evaluator._duckdb_table_names(db_path))

        missing = sorted(table for table in expected_tables if table.lower() not in actual_tables)
        if missing:
            raise FileNotFoundError(
                "Spider2-DBT start database is missing declared source tables for "
                f"{instance_id}: missing {', '.join(missing)}"
            )

    def _declared_source_tables(self, source_dir: Path) -> list[str]:
        tables: list[str] = []
        for path in sorted((source_dir / "models").rglob("source_configs.yml")):
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            for source in data.get("sources") or []:
                for table in source.get("tables") or []:
                    if isinstance(table, dict) and isinstance(table.get("name"), str):
                        tables.append(table["name"])
        return tables

    def _resolve_prediction_artifact(
        self,
        workspace_path: Path,
        answer: str,
        eval_metadatas: list[dict[str, Any]],
    ) -> tuple[Path | None, str | None]:
        artifact_path, artifact_error = self._resolve_workspace_artifact(workspace_path, answer)
        if artifact_path is not None:
            return artifact_path, artifact_error

        inferred = self._infer_workspace_artifact(workspace_path, eval_metadatas)
        if inferred is not None:
            return inferred, None
        return None, artifact_error

    def _infer_workspace_artifact(
        self,
        workspace_path: Path,
        eval_metadatas: list[dict[str, Any]],
    ) -> Path | None:
        candidate_names: list[str] = []
        for metadata in eval_metadatas:
            params = metadata.get("parameters") or {}
            gold_value = params.get("gold")
            if isinstance(gold_value, str):
                candidate_names.append(Path(gold_value).name)
            elif isinstance(gold_value, list):
                candidate_names.extend(Path(value).name for value in gold_value)

        for candidate_name in candidate_names:
            matches = sorted(workspace_path.rglob(candidate_name))
            if len(matches) == 1 and matches[0].is_file():
                return matches[0]

        duckdb_files = sorted(workspace_path.rglob("*.duckdb"))
        if len(duckdb_files) == 1:
            return duckdb_files[0]
        return None

    @staticmethod
    def _resolve_workspace_artifact(workspace_path: Path, answer: str) -> tuple[Path | None, str | None]:
        if not answer:
            return None, "empty answer"
        trimmed_answer = answer.strip().strip("'\"")
        candidate_text = trimmed_answer
        if "\n" in trimmed_answer:
            for line in reversed(trimmed_answer.splitlines()):
                line = line.strip().strip("'\"")
                if not line:
                    continue
                if any(line.endswith(suffix) for suffix in (".duckdb", ".csv", ".parquet", ".json", ".db")):
                    candidate_text = line
                    break

        candidate = Path(candidate_text)
        if not candidate.is_absolute():
            candidate = workspace_path / candidate
        try:
            resolved = candidate.resolve()
            resolved.relative_to(workspace_path.resolve())
        except Exception:
            return None, f"artifact path is outside workspace: {candidate_text}"
        try:
            exists = resolved.exists()
        except OSError:
            return None, f"artifact path is invalid: {candidate_text}"
        if not exists:
            return None, f"artifact path does not exist: {resolved}"
        return resolved, None

    @staticmethod
    def _load_jsonl(path: Path) -> list[dict[str, Any]]:
        with path.open("r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def _load_gold_metadata(self) -> dict[str, dict[str, Any]]:
        if not self.gold_metadata_path.exists():
            return {}
        metadata = {
            item["instance_id"]: item
            for item in self._load_jsonl(self.gold_metadata_path)
        }
        self._patch_gold_filenames(metadata)
        return metadata

    def _patch_gold_filenames(self, metadata: dict[str, dict[str, Any]]) -> None:
        """Correct gold filenames in-memory when spider2_eval.jsonl names a file that
        does not exist but the gold directory contains a resolvable alternative."""
        for instance_id, record in metadata.items():
            eval_entries = record.get("evaluation", {})
            if not isinstance(eval_entries, list):
                eval_entries = [eval_entries]
            for entry in eval_entries:
                params = entry.get("parameters") or {}
                gold_value = params.get("gold")
                if not isinstance(gold_value, str):
                    continue
                declared = self.gold_root / instance_id / gold_value
                if declared.exists():
                    continue
                fallback = self._resolve_gold_filename_mismatch(instance_id, params.get("condition_tabs"))
                if fallback is not None:
                    params["gold"] = fallback.name
