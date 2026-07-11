from __future__ import annotations

import argparse
import json
from pathlib import Path

from dbagent.benchmarks import build_benchmark
from dbagent.benchmarks.base import TaskSpec
from dbagent.results import RunRecord, ResultWriter, jsonify
from dbagent.runners.case_selection import select_cases
from dbagent.runners.run_state import finalize_run_outputs


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(jsonify(payload), indent=2, ensure_ascii=False), encoding="utf-8")


def _task_from_payload(benchmark_id: str, split: str, case, payload: dict) -> TaskSpec:
    input_record = dict(payload.get("input") or case.payload or {})
    reference = dict(payload.get("reference") or {})
    metadata = dict(payload.get("metadata") or {})

    return TaskSpec(
        benchmark_id=benchmark_id,
        case_id=payload.get("case_id") or case.case_id,
        case_index=payload.get("case_index", case.case_index),
        split=payload.get("split") or split,
        prompt="",
        user_question=input_record.get("question") or input_record.get("instruction") or "",
        db_type=str(input_record.get("type") or ""),
        db_path=input_record.get("db_path"),
        input_record=input_record,
        reference=reference,
        metadata=metadata,
    )


def reevaluate_run(run_dir: Path, workdir: Path) -> dict[str, int | float | str]:
    run_dir = run_dir.expanduser().resolve()
    workdir = workdir.expanduser().resolve()
    run_json_path = run_dir / "run.json"
    if not run_json_path.exists():
        raise FileNotFoundError(f"Run record not found: {run_json_path}")

    run_record = _load_json(run_json_path)
    benchmark_id = run_record["benchmark_id"]
    split = run_record["split"]
    experiment_config = ((run_record.get("config") or {}).get("experiment") or {})
    limit = experiment_config.get("limit")
    indices = experiment_config.get("indices")

    benchmark = build_benchmark(workdir, benchmark_id, split)
    all_cases = benchmark.iter_cases(split=split, limit=None)
    if indices is not None:
        cases = select_cases(all_cases, indices)
    elif limit is not None:
        cases = all_cases[:limit]
    else:
        cases = all_cases
    writer = ResultWriter(run_dir)

    updated_payloads: list[dict] = []
    changed_cases = 0
    old_passed = 0
    new_passed = 0

    for case in cases:
        result_path = run_dir / "cases" / case.case_id / "result.json"
        if not result_path.exists():
            raise FileNotFoundError(f"Missing case result: {result_path}")

        payload = _load_json(result_path)
        old_evaluation = dict(payload.get("evaluation") or {})
        old_passed += int(bool(old_evaluation.get("passed")))

        task = _task_from_payload(benchmark_id, split, case, payload)
        prediction = dict(payload.get("prediction") or {})
        prediction_value = benchmark.get_evaluation_prediction(task, prediction)
        evaluation = benchmark.evaluate_prediction(task, prediction_value or "")
        evaluation_payload = evaluation.to_dict()

        payload["evaluation"] = evaluation_payload
        payload["status"] = "success" if payload["evaluation"].get("passed") else "failed"
        _write_json(result_path, payload)
        updated_payloads.append(payload)

        if old_evaluation != payload["evaluation"]:
            changed_cases += 1
        new_passed += int(bool(payload["evaluation"].get("passed")))

    predictions_path = benchmark.export_predictions(run_dir, updated_payloads)
    run_record_model = RunRecord(**run_record)
    run_path, evaluation_summary_path, predictions_path = finalize_run_outputs(
        run_record=run_record_model,
        run_id=run_dir.name,
        run_dir=run_dir,
        writer=writer,
        cases=cases,
        case_results=updated_payloads,
        predictions_path=predictions_path,
        run_log_path=run_dir / "run.log",
    )

    return {
        "run_dir": str(run_dir),
        "run_path": str(run_path),
        "evaluation_summary_path": str(evaluation_summary_path),
        "benchmark_id": benchmark_id,
        "total_cases": len(cases),
        "changed_cases": changed_cases,
        "old_passed": old_passed,
        "new_passed": new_passed,
        "accuracy": run_record_model.accuracy,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Re-run benchmark evaluator functions on saved case results and rewrite aggregate outputs."
    )
    parser.add_argument("--run", required=True, help="Run directory to re-evaluate in place")
    parser.add_argument(
        "--workdir",
        default=Path(__file__).resolve().parents[3],
        help="Project root containing datasets/ and src/ (defaults to repo root)",
    )
    args = parser.parse_args()
    result = reevaluate_run(Path(args.run), Path(args.workdir))
    print(
        f"Re-evaluated {result['total_cases']} cases for {result['benchmark_id']} in {result['run_dir']}."
    )
    print(
        f"Passed: {result['old_passed']} -> {result['new_passed']} | "
        f"changed evaluations: {result['changed_cases']} | accuracy: {result['accuracy']:.2f}%"
    )


if __name__ == "__main__":
    main()
