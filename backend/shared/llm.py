"""Unified LLM call interface.

Release: uses LiteLlm (supports any provider).
Local override: place _local_provider.py in this directory (gitignored)
to use a custom backend.
"""

import logging

from shared.config import settings
from shared import llm_logger  # noqa: F401  registers LiteLlm callbacks

logger = logging.getLogger(__name__)

MAX_RETRIES = 5

try:
    from shared._local_provider import call_llm
except ImportError:
    def call_llm(messages: list, model_name: str = None, temperature: float = 0, max_tokens: int = 1024) -> str:
        """Call LLM via LiteLlm. Retries on rate limit / transient errors."""
        import litellm
        model_name = model_name or settings.system_agent_model
        kwargs = dict(
            model=model_name,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            num_retries=MAX_RETRIES,
            timeout=1500,
        )
        if settings.litellm_api_base:
            kwargs["api_base"] = settings.litellm_api_base
        if settings.litellm_api_key:
            kwargs["api_key"] = settings.litellm_api_key

        resp = litellm.completion(**kwargs)
        return resp.choices[0].message.content.strip()
