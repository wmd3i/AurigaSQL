from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class UsageStats:
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None
    total_tokens: int | None = None


@dataclass(slots=True)
class LLMResponse:
    content: str
    finish_reason: str | None
    raw_message: Any = field(default_factory=dict)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: UsageStats = field(default_factory=UsageStats)
    raw_response: dict[str, Any] = field(default_factory=dict)


class LLMConnector(ABC):
    provider_name: str
    model_name: str

    @abstractmethod
    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResponse:
        raise NotImplementedError
