from __future__ import annotations

from pathlib import Path
from statistics import pstdev
from typing import Any


def format_result_path(path: str | Path | None, base_dir: Path) -> str | None:
    if path is None:
        return None
    path_obj = Path(path)
    try:
        return str(path_obj.resolve().relative_to(base_dir.resolve()))
    except Exception:
        return str(path)


def build_evaluation_summary(
    *,
    run_id: str,
    run_dir: Path,
    cases: list[Any],
    case_results: list[dict[str, Any]],
    predictions_path: Path,
) -> dict[str, Any]:
    failure_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    db_counts: dict[str, int] = {}
    passed_case_ids: list[str] = []
    failed_case_ids: list[str] = []
    case_summaries: list[dict[str, Any]] = []

    for case_result in case_results:
        evaluation = case_result.get("evaluation") or {}
        input_record = case_result.get("input") or {}
        reference = case_result.get("reference") or {}
        prediction = case_result.get("prediction") or {}
        artifacts = case_result.get("artifacts") or {}
        logs = case_result.get("logs") or {}
        passed = bool(evaluation.get("passed"))
        error_type = evaluation.get("error_type") or "passed"
        status = case_result.get("status") or ("success" if passed else "failed")
        db_id = input_record.get("db_id")

        status_counts[status] = status_counts.get(status, 0) + 1
        if db_id:
            db_counts[db_id] = db_counts.get(db_id, 0) + 1
        if passed:
            passed_case_ids.append(case_result["case_id"])
        else:
            failed_case_ids.append(case_result["case_id"])
            failure_counts[error_type] = failure_counts.get(error_type, 0) + 1

        case_summaries.append(
            {
                "case_id": case_result.get("case_id"),
                "case_index": case_result.get("case_index"),
                "passed": passed,
                "status": status,
                "error_type": None if passed else error_type,
                "score": evaluation.get("score"),
                "mode": evaluation.get("mode"),
                "question": input_record.get("question"),
                "db_id": db_id,
                "question_id": input_record.get("question_id") or reference.get("question_id"),
                "prediction_sql": prediction.get("final_sql"),
                "gold_sql": reference.get("gold_sql"),
                "evaluation_details": evaluation.get("details") or {},
                "error": case_result.get("error"),
                "artifacts": {
                    "case_result_path": format_result_path(artifacts.get("case_result_path"), run_dir),
                    "trajectory": format_result_path(logs.get("trajectory"), run_dir),
                    "llm_responses": format_result_path(logs.get("llm_responses"), run_dir),
                },
            }
        )

    return {
        "run_id": run_id,
        "benchmark_id": case_results[0].get("benchmark_id") if case_results else None,
        "split": case_results[0].get("split") if case_results else None,
        "total_cases": len(cases),
        "completed_cases": len(case_results),
        "passed_cases": len(passed_case_ids),
        "failed_cases": len(failed_case_ids),
        "passed_case_ids": passed_case_ids,
        "failed_case_ids": failed_case_ids,
        "status_counts": status_counts,
        "failure_counts": failure_counts,
        "db_counts": db_counts,
        "predictions_path": format_result_path(predictions_path, run_dir),
        "case_summaries": case_summaries,
    }


def build_token_stats(case_results: list[dict[str, Any]]) -> dict[str, Any]:
    token_fields = ("prompt_tokens", "completion_tokens", "total_tokens")
    completed_cases = len(case_results)
    cases_with_usage = 0
    cases_with_call_count = 0
    call_counts: list[int] = []
    token_values = {field: [] for field in token_fields}

    for case_result in case_results:
        llm = case_result.get("llm") or {}
        call_count = llm.get("call_count")
        if isinstance(call_count, int):
            cases_with_call_count += 1
            call_counts.append(call_count)

        usage = llm.get("usage") or {}
        has_usage = False
        for field in token_fields:
            value = usage.get(field)
            if isinstance(value, int):
                has_usage = True
                token_values[field].append(value)
            else:
                token_values[field].append(0)
        if has_usage:
            cases_with_usage += 1

    llm_calls = {
        "total": sum(call_counts),
        "avg_per_case": round(sum(call_counts) / completed_cases, 2) if completed_cases else 0.0,
        "min_per_case": min(call_counts) if call_counts else 0,
        "max_per_case": max(call_counts) if call_counts else 0,
    }
    token_stats: dict[str, Any] = {
        "completed_cases": completed_cases,
        "cases_with_usage": cases_with_usage,
        "cases_with_call_count": cases_with_call_count,
        "llm_calls": llm_calls,
    }
    for field, values in token_values.items():
        token_stats[field] = summarize_values(values)
    return token_stats


def summarize_values(values: list[int]) -> dict[str, Any]:
    if not values:
        return {
            "total": 0,
            "avg_per_case": 0.0,
            "min_per_case": 0,
            "max_per_case": 0,
            "std_per_case": 0.0,
        }
    return {
        "total": sum(values),
        "avg_per_case": round(sum(values) / len(values), 2),
        "min_per_case": min(values),
        "max_per_case": max(values),
        "std_per_case": round(pstdev(values), 2),
    }
