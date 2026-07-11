"""Host-side responder for the in-container ``ask`` and ``submit`` actions.

A single file-based request/response channel: while the agent runs (blocking
``docker exec``), a daemon thread polls one shared, bind-mounted directory for
request files written by container tools, computes a response, and writes the
matching response file. Only the request and the response cross this boundary --
never any ground truth the host holds.

Both tools share the directory and file-name convention; each request carries a
``"kind"`` so the responder can dispatch it:

- ``ask`` (``{"kind": "ask", "question": ...}``) is answered via a ``simulator``
  (``answer(question) -> str``), returning ``{"answer": ...}``.
- ``submit`` (``{"kind": "submit", "sql": ...}``) is graded via a ``scorer``
  (``evaluate(sql) -> (passed, message)`` or a dict with ``passed`` /
  ``message`` plus optional phase metadata), returning that verdict. The scorer
  records each attempt so the benchmark can read the verdicts back after the run.

The runner owns this mechanism; the simulator/scorer is supplied by the benchmark.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

REQUEST_GLOB = "req_*.json"
_FALLBACK_ANSWER = "I'm not sure I understand your question."
_FALLBACK_MESSAGE = "The submission could not be graded."


class Simulator(Protocol):
    def answer(self, question: str) -> str: ...


class Scorer(Protocol):
    def evaluate(self, sql: str) -> tuple[bool, str] | dict[str, Any]: ...


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


class IpcResponder:
    """Daemon-thread watcher that serves ``ask`` and ``submit`` requests.

    Both handlers are optional; a request whose ``kind`` has no configured handler
    gets a safe fallback response.
    """

    def __init__(
        self,
        ipc_dir: Path,
        *,
        simulator: Simulator | None = None,
        scorer: Scorer | None = None,
        poll_interval: float = 0.2,
    ) -> None:
        self.ipc_dir = Path(ipc_dir)
        self.simulator = simulator
        self.scorer = scorer
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.ipc_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._drain()
            except Exception:
                logger.warning("ipc responder loop error", exc_info=True)
            self._stop.wait(self.poll_interval)
        # Final drain so a request issued just before stop is still served.
        try:
            self._drain()
        except Exception:
            logger.warning("ipc responder final drain error", exc_info=True)

    def _drain(self) -> None:
        for req_path in sorted(self.ipc_dir.glob(REQUEST_GLOB)):
            resp_path = self.ipc_dir / req_path.name.replace("req_", "resp_", 1)
            if resp_path.exists():
                continue
            try:
                request = json.loads(req_path.read_text(encoding="utf-8"))
            except Exception:
                # Partially written / unreadable; retry next tick.
                continue
            response = self._handle(request)
            _atomic_write_json(resp_path, response)
            try:
                req_path.unlink()
            except FileNotFoundError:
                pass

    def _handle(self, request: dict[str, Any]) -> dict[str, Any]:
        # Default to "ask" so a request without a kind keeps the original behavior.
        kind = str(request.get("kind") or "ask")
        if kind == "submit":
            return self._handle_submit(request)
        return self._handle_ask(request)

    def _handle_ask(self, request: dict[str, Any]) -> dict[str, Any]:
        question = str(request.get("question", "")).strip()
        logger.info("ask_request question_chars=%d", len(question))
        if self.simulator is None or not question:
            return {"answer": _FALLBACK_ANSWER}
        try:
            answer = self.simulator.answer(question)
        except Exception:
            logger.warning("ask simulator failed", exc_info=True)
            answer = _FALLBACK_ANSWER
        return {"answer": answer}

    def _handle_submit(self, request: dict[str, Any]) -> dict[str, Any]:
        sql = str(request.get("sql", "")).strip()
        logger.info("submit_request sql_chars=%d", len(sql))
        if self.scorer is None:
            return {"passed": False, "message": _FALLBACK_MESSAGE}
        try:
            verdict = self.scorer.evaluate(sql)
        except Exception:
            logger.warning("submit scorer failed", exc_info=True)
            return {"passed": False, "message": _FALLBACK_MESSAGE}
        if isinstance(verdict, dict):
            return {
                **verdict,
                "passed": bool(verdict.get("passed")),
                "message": str(verdict.get("message", "")),
            }
        passed, message = verdict
        return {"passed": bool(passed), "message": str(message)}
