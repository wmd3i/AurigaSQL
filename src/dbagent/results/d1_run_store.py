from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN"
ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID"
DATABASE_ID_ENV = "CLOUDFLARE_D1_DATABASE_ID"

RUNS_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  benchmark_id TEXT,
  split TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  dataset_cases INTEGER NOT NULL DEFAULT 0,
  planned_cases INTEGER NOT NULL DEFAULT 0,
  artifact_root_path TEXT,
  git_commit TEXT,
  git_branch TEXT,
  tag TEXT,

  gpt_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (gpt_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  claude_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (claude_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  deepseek_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (deepseek_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped'))
);
""".strip()

CASES_SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error')),

  gpt_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (gpt_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  claude_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (claude_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  deepseek_analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (deepseek_analysis_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),

  PRIMARY KEY (run_id, case_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
""".strip()

CASES_STATUS_INDEX = "CREATE INDEX IF NOT EXISTS idx_cases_run_status ON cases (run_id, status);"
ANALYSIS_STATUSES = {"pending", "running", "completed", "failed", "skipped"}
ANALYSIS_CHANNEL_COLUMNS = {
    "gpt": "gpt_analysis_status",
    "claude": "claude_analysis_status",
    "deepseek": "deepseek_analysis_status",
}
TERMINAL_RUN_STATUSES = ("completed", "failed", "cancelled")
ANALYSIS_TARGET_CASE_STATUSES = ("failed", "error")


def _env(name: str) -> str | None:
    value = (os.environ.get(name) or "").strip()
    return value or None


def is_enabled() -> bool:
    load_dotenv(override=True)
    return all((_env(API_TOKEN_ENV), _env(ACCOUNT_ID_ENV), _env(DATABASE_ID_ENV)))


@dataclass(slots=True)
class AnalysisRun:
    run_id: str
    artifact_root_path: str | None


@dataclass(slots=True)
class AnalysisCase:
    case_id: str
    status: str
    analysis_status: str

    @property
    def gpt_analysis_status(self) -> str:
        return self.analysis_status


GptAnalysisRun = AnalysisRun
GptAnalysisCase = AnalysisCase


@dataclass(slots=True)
class D1RunStore:
    account_id: str
    database_id: str
    _client: object
    _schema_ensured: bool = False

    @classmethod
    def from_env(cls) -> D1RunStore | None:
        load_dotenv(override=True)
        api_token = _env(API_TOKEN_ENV)
        account_id = _env(ACCOUNT_ID_ENV)
        database_id = _env(DATABASE_ID_ENV)
        if not (api_token and account_id and database_id):
            return None
        try:
            from cloudflare import Cloudflare
        except Exception:
            logger.exception("d1_registry_import_failed")
            return None
        return cls(
            account_id=account_id,
            database_id=database_id,
            _client=Cloudflare(api_token=api_token),
        )

    def ensure_schema(self) -> None:
        if self._schema_ensured:
            return
        self._exec(RUNS_SCHEMA)
        self._exec(CASES_SCHEMA)
        self._exec(CASES_STATUS_INDEX)
        self._ensure_runs_columns()
        self._backfill_runs_columns()
        self._schema_ensured = True

    def upsert_run_started(
        self,
        *,
        run_id: str,
        owner: str,
        benchmark_id: str | None,
        split: str | None,
        provider: str | None,
        model: str | None,
        started_at: str,
        dataset_cases: int,
        planned_cases: int,
        artifact_root_path: str | None = None,
        git_commit: str | None = None,
        git_branch: str | None = None,
        tag: str | None = None,
    ) -> None:
        self.ensure_schema()
        self._exec(
            """
            INSERT INTO runs (
              run_id,
              owner,
              benchmark_id,
              split,
              provider,
              model,
              status,
              started_at,
              finished_at,
              dataset_cases,
              planned_cases,
              artifact_root_path,
              git_commit,
              git_branch,
              tag
            )
            VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), 'running', ?, NULL, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''))
            ON CONFLICT(run_id) DO UPDATE SET
              owner = excluded.owner,
              benchmark_id = excluded.benchmark_id,
              split = excluded.split,
              provider = excluded.provider,
              model = excluded.model,
              status = 'running',
              started_at = excluded.started_at,
              finished_at = NULL,
              dataset_cases = excluded.dataset_cases,
              planned_cases = excluded.planned_cases,
              artifact_root_path = excluded.artifact_root_path,
              git_commit = excluded.git_commit,
              git_branch = excluded.git_branch,
              tag = excluded.tag;
            """.strip(),
            [
                run_id,
                owner,
                benchmark_id or "",
                split or "",
                provider or "",
                model or "",
                started_at,
                str(dataset_cases),
                str(planned_cases),
                artifact_root_path or "",
                git_commit or "",
                git_branch or "",
                tag or "",
            ],
        )

    def update_run_status(
        self,
        *,
        run_id: str,
        status: str,
        finished_at: str | None = None,
        artifact_root_path: str | None = None,
    ) -> None:
        self.ensure_schema()
        self._exec(
            """
            UPDATE runs
            SET status = ?,
                finished_at = ?,
                artifact_root_path = COALESCE(NULLIF(?, ''), artifact_root_path)
            WHERE run_id = ?;
            """.strip(),
            [status, finished_at or "", artifact_root_path or "", run_id],
        )

    def delete_run(self, *, run_id: str) -> int:
        """Delete a run and its cases from the registry.

        Returns the number of case rows removed. Foreign-key cascade is not
        guaranteed to be enabled on D1, so cases are deleted explicitly first.
        """
        self.ensure_schema()
        case_rows = self._query_rows(
            "DELETE FROM cases WHERE run_id = ? RETURNING case_id;",
            [run_id],
        )
        self._exec("DELETE FROM runs WHERE run_id = ?;", [run_id])
        return len(case_rows)

    def upsert_case_result(self, *, run_id: str, case_id: str, status: str) -> None:
        self.ensure_schema()
        self._exec(
            """
            INSERT INTO cases (run_id, case_id, status)
            VALUES (?, ?, ?)
            ON CONFLICT(run_id, case_id) DO UPDATE SET
              status = excluded.status;
            """.strip(),
            [run_id, case_id, status],
        )

    def list_pending_analysis_runs(
        self,
        *,
        analysis_channel: str = "gpt",
        limit: int = 10,
        run_id: str | None = None,
        run_ids: list[str] | None = None,
    ) -> list[AnalysisRun]:
        """Return terminal runs whose selected analysis status has not started.

        ``run_ids`` restricts the result to a specific allow-list of runs (used by
        a priority worker); ``run_id`` is the single-run shorthand. When both are
        given they are unioned.
        """
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        where = [
            f"{column} = 'pending'",
            "status IN ('completed', 'failed', 'cancelled')",
        ]
        params: list[str] = []
        allow: list[str] = []
        if run_ids:
            allow.extend(run_ids)
        if run_id and run_id not in allow:
            allow.append(run_id)
        if allow:
            placeholders = ", ".join("?" for _ in allow)
            where.append(f"run_id IN ({placeholders})")
            params.extend(allow)
        params.append(str(limit))
        rows = self._query_rows(
            f"""
            SELECT run_id, artifact_root_path
            FROM runs
            WHERE {' AND '.join(where)}
            ORDER BY started_at ASC
            LIMIT ?;
            """.strip(),
            params,
        )
        return [
            AnalysisRun(
                run_id=str(row.get("run_id") or ""),
                artifact_root_path=str(row.get("artifact_root_path")) if row.get("artifact_root_path") else None,
            )
            for row in rows
            if row.get("run_id")
        ]

    def claim_run_analysis(self, *, run_id: str, analysis_channel: str = "gpt") -> bool:
        """Atomically mark one pending terminal run as running."""
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        other_running_guards = [
            f"{other_column} != 'running'"
            for other_channel, other_column in ANALYSIS_CHANNEL_COLUMNS.items()
            if other_channel != analysis_channel
        ]
        rows = self._query_rows(
            f"""
            UPDATE runs
            SET {column} = 'running'
            WHERE run_id = ?
              AND {column} = 'pending'
              AND status IN ('completed', 'failed', 'cancelled')
              AND {' AND '.join(other_running_guards)}
            RETURNING run_id;
            """.strip(),
            [run_id],
        )
        return bool(rows)

    def set_run_analysis_status(self, *, run_id: str, status: str, analysis_channel: str = "gpt") -> None:
        self._validate_analysis_status(status)
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        self._exec(
            f"UPDATE runs SET {column} = ? WHERE run_id = ?;",
            [status, run_id],
        )

    def list_analysis_cases(
        self,
        *,
        run_id: str,
        analysis_channel: str = "gpt",
        statuses: tuple[str, ...] | None = None,
        analysis_status: str | None = None,
        limit: int | None = None,
        exclude_sibling_completed: bool = False,
    ) -> list[AnalysisCase]:
        """List failed/error cases and their selected analysis state.

        When ``exclude_sibling_completed`` is set, cases that another analysis
        channel has already claimed (``running``) or finished (``completed``) are
        omitted, so a shared work queue never hands the same case to two models.
        """
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        statuses = statuses or ANALYSIS_TARGET_CASE_STATUSES
        placeholders = ", ".join("?" for _ in statuses)
        where = [f"status IN ({placeholders})"]
        params: list[str] = [run_id, *statuses]
        if analysis_status is not None:
            self._validate_analysis_status(analysis_status)
            where.append(f"{column} = ?")
            params.append(analysis_status)
        if exclude_sibling_completed:
            for other_channel, other_column in ANALYSIS_CHANNEL_COLUMNS.items():
                if other_channel != analysis_channel:
                    where.append(f"{other_column} NOT IN ('running', 'completed')")
        limit_sql = ""
        if limit is not None and limit > 0:
            limit_sql = " LIMIT ?"
            params.append(str(limit))
        rows = self._query_rows(
            f"""
            SELECT case_id, status, {column} AS analysis_status
            FROM cases
            WHERE run_id = ?
              AND {' AND '.join(where)}
            ORDER BY case_id{limit_sql};
            """.strip(),
            params,
        )
        return [
            AnalysisCase(
                case_id=str(row.get("case_id") or ""),
                status=str(row.get("status") or ""),
                analysis_status=str(row.get("analysis_status") or "pending"),
            )
            for row in rows
            if row.get("case_id")
        ]

    def claim_case_analysis(self, *, run_id: str, case_id: str, analysis_channel: str = "gpt", dedup: bool = False) -> AnalysisCase | None:
        """Atomically mark one pending failed/error case as running.

        When ``dedup`` is set, the case is also skipped if any sibling channel has
        already completed it, so two models never analyze the same case.
        """
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        blocked_states = ("running", "completed") if dedup else ("running",)
        blocked_sql = ", ".join(f"'{state}'" for state in blocked_states)
        other_guards = [
            f"{other_column} NOT IN ({blocked_sql})"
            for other_channel, other_column in ANALYSIS_CHANNEL_COLUMNS.items()
            if other_channel != analysis_channel
        ]
        rows = self._query_rows(
            f"""
            UPDATE cases
            SET {column} = 'running'
            WHERE run_id = ?
              AND case_id = ?
              AND status IN ('failed', 'error')
              AND {column} = 'pending'
              AND {' AND '.join(other_guards)}
            RETURNING case_id, status, {column} AS analysis_status;
            """.strip(),
            [run_id, case_id],
        )
        if not rows:
            return None
        row = rows[0]
        return AnalysisCase(
            case_id=str(row.get("case_id") or ""),
            status=str(row.get("status") or ""),
            analysis_status=str(row.get("analysis_status") or "running"),
        )

    def set_case_analysis_status(self, *, run_id: str, case_id: str, status: str, analysis_channel: str = "gpt") -> None:
        self._validate_analysis_status(status)
        self.ensure_schema()
        column = self._analysis_column(analysis_channel)
        self._exec(
            f"UPDATE cases SET {column} = ? WHERE run_id = ? AND case_id = ?;",
            [status, run_id, case_id],
        )

    def count_unanalyzed_cases(
        self,
        *,
        run_id: str,
        statuses: tuple[str, ...] | None = None,
    ) -> int:
        """Count target cases not yet completed by ANY analysis channel.

        Used to decide run-level completion under a shared/deduped case queue: a
        run's failure analysis is fully covered once this reaches 0, regardless of
        which model analyzed each case.
        """
        self.ensure_schema()
        statuses = statuses or ANALYSIS_TARGET_CASE_STATUSES
        placeholders = ", ".join("?" for _ in statuses)
        not_completed = " AND ".join(
            f"{column} != 'completed'" for column in ANALYSIS_CHANNEL_COLUMNS.values()
        )
        rows = self._query_rows(
            f"""
            SELECT COUNT(*) AS remaining
            FROM cases
            WHERE run_id = ?
              AND status IN ({placeholders})
              AND {not_completed};
            """.strip(),
            [run_id, *statuses],
        )
        if not rows:
            return 0
        try:
            return int(rows[0].get("remaining") or 0)
        except (TypeError, ValueError):
            return 0

    def reclaim_stale_running_analysis(self) -> dict[str, int]:
        """Reset every ``running`` analysis marker back to ``pending``.

        In a single-worker deployment there are no genuine in-flight analyses at
        process startup, so any ``running`` run- or case-level marker is a stale
        leftover from a previously killed worker. Such markers freeze progress: a
        run stuck ``running`` blocks the sibling model's run-level claim while its
        own slot skips it, and a case stuck ``running`` is never re-listed as
        pending yet is still counted as unanalyzed. Call this once on boot to
        self-heal so a hard kill can never wedge the worker.

        Returns a ``{"runs": n, "cases": m}`` count of reset markers.
        """
        self.ensure_schema()
        counts = {"runs": 0, "cases": 0}
        for column in ANALYSIS_CHANNEL_COLUMNS.values():
            run_rows = self._query_rows(
                f"UPDATE runs SET {column} = 'pending' WHERE {column} = 'running' RETURNING run_id;",
                [],
            )
            counts["runs"] += len(run_rows)
            case_rows = self._query_rows(
                f"UPDATE cases SET {column} = 'pending' WHERE {column} = 'running' RETURNING run_id;",
                [],
            )
            counts["cases"] += len(case_rows)
        return counts

    def list_pending_gpt_analysis_runs(
        self,
        *,
        limit: int = 10,
        run_id: str | None = None,
    ) -> list[AnalysisRun]:
        return self.list_pending_analysis_runs(analysis_channel="gpt", limit=limit, run_id=run_id)

    def claim_run_gpt_analysis(self, *, run_id: str) -> bool:
        return self.claim_run_analysis(run_id=run_id, analysis_channel="gpt")

    def set_run_gpt_analysis_status(self, *, run_id: str, status: str) -> None:
        self.set_run_analysis_status(run_id=run_id, status=status, analysis_channel="gpt")

    def list_gpt_analysis_cases(
        self,
        *,
        run_id: str,
        statuses: tuple[str, ...] | None = None,
        gpt_status: str | None = None,
        limit: int | None = None,
    ) -> list[AnalysisCase]:
        return self.list_analysis_cases(
            run_id=run_id,
            analysis_channel="gpt",
            statuses=statuses,
            analysis_status=gpt_status,
            limit=limit,
        )

    def claim_case_gpt_analysis(self, *, run_id: str, case_id: str) -> AnalysisCase | None:
        return self.claim_case_analysis(run_id=run_id, case_id=case_id, analysis_channel="gpt")

    def set_case_gpt_analysis_status(self, *, run_id: str, case_id: str, status: str) -> None:
        self.set_case_analysis_status(run_id=run_id, case_id=case_id, status=status, analysis_channel="gpt")

    def _exec(self, sql: str, params: list[str] | None = None) -> object:
        return self._client.d1.database.raw(
            database_id=self.database_id,
            account_id=self.account_id,
            sql=sql,
            params=params or [],
        )

    def _query_rows(self, sql: str, params: list[str] | None = None) -> list[dict[str, Any]]:
        response = self._exec(sql, params or [])
        try:
            payloads = list(response)
        except TypeError:
            payloads = []
        if payloads:
            payload = payloads[0]
            result = getattr(payload, "results", None)
            if result is not None:
                columns = list(getattr(result, "columns", None) or [])
                rows = list(getattr(result, "rows", None) or [])
                return [
                    {columns[idx]: row[idx] for idx in range(min(len(columns), len(row)))}
                    for row in rows
                ]

        result = getattr(response, "result", None)
        if isinstance(result, list) and result:
            first = result[0]
            raw_rows = getattr(first, "results", None)
            if isinstance(raw_rows, list):
                out = []
                for row in raw_rows:
                    if isinstance(row, dict):
                        out.append(row)
                    elif isinstance(row, (list, tuple)):
                        # PRAGMA/table_info compatibility path; not expected for worker queries.
                        out.append({str(idx): value for idx, value in enumerate(row)})
                return out
        return []

    def _analysis_column(self, analysis_channel: str) -> str:
        try:
            return ANALYSIS_CHANNEL_COLUMNS[analysis_channel]
        except KeyError as exc:
            allowed = ", ".join(sorted(ANALYSIS_CHANNEL_COLUMNS))
            raise ValueError(f"invalid analysis channel: {analysis_channel}; expected one of {allowed}") from exc

    def _validate_analysis_status(self, status: str) -> None:
        if status not in ANALYSIS_STATUSES:
            raise ValueError(f"invalid analysis status: {status}")

    def _ensure_runs_columns(self) -> None:
        for statement in (
            "ALTER TABLE runs ADD COLUMN owner TEXT NOT NULL DEFAULT '';",
            "ALTER TABLE runs ADD COLUMN benchmark_id TEXT;",
            "ALTER TABLE runs ADD COLUMN split TEXT;",
            "ALTER TABLE runs ADD COLUMN provider TEXT;",
            "ALTER TABLE runs ADD COLUMN model TEXT;",
            "ALTER TABLE runs ADD COLUMN dataset_cases INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE runs ADD COLUMN planned_cases INTEGER NOT NULL DEFAULT 0;",
            "ALTER TABLE runs ADD COLUMN artifact_root_path TEXT;",
            "ALTER TABLE runs ADD COLUMN git_commit TEXT;",
            "ALTER TABLE runs ADD COLUMN git_branch TEXT;",
            "ALTER TABLE runs ADD COLUMN tag TEXT;",
        ):
            self._exec_allow_duplicate_column(statement)

    def _backfill_runs_columns(self) -> None:
        run_columns = set(self._table_columns("runs"))

        artifact_root_expr = "artifact_root_path"
        if "artifact_root_path" in run_columns:
            if "run_json_path" in run_columns:
                artifact_root_expr = (
                    "CASE "
                    "WHEN artifact_root_path IS NULL OR artifact_root_path = '' THEN "
                    "substr(run_json_path, 1, length(run_json_path) - length('/run.json')) "
                    "ELSE artifact_root_path END"
                )
            elif "source_snapshot_path" in run_columns:
                artifact_root_expr = (
                    "CASE "
                    "WHEN artifact_root_path IS NULL OR artifact_root_path = '' THEN "
                    "substr(source_snapshot_path, 1, length(source_snapshot_path) - length('/source_snapshot.tar.gz')) "
                    "ELSE artifact_root_path END"
                )

        self._exec(
            f"""
            UPDATE runs
            SET owner = CASE
                  WHEN owner IS NULL OR owner = '' THEN
                    CASE
                      WHEN instr(run_id, '_') > 0 THEN substr(run_id, 1, instr(run_id, '_') - 1)
                      ELSE 'unknown'
                    END
                  ELSE owner
                END,
                benchmark_id = CASE
                  WHEN (benchmark_id IS NULL OR benchmark_id = '')
                       AND instr(run_id, '_') > 0
                       AND length(run_id) > instr(run_id, '_') + 20
                    THEN substr(
                      run_id,
                      instr(run_id, '_') + 1,
                      length(run_id) - instr(run_id, '_') - 20
                    )
                  ELSE benchmark_id
                END,
                dataset_cases = CASE
                  WHEN dataset_cases = 0 THEN (SELECT COUNT(*) FROM cases WHERE cases.run_id = runs.run_id)
                  ELSE dataset_cases
                END,
                planned_cases = CASE
                  WHEN planned_cases = 0 THEN (SELECT COUNT(*) FROM cases WHERE cases.run_id = runs.run_id)
                  ELSE planned_cases
                END,
                artifact_root_path = {artifact_root_expr};
            """.strip()
        )

    def _exec_allow_duplicate_column(self, sql: str) -> None:
        try:
            self._exec(sql)
        except Exception as exc:
            if "duplicate column name" in str(exc).lower():
                return
            raise

    def _table_columns(self, table_name: str) -> list[str]:
        response = self._exec(f"PRAGMA table_info({table_name});")
        rows = response.result[0].results
        return [str(row[1]) for row in rows]
