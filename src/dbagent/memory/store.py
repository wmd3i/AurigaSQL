"""LanceDB-backed exemplar store (adapted from SimpleMem's LanceDB + Qwen stack).

One table ``exemplars`` per run. Retrieval is DB-scoped (a metadata pre-filter on
``db_id``) with self-exclusion (``source_case_id``), vector-searched by cosine, and
gated by a similarity threshold ``tau``. Writes happen only on a passing case.

All public methods swallow their own errors (log + continue): memory is an
enhancement and must never turn a passing benchmark case into a run failure.
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TABLE = "exemplars"

SOLVED_EXAMPLES_HEADER = (
    "Solved examples on this database (reference only — adapt to the current "
    "question, do not copy):"
)


def _esc(value: Any) -> str:
    """Escape a value for a LanceDB SQL ``where`` clause (single-quote doubling)."""
    return str(value).replace("'", "''")


def _db_scope(task) -> str:
    """The database key retrieval is scoped by. BIRD uses ``db_id``; bird-interact-a
    uses ``selected_database``. Fall back across both so scoping works for either."""
    ir = task.input_record or {}
    return str(ir.get("db_id") or ir.get("selected_database") or "")


class MemoryStore:
    def __init__(
        self,
        lancedb_dir: str | Path,
        embedder,
        *,
        top_k: int = 3,
        tau: float = 0.75,
        log_path: str | Path | None = None,
    ) -> None:
        import lancedb

        self.embedder = embedder
        self.top_k = top_k
        self.tau = tau
        self.log_path = Path(log_path) if log_path else None

        Path(lancedb_dir).mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(str(lancedb_dir))
        self._table = None  # created lazily on first write

    # -- internals -----------------------------------------------------------
    def _table_handle(self):
        if self._table is not None:
            return self._table
        if _TABLE in self.db.table_names():
            self._table = self.db.open_table(_TABLE)
        return self._table

    def _log(self, case_id: str, r: int, retrieved_ids: list[str], top_sim: float | None) -> None:
        if not self.log_path:
            return
        rec = {
            "case_id": str(case_id),
            "r": r,
            "retrieved_ids": retrieved_ids,
            "top_sim": top_sim,
        }
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # -- public API ----------------------------------------------------------
    def retrieve(self, task) -> tuple[list[dict], int]:
        """Return (hits, r): the confident same-DB exemplars, and the fired flag."""
        table = self._table_handle()
        if table is None or table.count_rows() == 0:
            self._log(task.case_id, 0, [], None)
            return [], 0

        db_id = _db_scope(task)
        where = (
            f"db_id = '{_esc(db_id)}' AND source_case_id != '{_esc(task.case_id)}'"
        )
        try:
            qv = self.embedder.embed_query(task.user_question)
            rows = (
                table.search(qv)
                .metric("cosine")
                .where(where, prefilter=True)
                .limit(self.top_k)
                .to_list()
            )
        except Exception as exc:  # noqa: BLE001 - memory must not break a case
            logger.warning("memory_retrieve_failed case_id=%s error=%s", task.case_id, exc)
            self._log(task.case_id, 0, [], None)
            return [], 0

        # LanceDB cosine: _distance = 1 - cosine_similarity.
        scored = [(1.0 - float(row["_distance"]), row) for row in rows]
        hits = [(sim, row) for sim, row in scored if sim >= self.tau]
        top_sim = scored[0][0] if scored else None

        for sim, row in hits:  # popularity / recency bookkeeping
            try:
                self.db.open_table(_TABLE).update(
                    where=f"id = '{_esc(row['id'])}'",
                    values={"hits": int(row.get("hits", 0)) + 1, "last_used": int(task.case_index)},
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory_update_failed id=%s error=%s", row.get("id"), exc)

        result = [row for _, row in hits]
        r = 1 if hits else 0
        self._log(task.case_id, r, [row["id"] for row in result], top_sim)
        return result, r

    def format_block(self, hits: list[dict]) -> str:
        """Render retrieved exemplars as the labeled few-shot block."""
        if not hits:
            return ""
        lines = [SOLVED_EXAMPLES_HEADER]
        for h in hits:
            lines.append(f"Q: {h['question']}")
            lines.append(f"SQL: {h['sql']}")
            lines.append("")
        return "\n".join(lines) + "\n"

    def write(self, task, final_sql: str | None) -> None:
        """Append a verified exemplar (call only on a passing case)."""
        if not final_sql:
            return
        try:
            row = {
                "id": uuid.uuid4().hex,
                "source_case_id": str(task.case_id),
                "db_id": _db_scope(task),
                "question": task.user_question,
                "sql": final_sql,
                "vector": self.embedder.embed_document(task.user_question),
                "order": int(task.case_index),
                "hits": 0,
                "last_used": -1,
            }
            if self._table is None and _TABLE not in self.db.table_names():
                self._table = self.db.create_table(_TABLE, data=[row])
            else:
                self._table_handle().add([row])
        except Exception as exc:  # noqa: BLE001 - memory must not break a case
            logger.warning("memory_write_failed case_id=%s error=%s", task.case_id, exc)
