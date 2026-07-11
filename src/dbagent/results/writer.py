from __future__ import annotations

import json
from pathlib import Path

from dbagent.results.models import RunRecord, CaseResult, jsonify


def _dump(value) -> str:
    # jsonify handles the known types; default=str is a last-resort guard so an
    # unexpected non-serializable value can never crash a whole run on write.
    return json.dumps(jsonify(value), indent=2, ensure_ascii=False, default=str)


class ResultWriter:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.cases_dir = run_dir / "cases"
        self.cases_dir.mkdir(parents=True, exist_ok=True)

    def case_dir(self, case_id: str) -> Path:
        path = self.cases_dir / case_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def case_result_path(self, case_id: str) -> Path:
        return self.case_dir(case_id) / "result.json"

    def write_run(self, run_record: RunRecord) -> Path:
        path = self.run_dir / "run.json"
        path.write_text(_dump(run_record.to_dict()), encoding="utf-8")
        return path

    def write_case_result(self, case_result: CaseResult) -> Path:
        path = self.case_result_path(case_result.case_id)
        path.write_text(_dump(case_result.to_dict()), encoding="utf-8")
        return path

    def write_evaluation_summary(self, summary: dict) -> Path:
        path = self.run_dir / "evaluation_summary.json"
        path.write_text(_dump(summary), encoding="utf-8")
        return path
