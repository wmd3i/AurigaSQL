"""Selectable LLM model registry.

Resolves frontend-facing model ids to LiteLLM runtime specs.
Primary source is the local JSON profile store.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Literal, Optional

from shared.llm_profile_store import default_model_id_from_store, list_user_profiles

ProviderName = Literal["openai", "gemini", "zai", "anthropic", "minimax", "xai", "ollama", "other"]

MODEL_DISPLAY_NAMES = {
    "openai/gpt-5.5": "GPT-5.5",
    "openai/gpt-5.5-pro": "GPT-5.5 Pro",
    "openai/gpt-5.4": "GPT-5.4",
    "openai/gpt-5.4-pro": "GPT-5.4 Pro",
    "openai/gpt-5.4-mini": "GPT-5.4 Mini",
    "openai/gpt-5.4-nano": "GPT-5.4 Nano",
    "openai/gpt-5.3-chat-latest": "GPT-5.3 Chat",
    "openai/gpt-5.2": "GPT-5.2",
    "openai/gpt-5.2-pro": "GPT-5.2 Pro",
    "gemini/gemini-3.5-flash": "Gemini 3.5 Flash",
    "gemini/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "gemini/gemini-3-pro-preview": "Gemini 3 Pro",
    "gemini/gemini-3-flash-preview": "Gemini 3 Flash",
    "gemini/gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
    "gemini/gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini/gemini-2.5-flash": "Gemini 2.5 Flash",
    "gemini/gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
    "gemini/gemini-2.5-computer-use-preview-10-2025": "Gemini 2.5 Computer Use",
    "openai/glm-5.2": "GLM-5.2",
    "openai/glm-5.1": "GLM-5.1",
    "openai/glm-5": "GLM-5",
    "openai/glm-4.7": "GLM-4.7",
    "openai/glm-4.6": "GLM-4.6",
    "openai/glm-4.5-air": "GLM-4.5 Air",
    "openai/glm-4.5": "GLM-4.5",
    "openai/glm-4.6v": "GLM-4.6V",
    "openai/glm-4.5v": "GLM-4.5V",
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-opus-4-5": "Claude Opus 4.5",
    "minimax/MiniMax-M3": "MiniMax M3",
    "minimax/MiniMax-M2.5": "MiniMax M2.5",
    "minimax/MiniMax-M2.5-lightning": "MiniMax M2.5 Lightning",
    "minimax/MiniMax-M2.1": "MiniMax M2.1",
    "minimax/MiniMax-M2.1-lightning": "MiniMax M2.1 Lightning",
    "minimax/MiniMax-M2": "MiniMax M2",
    "xai/grok-4.5": "Grok 4.5",
    "xai/grok-4.3": "Grok 4.3",
    "xai/grok-4.20-0309-reasoning": "Grok 4.20 Reasoning",
    "xai/grok-4.20-beta-0309-non-reasoning": "Grok 4.20 Non-Reasoning",
    "xai/grok-4-1-fast-reasoning": "Grok 4.1 Fast Reasoning",
    "xai/grok-4-1-fast-non-reasoning": "Grok 4.1 Fast Non-Reasoning",
    "xai/grok-4": "Grok 4",
    "xai/grok-code-fast-1": "Grok Code Fast 1",
    "xai/grok-3-mini": "Grok 3 Mini",
    "ollama_chat/qwen3:1.7b": "Local Model · Qwen3 1.7B",
    "openai/Qwen3-1.7B-Q4_K_M": "Local Model · Qwen3 1.7B",
}


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    provider: ProviderName
    litellm_model: str
    max_tokens: int = 64000
    api_key: str = ""
    api_base: str = ""
    enabled: bool = True
    source: str = "user"
    available: bool = True
    read_only: bool = False


def display_label_for_model(model_name: str, fallback: str) -> str:
    return MODEL_DISPLAY_NAMES.get(model_name, fallback)

def _build_user_specs() -> List[ModelSpec]:
    specs: List[ModelSpec] = []
    for profile in list_user_profiles():
        api_key = profile.api_key.strip()
        api_base = profile.api_base.strip()
        available = bool(api_base) if profile.provider in {"ollama", "other"} else bool(api_key)
        specs.append(
            ModelSpec(
                id=profile.id,
                label=display_label_for_model(profile.model, profile.label),
                provider=profile.provider,
                litellm_model=profile.model,
                api_key=api_key,
                api_base=api_base,
                enabled=profile.enabled,
                source=profile.source,
                available=available,
            )
        )
    return specs
def all_specs() -> List[ModelSpec]:
    return _build_user_specs()


def _active_specs() -> List[ModelSpec]:
    return [spec for spec in all_specs() if spec.enabled and spec.available]


def default_model_id() -> str:
    stored = default_model_id_from_store()
    specs = all_specs()
    by_id = {spec.id: spec for spec in specs}
    if stored:
        spec = by_id.get(stored)
        if spec and spec.enabled and spec.available:
            return spec.id
    active = _active_specs()
    if active:
        return active[0].id
    return specs[0].id if specs else ""


def get_spec(model_id: Optional[str]) -> ModelSpec:
    specs = all_specs()
    by_id = {spec.id: spec for spec in specs}
    if model_id and model_id in by_id:
        return by_id[model_id]
    default_id = default_model_id()
    if default_id and default_id in by_id:
        return by_id[default_id]
    if specs:
        return specs[0]
    raise ValueError("No configured models. Open LLM Configure and add a model first.")


def resolve_credentials(spec: ModelSpec) -> dict:
    out: dict = {}
    if spec.api_base:
        out["api_base"] = spec.api_base
    if spec.api_key:
        out["api_key"] = spec.api_key
    elif spec.provider == "other" and spec.api_base and spec.litellm_model.startswith("openai/"):
        out["api_key"] = "not-needed"
    return out


def catalog_payload() -> dict:
    return {
        "models": [
            {
                "id": spec.id,
                "label": spec.label,
                "model": spec.litellm_model,
                "provider": spec.provider,
                "available": bool(spec.enabled and spec.available),
            }
            for spec in all_specs()
        ],
        "default": default_model_id(),
    }
