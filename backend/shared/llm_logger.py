import os
import json
import logging
import contextvars
import traceback as _tb
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

LOG_PATH = os.getenv("LLM_LOG_PATH", "logs/llm_calls.jsonl")
LOGGER_ENABLED = os.getenv("AURIGASQL_ENABLE_LLM_LOGGER", "").lower() == "true"
INPUT_TRUNC = 2000
OUTPUT_TRUNC = 5000

if LOGGER_ENABLED:
    Path(LOG_PATH).parent.mkdir(parents=True, exist_ok=True)

_current_task: contextvars.ContextVar[str] = contextvars.ContextVar("current_task", default="")


def set_task_context(task_id: str) -> None:
    """Associate subsequent LLM callback records with one API task."""
    _current_task.set(task_id or "")


def _trunc(s, n):
    if not s:
        return s
    s = str(s)
    return s if len(s) <= n else s[:n] + f"...<truncated {len(s) - n}>"


def _extract_messages(kwargs):
    msgs = kwargs.get("messages", []) or []
    out = []
    for m in msgs:
        content = m.get("content", "") if isinstance(m, dict) else ""
        out.append({
            "role": m.get("role", "?") if isinstance(m, dict) else "?",
            "content": _trunc(content, INPUT_TRUNC),
        })
    return out


def _extract_response(resp):
    """Pull content / reasoning / tool_calls / usage from LiteLlm response."""
    out = {"completion": "", "reasoning": "", "tool_calls": [], "usage": {}}
    try:
        msg = resp.choices[0].message
        out["completion"] = _trunc(getattr(msg, "content", "") or "", OUTPUT_TRUNC)
        # Verbose logging preserves full reasoning and may contain sensitive data.
        out["reasoning"] = getattr(msg, "reasoning_content", None) or ""
        tcs = getattr(msg, "tool_calls", None) or []
        out["tool_calls"] = [
            {
                "name": getattr(tc.function, "name", ""),
                "arguments": getattr(tc.function, "arguments", ""),
            }
            for tc in tcs
        ]
        usage = getattr(resp, "usage", None)
        if usage:
            out["usage"] = {
                "in": getattr(usage, "prompt_tokens", 0),
                "out": getattr(usage, "completion_tokens", 0),
                "reasoning": getattr(getattr(usage, "completion_tokens_details", None), "reasoning_tokens", 0) or 0,
                "total": getattr(usage, "total_tokens", 0),
            }
    except Exception as e:
        out["_extract_error"] = str(e)
    return out


def _write(record):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        logger.error("llm_logger write failed: %s", e)


def _build_success_record(kwargs, response_obj, start_time, end_time):
    duration = (end_time - start_time).total_seconds()
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "llm_call",
        "task_id": _current_task.get() or None,
        "model": kwargs.get("model", ""),
        "duration_s": round(duration, 3),
        "messages": _extract_messages(kwargs),
        **_extract_response(response_obj),
    }


def _build_failure_record(kwargs, response_obj, start_time, end_time):
    duration = (end_time - start_time).total_seconds()
    exc = kwargs.get("exception")
    tb = ""
    if exc is not None:
        try:
            tb = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
        except Exception:
            tb = repr(exc)
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "llm_error",
        "task_id": _current_task.get() or None,
        "model": kwargs.get("model", ""),
        "duration_s": round(duration, 3),
        "error_type": type(exc).__name__ if exc else "Unknown",
        "error_msg": str(exc) if exc else "",
        "traceback": tb,
        "messages": _extract_messages(kwargs),
    }


if LOGGER_ENABLED:
    import litellm
    from litellm.integrations.custom_logger import CustomLogger

    class _JsonlLogger(CustomLogger):
        def log_success_event(self, kwargs, response_obj, start_time, end_time):
            try:
                _write(_build_success_record(kwargs, response_obj, start_time, end_time))
            except Exception as e:
                logger.error("llm_logger log_success_event failed: %s", e)

        async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
            try:
                _write(_build_success_record(kwargs, response_obj, start_time, end_time))
            except Exception as e:
                logger.error("llm_logger async_log_success_event failed: %s", e)

        def log_failure_event(self, kwargs, response_obj, start_time, end_time):
            try:
                _write(_build_failure_record(kwargs, response_obj, start_time, end_time))
            except Exception as e:
                logger.error("llm_logger log_failure_event failed: %s", e)

        async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
            try:
                _write(_build_failure_record(kwargs, response_obj, start_time, end_time))
            except Exception as e:
                logger.error("llm_logger async_log_failure_event failed: %s", e)

    _JSONL_LOGGER_INSTANCE = _JsonlLogger()
    litellm.callbacks = list(litellm.callbacks or []) + [_JSONL_LOGGER_INSTANCE]
    logger.info("llm_logger active (sync+async via CustomLogger): writing to %s", LOG_PATH)
else:
    logger.debug("llm_logger disabled; set AURIGASQL_ENABLE_LLM_LOGGER=true to enable it")
