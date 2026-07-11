"""BIRD-Interact-specific agent tools and action costs.

These tools mirror the environment action space of the original
``bird_interact_agent`` (knowledge-base lookup and column-meaning lookup) so the
agent can resolve ambiguous queries the way a-mode intends. Unlike the shared
Postgres tools, they serve *static, public* dataset data (external knowledge and
column meanings) that is injected through the worker payload rather than read
from the dataset directory -- the dataset dir holds the merged ground truth
(``sol_sql``) and is deliberately kept out of the agent's container.

The knowledge served here must already be the *visible* subset: entries hidden
by ``knowledge_ambiguity`` (``deleted_knowledge``) are filtered out upstream by
the benchmark (``_visible_knowledge``), preserving the intended ambiguity that
the agent is meant to detect.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

# Fields exposed for a knowledge entry, matching the original
# ``KNOWLEDGE_VISIBLE_FIELDS`` in bird_interact_agent.
KNOWLEDGE_VISIBLE_FIELDS = ("id", "knowledge", "description", "definition")

# Per-action costs ported verbatim from BIRD-Interact (bird-interact-project-rule;
# see batch_run_bird_interact/main.py ACTION_COSTS). The names are the original
# action names; the agent loop maps the tools it exposes onto these costs.
BIRD_INTERACT_ACTION_COSTS: dict[str, float] = {
    "ask": 2.0,
    "submit": 3.0,
    "execute": 1.0,
    "get_schema": 1.0,
    "get_all_column_meanings": 1.0,
    "get_column_meaning": 0.5,
    "get_all_external_knowledge_names": 0.5,
    "get_knowledge_definition": 0.5,
    "get_all_knowledge_definitions": 1.0,
}

# Map the tools this runner actually exposes onto the original action costs.
# The shared Postgres tools stand in for the original ``execute``/``get_schema``
# environment actions; the knowledge/column tools keep their own names and costs.
# ``submit`` is the explicit terminal action: the agent submits by calling it,
# and the cost is charged per call out of the reserved submit budget.
BIRD_INTERACT_TOOL_COSTS: dict[str, float] = {
    # schema inspection ~ get_schema
    "list_postgres_tables": BIRD_INTERACT_ACTION_COSTS["get_schema"],
    "describe_postgres_table": BIRD_INTERACT_ACTION_COSTS["get_schema"],
    # query execution ~ execute
    "sample_postgres_rows": BIRD_INTERACT_ACTION_COSTS["execute"],
    "run_postgres_readonly": BIRD_INTERACT_ACTION_COSTS["execute"],
    "explain_postgres_query": BIRD_INTERACT_ACTION_COSTS["execute"],
    "validate_postgres_query": BIRD_INTERACT_ACTION_COSTS["execute"],
    "bash": BIRD_INTERACT_ACTION_COSTS["execute"],
    # knowledge / column-meaning lookups
    "get_all_column_meanings": BIRD_INTERACT_ACTION_COSTS["get_all_column_meanings"],
    "get_column_meaning": BIRD_INTERACT_ACTION_COSTS["get_column_meaning"],
    "get_all_external_knowledge_names": BIRD_INTERACT_ACTION_COSTS["get_all_external_knowledge_names"],
    "get_knowledge_definition": BIRD_INTERACT_ACTION_COSTS["get_knowledge_definition"],
    "get_all_knowledge_definitions": BIRD_INTERACT_ACTION_COSTS["get_all_knowledge_definitions"],
    # clarification ~ ask (answered by the host-side user simulator over IPC)
    "ask": BIRD_INTERACT_ACTION_COSTS["ask"],
    # terminal submission ~ submit
    "submit": BIRD_INTERACT_ACTION_COSTS["submit"],
}

# Returned by ask() only when no user-simulator channel is wired (e.g. a run
# without host-side clarification): the action exists (and costs budget) but
# yields no clarifying signal.
ASK_STUB_RESPONSE = (
    "No clarification is available in this non-interactive run. "
    "Proceed with your best interpretation of the query."
)

# How long the in-container ask() tool waits for the host simulator to answer
# before giving up and falling back to the stub response.
ASK_IPC_TIMEOUT_SECS = 180.0
ASK_IPC_POLL_SECS = 0.2

# How long the in-container submit() tool waits for the host to grade the SQL.
# Grading clones a DB from the template and runs the test cases, so it can take
# noticeably longer than an ask() round-trip.
SUBMIT_IPC_TIMEOUT_SECS = 600.0
SUBMIT_IPC_POLL_SECS = 0.2


def ask_via_ipc(ipc_dir: str, question: str) -> str:
    """Round-trip one clarifying question to the host user simulator.

    Writes a request file into the shared (bind-mounted) IPC dir and polls for
    the matching response file. Only the question and the host's natural-language
    answer cross this boundary -- never the ground truth the simulator holds.
    """
    ipc_path = Path(ipc_dir)
    try:
        ipc_path.mkdir(parents=True, exist_ok=True)
    except Exception:
        return ASK_STUB_RESPONSE
    token = uuid.uuid4().hex
    req_path = ipc_path / f"req_{token}.json"
    resp_path = ipc_path / f"resp_{token}.json"
    tmp_path = req_path.with_suffix(req_path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps({"kind": "ask", "question": question}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp_path, req_path)

    deadline = time.monotonic() + ASK_IPC_TIMEOUT_SECS
    while time.monotonic() < deadline:
        if resp_path.exists():
            try:
                answer = json.loads(resp_path.read_text(encoding="utf-8")).get("answer")
            except Exception:
                answer = None
            for path in (resp_path, req_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            return answer if answer else ASK_STUB_RESPONSE
        time.sleep(ASK_IPC_POLL_SECS)
    # Timed out: clean up our request so the host doesn't answer a dead channel.
    try:
        req_path.unlink()
    except FileNotFoundError:
        pass
    return ASK_STUB_RESPONSE


def submit_via_ipc(ipc_dir: str, sql: str) -> tuple[bool | None, str, dict[str, Any]]:
    """Round-trip one final-SQL submission to the host grader.

    Writes a request file into the shared (bind-mounted) IPC dir and polls for
    the matching response. Returns ``(passed, message)`` where ``passed`` is
    ``True``/``False`` for a graded verdict, or ``None`` when the channel is
    unavailable or times out (the caller should then end the phase and let the
    host fall back to scoring the final answer). Only the SQL and the host's
    pass/fail + short reason and phase metadata cross this boundary -- never the
    gold SQL.
    """
    ipc_path = Path(ipc_dir)
    try:
        ipc_path.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None, "", {}
    token = uuid.uuid4().hex
    req_path = ipc_path / f"req_{token}.json"
    resp_path = ipc_path / f"resp_{token}.json"
    tmp_path = req_path.with_suffix(req_path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps({"kind": "submit", "sql": sql}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp_path, req_path)

    deadline = time.monotonic() + SUBMIT_IPC_TIMEOUT_SECS
    while time.monotonic() < deadline:
        if resp_path.exists():
            try:
                payload = json.loads(resp_path.read_text(encoding="utf-8"))
            except Exception:
                payload = None
            for path in (resp_path, req_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            if not isinstance(payload, dict) or "passed" not in payload:
                return None, "", {}
            return bool(payload.get("passed")), str(payload.get("message", "")), payload
        time.sleep(SUBMIT_IPC_POLL_SECS)
    # Timed out: clean up our request so the host doesn't grade a dead channel.
    try:
        req_path.unlink()
    except FileNotFoundError:
        pass
    return None, "", {}


@dataclass(slots=True)
class TerminalVerdict:
    """Outcome of a terminal-tool call, consumed by the agent loop.

    ``passed`` is ``True`` (accepted -> end the phase), ``False`` (rejected ->
    retry while budget remains), or ``None`` (ungraded: no channel / timeout /
    error -> end the phase and let the host score the final answer).
    """

    final_sql: str
    passed: bool | None
    message: str = ""
    phase: int | None = None
    attempt: int | None = None
    reward: float | None = None
    has_follow_up: bool | None = None
    follow_up_query: str = ""


def build_submit_terminal_handler(
    ipc_dir: str | None,
) -> Callable[[dict[str, Any]], TerminalVerdict]:
    """Handler for the terminal ``submit(sql)`` action.

    Extracts the submitted SQL and, when a host grader is wired (``ipc_dir``),
    grades it live over IPC. Returns a :class:`TerminalVerdict` that the agent
    loop turns into terminate-or-retry control flow -- keeping the IPC/grading
    specifics out of the generic loop.
    """

    def handler(arguments: dict[str, Any]) -> TerminalVerdict:
        sql = str((arguments or {}).get("sql", "")).strip()
        if not ipc_dir:
            return TerminalVerdict(final_sql=sql, passed=None)
        passed, message, metadata = submit_via_ipc(ipc_dir, sql)
        return TerminalVerdict(
            final_sql=sql,
            passed=passed,
            message=message,
            phase=metadata.get("phase") if isinstance(metadata.get("phase"), int) else None,
            attempt=metadata.get("attempt") if isinstance(metadata.get("attempt"), int) else None,
            reward=metadata.get("reward") if isinstance(metadata.get("reward"), (int, float)) else None,
            has_follow_up=metadata.get("has_follow_up") if isinstance(metadata.get("has_follow_up"), bool) else None,
            follow_up_query=str(metadata.get("follow_up_query", "")),
        )

    return handler


def _visible_fields(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: entry[key] for key in KNOWLEDGE_VISIBLE_FIELDS if key in entry}


def _normalize_column_lookup(column_meanings: dict[str, str]) -> dict[str, str]:
    """Index column meanings by ``"table|column"`` (lowercased).

    The raw dataset keys are ``"db|table|column"``; the original lookup keys off
    ``f"{db}|{table}|{column}"``. Since a case targets a single database, we drop
    the leading db segment and key on the trailing ``table|column`` so lookups
    are robust regardless of the db name passed in.
    """
    lookup: dict[str, str] = {}
    for raw_key, value in column_meanings.items():
        parts = raw_key.lower().split("|")
        if len(parts) >= 2:
            lookup["|".join(parts[-2:])] = value
    return lookup


def get_all_column_meanings(column_meanings: dict[str, str]) -> str:
    if not column_meanings:
        return "No column meanings available."
    return json.dumps(column_meanings, ensure_ascii=False, indent=2)


def get_column_meaning(
    column_meanings: dict[str, str], table_name: str, column_name: str
) -> str:
    lookup = _normalize_column_lookup(column_meanings)
    key = f"{table_name.lower()}|{column_name.lower()}"
    return lookup.get(key, "Column meaning not found")


def get_all_external_knowledge_names(kb_entries: list[dict[str, Any]]) -> str:
    names = [entry["knowledge"] for entry in kb_entries if "knowledge" in entry]
    return json.dumps(names, ensure_ascii=False)


def get_knowledge_definition(
    kb_entries: list[dict[str, Any]], knowledge_name: str
) -> str:
    for entry in kb_entries:
        if entry.get("knowledge") == knowledge_name:
            return json.dumps(_visible_fields(entry), ensure_ascii=False, indent=2)
    return "Knowledge not found or not accessible."


def get_all_knowledge_definitions(kb_entries: list[dict[str, Any]]) -> str:
    visible = [_visible_fields(entry) for entry in kb_entries]
    return json.dumps(visible, ensure_ascii=False, indent=2)


def build_bird_interact_tool_schemas() -> list[dict[str, Any]]:
    """LLM tool schemas for the BIRD-Interact knowledge/column-meaning actions."""
    return [
        {
            "type": "function",
            "function": {
                "name": "get_all_column_meanings",
                "description": "Get the natural-language meaning of every column in the database.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_column_meaning",
                "description": "Get the natural-language meaning of a single column.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "table_name": {"type": "string", "description": "Table name."},
                        "column_name": {"type": "string", "description": "Column name."},
                    },
                    "required": ["table_name", "column_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_all_external_knowledge_names",
                "description": "List the names of all available external knowledge entries.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_knowledge_definition",
                "description": "Get the definition of one external knowledge entry by name.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "knowledge_name": {"type": "string", "description": "External knowledge name."},
                    },
                    "required": ["knowledge_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_all_knowledge_definitions",
                "description": "Get the definitions of all available external knowledge entries.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ask",
                "description": (
                    "Ask the user one clarifying question when the query is ambiguous. "
                    "The user answers in natural language and will refuse questions that "
                    "go beyond resolving the request's ambiguity."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "description": "A single clarifying question."},
                    },
                    "required": ["question"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "submit",
                "description": (
                    "Submit your SQL answer for the current phase. It is graded immediately: "
                    "if it passes the phase ends; if it fails you receive the reason and may "
                    "revise and submit again while you still have budget. Pass exactly one "
                    "SQL statement."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sql": {"type": "string", "description": "The final SQL query to submit."},
                    },
                    "required": ["sql"],
                },
            },
        },
    ]


def build_bird_interact_handlers(
    kb_entries: list[dict[str, Any]] | None,
    column_meanings: dict[str, str] | None,
    ipc_dir: str | None = None,
) -> dict[str, Callable[..., str]]:
    """Handlers bound to the per-case visible knowledge and column meanings.

    When ``ipc_dir`` is set, ``ask`` round-trips the question to the host user
    simulator over the shared IPC channel; otherwise it returns the no-signal
    stub. (``submit`` shares the same channel but is handled in the agent loop.)
    """
    kb = kb_entries or []
    cols = column_meanings or {}

    def ask_handler(**kw: Any) -> str:
        if not ipc_dir:
            return ASK_STUB_RESPONSE
        return ask_via_ipc(ipc_dir, str(kw.get("question", "")))

    return {
        "get_all_column_meanings": lambda **_: get_all_column_meanings(cols),
        "get_column_meaning": lambda **kw: get_column_meaning(
            cols, kw["table_name"], kw["column_name"]
        ),
        "get_all_external_knowledge_names": lambda **_: get_all_external_knowledge_names(kb),
        "get_knowledge_definition": lambda **kw: get_knowledge_definition(
            kb, kw["knowledge_name"]
        ),
        "get_all_knowledge_definitions": lambda **_: get_all_knowledge_definitions(kb),
        "ask": ask_handler,
    }
