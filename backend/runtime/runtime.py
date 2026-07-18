"""Session runtime that adapts the reusable SQL Agent to the AurigaSQL API."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

# Support direct module execution when PYTHONPATH is not configured.
REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

# The agent imports psycopg v3, but its used API is compatible with psycopg2.
try:
    import psycopg  # type: ignore  # noqa: F401
except Exception:
    try:
        import psycopg2  # type: ignore
        from psycopg2 import sql as psycopg2_sql  # type: ignore

        psycopg2.sql = psycopg2_sql
        sys.modules.setdefault("psycopg", psycopg2)
        sys.modules.setdefault("psycopg.sql", psycopg2_sql)
    except Exception:
        pass

from dbagent.agents.dbtools import DBType, MYSQL_DSN_ENV, POSTGRES_DSN_ENV
from dbagent.agents.sql_agent import SQLAgent
from dbagent.config import AgentConfig
from dbagent.connectors.base import LLMConnector, LLMResponse, UsageStats

from runtime.events import EventBus
from runtime.trajectory_adapter import final_answer_events, trajectory_to_agent_events
from data.engines.models import DataSourceSession
from data.engines.session import cleanup_data_session, execute_final_sql
from shared.config import LOGS_DIR
from shared.model_registry import get_spec, resolve_credentials


_FENCED_SQL_RE = re.compile(
    r"```[ \t]*(?:sql|postgresql|postgres|mysql|sqlite|duckdb)\b[^\r\n]*[\r\n]?(.*?)```",
    re.IGNORECASE | re.DOTALL,
)
_SQL_START_RE = re.compile(r"\b(?:SELECT|WITH|EXPLAIN)\b", re.IGNORECASE)


def extract_executable_sql(*candidates: str) -> str:
    """Extract host-executable SQL from agent output."""
    for text in candidates:
        if not text:
            continue
        match = _FENCED_SQL_RE.search(text)
        if match:
            return match.group(1).strip()
    for text in candidates:
        if not text:
            continue
        match = _SQL_START_RE.search(text)
        if match:
            return text[match.start():].strip()
    return ""


class RegistryLiteLLMConnector(LLMConnector):
    """LiteLLM connector backed by the BFF's frontend model registry."""

    def __init__(self, model_id: Optional[str]) -> None:
        import litellm

        self._litellm = litellm
        self.spec = get_spec(model_id)
        self.provider_name = self.spec.provider
        self.model_name = self.spec.litellm_model

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": self.spec.litellm_model,
            "messages": messages,
            "tools": tools or None,
            "temperature": 0.0,
            "max_tokens": self.spec.max_tokens,
            "num_retries": 0,
        }
        kwargs.update(resolve_credentials(self.spec))
        response = self._litellm.completion(**kwargs)
        message = response.choices[0].message
        usage = response.usage
        usage_details = getattr(usage, "completion_tokens_details", None) if usage else None
        raw_message = message.model_dump(exclude_none=True)
        return LLMResponse(
            content=message.content or "",
            finish_reason=response.choices[0].finish_reason,
            raw_message=raw_message,
            tool_calls=raw_message.get("tool_calls") or [],
            usage=UsageStats(
                prompt_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
                completion_tokens=getattr(usage, "completion_tokens", None) if usage else None,
                reasoning_tokens=getattr(usage_details, "reasoning_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None) if usage else None,
            ),
            raw_response=response.model_dump(),
        )


@dataclass
class SessionState:
    task_id: str
    data_session: DataSourceSession
    user_query: str
    model: Optional[str]
    parent_context: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    trajectory: list[dict[str, Any]] = field(default_factory=list)
    agent_events: list[dict[str, Any]] = field(default_factory=list)
    running: bool = False
    done: bool = False
    cancelled: bool = False
    error: Optional[str] = None
    final_text: str = ""
    final_sql: str = ""
    final_result: str = ""
    ipc_dir: Optional[Path] = None
    pending_question: Optional[str] = None
    pending_answer: Optional[asyncio.Future[str]] = None


class DbAgentRuntime:
    def __init__(self) -> None:
        self.event_bus = EventBus()
        self._sessions: dict[str, SessionState] = {}
        self._lock = asyncio.Lock()
        # Database tools read DSNs from process environment variables, so turns
        # must remain serial while each session installs its own connection.
        self._agent_run_lock = asyncio.Lock()

    async def init_session(
        self,
        *,
        task_id: str,
        data_session: DataSourceSession,
        user_query: str,
        model: Optional[str],
        parent_context: Optional[str] = None,
    ) -> dict[str, Any]:
        async with self._lock:
            state = SessionState(
                task_id=task_id,
                data_session=data_session,
                user_query=user_query,
                model=model,
                parent_context=parent_context,
            )
            self._sessions[task_id] = state
        return {
            "task_id": task_id,
            "mode": "dbagent",
            "session_id": task_id,
            "agent_available": True,
            "adk_available": True,
        }

    async def run_turn(
        self,
        *,
        task_id: str,
        message: str,
        model: Optional[str] = None,
    ) -> dict[str, Any]:
        state = self._sessions.get(task_id)
        if state is None:
            raise KeyError(f"no session for task {task_id}")
        if model:
            state.model = model
        state.cancelled = False
        state.running = True
        user_evt = {"type": "user_message", "text": message}
        self._publish_event(state, user_evt)

        start_index = len(state.trajectory)
        stop_aux = asyncio.Event()
        stream_task: Optional[asyncio.Task[int]] = None
        ipc_task: Optional[asyncio.Task[None]] = None
        streamed_index = start_index
        try:
            async with self._agent_run_lock:
                state.ipc_dir = self._ipc_dir_for_task(task_id)
                stream_task = asyncio.create_task(self._stream_trajectory_file(state, start_index, stop_aux))
                ipc_task = asyncio.create_task(self._bridge_ipc_requests(state, stop_aux))
                output = await asyncio.to_thread(self._run_agent_sync, state, message)
                stop_aux.set()
                streamed_index = await stream_task
                await ipc_task
            state.trajectory = list(output.trajectory or [])
            self._publish_trajectory_items(
                state,
                state.trajectory[streamed_index:],
                skip_leading_user=streamed_index == start_index,
            )

            state.final_text = output.final_text or ""
            state.final_sql = extract_executable_sql(output.final_sql or "", state.final_text)
            if state.final_sql and not state.cancelled:
                state.final_result = await self._execute_final_sql(task_id, state.final_sql)
                for evt in final_answer_events(state.final_sql, state.final_result, state.final_text):
                    self._publish_event(state, evt)
            elif not state.cancelled:
                self._publish_event(state, {"type": "final_answer", "text": state.final_text, "sql": None, "result": None})
                self._publish_event(state, {"type": "done"})
            state.done = True
            response = "Cancelled." if state.cancelled else state.final_text or state.final_result or "Done."
        except Exception as exc:
            stop_aux.set()
            if state.pending_answer and not state.pending_answer.done():
                state.pending_answer.set_result("The agent stopped before this question could be answered.")
            if stream_task:
                await stream_task
            if ipc_task:
                await ipc_task
            state.error = f"{type(exc).__name__}: {exc}"
            state.done = True
            for evt in [{"type": "error", "message": state.error}, {"type": "done"}]:
                self._publish_event(state, evt)
            response = state.error
        finally:
            stop_aux.set()
            if state.pending_answer and not state.pending_answer.done():
                state.pending_answer.set_result("The request was stopped before an answer was provided.")
            state.pending_question = None
            state.pending_answer = None
            state.running = False

        return {
            "task_id": task_id,
            "mode": "dbagent",
            "session_id": task_id,
            "response": response,
            "state": self.public_state(task_id),
            "agent_available": True,
            "adk_available": True,
        }

    def request_cancel(self, task_id: str) -> bool:
        state = self._sessions.get(task_id)
        if state is None:
            return False
        state.cancelled = True
        state.done = True
        if state.pending_answer and not state.pending_answer.done():
            state.pending_answer.set_result("The user cancelled the request.")
        self._publish_event(state, {"type": "done"})
        return True

    async def answer_user(self, task_id: str, answer: str) -> bool:
        state = self._sessions.get(task_id)
        if state is None:
            raise KeyError(f"no session for task {task_id}")
        if state.pending_answer is None or state.pending_answer.done():
            return False
        state.pending_answer.set_result(answer)
        state.pending_question = None
        return True

    def public_state(self, task_id: str) -> dict[str, Any]:
        state = self._sessions.get(task_id)
        if state is None:
            raise KeyError(f"no session for task {task_id}")
        return {
            "task_id": state.task_id,
            "source": state.data_session.public_source(),
            "db_name": state.data_session.source.display_name,
            "db_names": [state.data_session.source.display_name],
            "user_query": state.user_query,
            "agent_events": state.agent_events,
            "adk_events": state.agent_events,
            "tool_trajectory": state.trajectory,
            "task_done": state.done,
            "_cancelled": state.cancelled,
            "_freechat": True,
            "_last_sql_raw": state.final_sql,
            "_freechat_result": state.final_result,
            "pending_question": state.pending_question,
            "error": state.error,
        }

    def session_response(self, task_id: str) -> dict[str, Any]:
        return {"task_id": task_id, "mode": "dbagent", "state": self.public_state(task_id)}

    def cleanup(self, task_id: str) -> None:
        state = self._sessions.pop(task_id, None)
        if state is not None:
            cleanup_data_session(state.data_session)

    def _run_agent_sync(self, state: SessionState, message: str):
        connector = RegistryLiteLLMConnector(state.model)
        agent = SQLAgent(
            connector,
            AgentConfig(max_steps=30),
        )
        prompt = self._build_prompt(state, message)
        run_config = state.data_session.run_config
        previous_postgres_dsn = os.environ.get(POSTGRES_DSN_ENV)
        previous_mysql_dsn = os.environ.get(MYSQL_DSN_ENV)
        if run_config.db_type == DBType.POSTGRES and run_config.db_path:
            os.environ[POSTGRES_DSN_ENV] = run_config.db_path
        if run_config.db_type == DBType.MYSQL and run_config.db_path:
            os.environ[MYSQL_DSN_ENV] = run_config.db_path
        try:
            persist_agent_logs = os.getenv("AURIGASQL_ENABLE_LLM_LOGGER", "").lower() == "true"
            kwargs: dict[str, Any] = {
                "ipc_dir": str(state.ipc_dir) if state.ipc_dir else None,
            }
            if run_config.kb_entries is not None or run_config.column_meanings is not None:
                kwargs.update(
                    {
                        "kb_entries": run_config.kb_entries,
                        "column_meanings": run_config.column_meanings,
                    }
                )
            return agent.run(
                prompt=prompt,
                db_type=run_config.db_type,
                db_path=run_config.db_path,
                log_dir=self._log_dir_for_task(state.task_id) if persist_agent_logs else None,
                task_id=state.task_id,
                resume_messages=state.trajectory or None,
                **kwargs,
            )
        finally:
            if previous_postgres_dsn is None:
                os.environ.pop(POSTGRES_DSN_ENV, None)
            else:
                os.environ[POSTGRES_DSN_ENV] = previous_postgres_dsn
            if previous_mysql_dsn is None:
                os.environ.pop(MYSQL_DSN_ENV, None)
            else:
                os.environ[MYSQL_DSN_ENV] = previous_mysql_dsn

    def _build_prompt(self, state: SessionState, message: str) -> str:
        run_config = state.data_session.run_config
        has_knowledge = run_config.kb_entries is not None or run_config.column_meanings is not None
        parts = [
            run_config.prompt_prefix,
            "Answer the user's natural-language data question by inspecting the live database and producing SQL.",
            "If the request is ambiguous, use the ask tool to request one focused clarification from the user.",
            "Run and validate your SQL before finalizing it.",
            "The final answer must contain only one SQL query in a single fenced code block like ```sql ... ```, with no explanation before or after it.",
        ]
        if has_knowledge:
            parts.insert(
                2,
                "Use the column-meaning and external-knowledge tools when they can clarify the schema or business terminology.",
            )
        if state.parent_context:
            parts.append(f"Parent canvas context:\n{state.parent_context}")
        parts.append(f"User question:\n{message}")
        return "\n\n".join(parts)

    def _log_dir_for_task(self, task_id: str) -> Path:
        path = LOGS_DIR / "dbagent_runs" / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _ipc_dir_for_task(self, task_id: str) -> Path:
        path = LOGS_DIR / "dbagent_ipc" / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _publish_event(self, state: SessionState, event: dict[str, Any]) -> None:
        index = len(state.agent_events)
        state.agent_events.append(event)
        self.event_bus.publish(state.task_id, event, index)

    def _publish_trajectory_items(
        self,
        state: SessionState,
        items: list[dict[str, Any]],
        *,
        skip_leading_user: bool,
    ) -> None:
        new_items = list(items)
        if skip_leading_user:
            while new_items and new_items[0].get("role") == "system":
                new_items = new_items[1:]
            if new_items and new_items[0].get("role") == "user":
                new_items = new_items[1:]
        for evt in trajectory_to_agent_events(new_items):
            if state.cancelled:
                break
            self._publish_event(state, evt)

    async def _stream_trajectory_file(
        self,
        state: SessionState,
        start_index: int,
        stop_event: asyncio.Event,
    ) -> int:
        path = self._log_dir_for_task(state.task_id) / "trajectory.json"
        cursor = start_index
        while not stop_event.is_set():
            cursor = self._publish_trajectory_file(state, path, cursor, start_index)
            await asyncio.sleep(0.25)
        return self._publish_trajectory_file(state, path, cursor, start_index)

    def _publish_trajectory_file(
        self,
        state: SessionState,
        path: Path,
        cursor: int,
        start_index: int,
    ) -> int:
        if not path.exists():
            return cursor
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return cursor
        if not isinstance(data, list) or len(data) <= cursor:
            return cursor
        state.trajectory = data
        self._publish_trajectory_items(state, data[cursor:], skip_leading_user=cursor == start_index)
        return len(data)

    async def _bridge_ipc_requests(self, state: SessionState, stop_event: asyncio.Event) -> None:
        ipc_dir = state.ipc_dir
        if ipc_dir is None:
            return
        handled: set[str] = set()
        while not stop_event.is_set():
            for req_path in sorted(ipc_dir.glob("req_*.json")):
                if req_path.name in handled:
                    continue
                handled.add(req_path.name)
                await self._handle_ipc_request(state, req_path)
            await asyncio.sleep(0.2)

    async def _handle_ipc_request(self, state: SessionState, req_path: Path) -> None:
        try:
            payload = json.loads(req_path.read_text(encoding="utf-8"))
        except Exception:
            return
        token = req_path.stem.replace("req_", "", 1)
        resp_path = req_path.with_name(f"resp_{token}.json")
        kind = payload.get("kind")
        if kind == "ask":
            answer = await self._request_user_answer(state, str(payload.get("question") or ""))
            self._write_ipc_response(resp_path, {"answer": answer})
        else:
            self._write_ipc_response(resp_path, {"error": f"Unsupported IPC request kind: {kind}"})

    async def _request_user_answer(self, state: SessionState, question: str) -> str:
        if state.cancelled:
            return "The user cancelled the request."
        loop = asyncio.get_running_loop()
        state.pending_question = question
        state.pending_answer = loop.create_future()
        self._publish_event(state, {"type": "clarification_request", "question": question})
        return await state.pending_answer

    @staticmethod
    def _write_ipc_response(path: Path, payload: dict[str, Any]) -> None:
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp_path, path)

    async def _execute_final_sql(self, task_id: str, sql: str) -> str:
        state = self._sessions.get(task_id)
        if state is None:
            return f"SQL Error: no session for task {task_id}"
        return await asyncio.to_thread(execute_final_sql, state.data_session, sql)
