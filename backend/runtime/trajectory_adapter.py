"""Convert SQL agent trajectory records to frontend events."""

from __future__ import annotations

import json
from typing import Any, Iterable


def _safe_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _normalize_args(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    if tool_name in {"run_postgres_readonly", "validate_postgres_query"} and "sql" not in args:
        if "query" in args:
            return {**args, "sql": args["query"]}
    if tool_name == "ask" and "question" not in args:
        if "text" in args:
            return {**args, "question": args["text"]}
    return args


def _tool_call_id(item: dict[str, Any], index: int, call_index: int = 0) -> str:
    return str(item.get("id") or item.get("tool_call_id") or f"tool_{index}_{call_index}")


def trajectory_to_agent_events(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        role = item.get("role")
        if role == "system":
            continue
        if role == "user":
            message = str(item.get("content") or "")
            if message:
                events.append({"type": "user_message", "text": message})
            continue
        if role == "assistant":
            text = str(item.get("content") or "")
            if text.strip():
                events.append({"type": "assistant_text", "text": text, "final": False})
            for call_index, call in enumerate(item.get("tool_calls") or []):
                if not isinstance(call, dict):
                    continue
                fn = call.get("function") or {}
                name = str(fn.get("name") or "")
                if not name:
                    continue
                args = _normalize_args(name, _safe_args(fn.get("arguments")))
                events.append({
                    "type": "tool_call",
                    "name": name,
                    "id": _tool_call_id(call, index, call_index),
                    "args": args,
                })
            continue
        if role == "tool":
            name = str(item.get("name") or "")
            if not name:
                continue
            events.append({
                "type": "tool_result",
                "name": name,
                "id": _tool_call_id(item, index),
                "result": str(item.get("content") or ""),
            })
    return events


def final_answer_events(sql: str, result: str, final_text: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "final_answer",
            "text": final_text,
            "sql": sql,
            "result": result,
        },
        {"type": "done"},
    ]
