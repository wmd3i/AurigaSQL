"""Agent interaction tools shared by AurigaSQL product flows.

This module owns the non-database tools that the SQL agent can use alongside
SQLite, DuckDB, PostgreSQL, or MySQL tools: static knowledge lookups, column
meaning lookups, and clarifying ``ask`` calls.

The IPC protocol is intentionally tiny: the in-process agent writes request JSON
files into a shared directory and waits for matching response JSON files from a
host-side responder. Only the clarification question crosses this boundary.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

KNOWLEDGE_VISIBLE_FIELDS = ("id", "knowledge", "description", "definition")

ASK_STUB_RESPONSE = (
    "No clarification is available in this non-interactive run. "
    "Proceed with your best interpretation of the query."
)

# Clarification remains pending while a user is reading and answering it.
ASK_IPC_TIMEOUT_SECS = 180.0
ASK_IPC_POLL_SECS = 0.2

def ask_via_ipc(ipc_dir: str, question: str) -> str:
    """Round-trip one clarifying question to the host user simulator."""
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
    try:
        req_path.unlink()
    except FileNotFoundError:
        pass
    return ASK_STUB_RESPONSE


def _visible_fields(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: entry[key] for key in KNOWLEDGE_VISIBLE_FIELDS if key in entry}


def _normalize_column_lookup(column_meanings: dict[str, str]) -> dict[str, str]:
    """Index column meanings by ``"table|column"`` (lowercased)."""
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


def build_interaction_tool_schemas(
    *,
    include_ask: bool = True,
    include_column_meanings: bool = True,
    include_knowledge: bool = True,
) -> list[dict[str, Any]]:
    """LLM tool schemas for optional knowledge and product clarification."""
    tools: list[dict[str, Any]] = []
    if include_column_meanings:
        tools.extend([
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
        ])
    if include_knowledge:
        tools.extend([
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
        ])
    if include_ask:
        tools.append({
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
        })
    return tools


def build_interaction_handlers(
    kb_entries: list[dict[str, Any]] | None,
    column_meanings: dict[str, str] | None,
    ipc_dir: str | None = None,
) -> dict[str, Callable[..., str]]:
    """Handlers bound to the per-case visible knowledge and column meanings."""
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
