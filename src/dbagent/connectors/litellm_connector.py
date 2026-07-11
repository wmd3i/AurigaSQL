from __future__ import annotations

import logging
import json
import os
import time
from typing import Any

import litellm
from litellm import Router
from dotenv import load_dotenv
from tenacity import Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)

if os.getenv("LITELLM_DEBUG") == "1":
    litellm._turn_on_debug()

from dbagent.config import ConnectorConfig
from dbagent.connectors.base import LLMConnector, LLMResponse, UsageStats
from dbagent.connectors.model_configs import (
    get_model_config,
    has_model_config,
    rewrite_model_config_base_urls,
    runtime_context_from_env,
)


class LiteLLMConnector(LLMConnector):
    def __init__(self, config: ConnectorConfig) -> None:
        load_dotenv(override=True)
        self.config = config
        self.provider_name = config.provider
        self.model_name = config.model
        self.router: Router | None = None
        self.router_entry_model: str | None = None

        # If the model is a router config, use the router
        if has_model_config(config.model):
            router_cfg = rewrite_model_config_base_urls(
                get_model_config(config.model),
                runtime=runtime_context_from_env(),
            )
            self.router = Router(
                model_list=router_cfg["model_list"],
                fallbacks=router_cfg.get("fallbacks"),
            )
            self.router_entry_model = router_cfg["entry_model"]
            first_deployment = router_cfg["model_list"][0]["litellm_params"]
            self.api_key = first_deployment.get("api_key", "")
            logger.info("llm_connector_initialized mode=router model=%s entry=%s", config.model, self.router_entry_model)
            return
        else:
            # Otherwise, use the regular LiteLLM API
            api_key = os.getenv(config.api_key_env)
            if not api_key:
                raise RuntimeError(f"Missing environment variable: {config.api_key_env}")
            self.api_key = api_key
            logger.info("llm_connector_initialized mode=direct model=%s api_base=%s", self.model_name, self.config.base_url or None)

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResponse:
        max_attempts = max(1, self.config.max_retries + 1)
        logger.info("llm_invocation_started provider=%s model=%s message_count=%d tool_count=%d max_retries=%d", self.provider_name, self.model_name, len(messages), len(tools or []), self.config.max_retries)
        logger.info("llm_prompt messages=%s", self._format_log_value(messages))
        t0 = time.monotonic()
        response = self._complete_with_retries(messages, tools, max_attempts, t0)
        return self._build_llm_response(response, t0)

    def _complete_with_retries(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_attempts: int,
        invocation_started_at: float,
    ) -> Any:
        response = None
        retryer = self._build_retryer(max_attempts)
        try:
            for attempt in retryer:
                response = self._complete_attempt(attempt, messages, tools, max_attempts)
                if response is not None:
                    return response
        except Exception:
            logger.exception("llm_invocation_failed provider=%s model=%s attempts=%d duration_secs=%.2f", self.provider_name, self.model_name, max_attempts, time.monotonic() - invocation_started_at)
            raise
        raise RuntimeError("LiteLLM did not return a response")

    def _complete_attempt(self, attempt: Any, messages: list[dict[str, Any]], tools: list[dict[str, Any]], max_attempts: int) -> Any | None:
        attempt_number = attempt.retry_state.attempt_number
        attempt_t0 = time.monotonic()
        response = None
        with attempt:
            try:
                response = self._call_litellm(messages, tools)
            except Exception as exc:
                logger.warning("llm_attempt_failed provider=%s model=%s attempt=%d max_attempts=%d duration_secs=%.2f error_type=%s error=%s", self.provider_name, self.model_name, attempt_number, max_attempts, time.monotonic() - attempt_t0, type(exc).__name__, exc)
                raise
        if attempt.retry_state.outcome and not attempt.retry_state.outcome.failed:
            logger.info("llm_attempt_succeeded provider=%s model=%s attempt=%d max_attempts=%d duration_secs=%.2f", self.provider_name, self.model_name, attempt_number, max_attempts, time.monotonic() - attempt_t0)
            return response
        return None

    def _build_retryer(self, max_attempts: int) -> Retrying:
        return Retrying(
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential(multiplier=1, min=1, max=30),
            retry=retry_if_exception_type(Exception),
            before_sleep=self._log_retry_scheduled,
            reraise=True,
        )

    def _call_litellm(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
        if self.router is not None:
            assert self.router_entry_model is not None
            return self.router.completion(
                model=self.router_entry_model,
                messages=messages,
                tools=tools or None,
                max_tokens=self.config.max_tokens,
                num_retries=0,
            )

        return litellm.completion(
            model=self.model_name,
            messages=messages,
            tools=tools or None,
            max_tokens=self.config.max_tokens,
            api_key=self.api_key,
            api_base=self.config.base_url or None,
            num_retries=0,
        )

    def _build_llm_response(self, response: Any, invocation_started_at: float) -> LLMResponse:
        message = response.choices[0].message
        usage = response.usage
        usage_details = getattr(usage, "completion_tokens_details", None) if usage else None
        raw_message_dict = message.model_dump(exclude_none=True)
        tool_calls = raw_message_dict.get("tool_calls") or []
        logger.info("llm_invocation_finished provider=%s model=%s duration_secs=%.2f finish_reason=%s content_chars=%d tool_call_count=%d prompt_tokens=%s completion_tokens=%s total_tokens=%s", self.provider_name, self.model_name, time.monotonic() - invocation_started_at, response.choices[0].finish_reason, len(message.content or ""), len(tool_calls), getattr(usage, "prompt_tokens", None) if usage else None, getattr(usage, "completion_tokens", None) if usage else None, getattr(usage, "total_tokens", None) if usage else None)
        raw_response = response.model_dump()
        logger.info("llm_response provider=%s model=%s raw_response=%s", self.provider_name, self.model_name, self._format_log_value(raw_response))
        llm_response = LLMResponse(
            content=message.content or "",
            finish_reason=response.choices[0].finish_reason,
            raw_message=raw_message_dict,
            tool_calls=tool_calls,
            usage=UsageStats(
                prompt_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
                completion_tokens=getattr(usage, "completion_tokens", None) if usage else None,
                reasoning_tokens=getattr(usage_details, "reasoning_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None) if usage else None,
            ),
            raw_response=raw_response,
        )
        return llm_response

    @staticmethod
    def _format_log_value(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, default=str).replace("\n", "\\n").replace("\r", "\\r")

    def _log_retry_scheduled(self, retry_state: Any) -> None:
        sleep_secs = retry_state.next_action.sleep if retry_state.next_action else 0
        logger.info("llm_retry_scheduled provider=%s model=%s next_attempt=%d sleep_secs=%.2f", self.provider_name, self.model_name, retry_state.attempt_number + 1, sleep_secs)
