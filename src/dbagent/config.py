from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ConnectorConfig:
    provider: str
    model: str
    api_key_env: str
    base_url: str | None
    max_tokens: int = 32768
    max_retries: int = 5


@dataclass(slots=True)
class AgentConfig:
    max_steps: int | None = None
