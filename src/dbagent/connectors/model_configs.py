from __future__ import annotations

import os
import platform
from copy import deepcopy
from typing import Any
from urllib.parse import urlparse, urlunparse

ModelConfig = dict[str, Any]


# Router-facing model configs. Keep env var names here and resolve them only
# when a config is requested, so importing this module does not require all
# credentials to be present.
MODEL_CONFIGS: dict[str, ModelConfig] = {
    "glm52_zai_primary": {
        "entry_model": "glm52-zai",
        "model_list": [
            {
                "model_name": "glm52-zai",
                "litellm_params": {
                    "model": "openai/glm-5.2",
                    "api_key_env": "ZAI_API_KEY",
                    "api_base": "https://api.z.ai/api/coding/paas/v4",
                },
            },
            {
                "model_name": "glm52-ollama",
                "litellm_params": {
                    "model": "ollama_chat/glm-5.2:cloud",
                    "api_key_env": "OLLAMA_API_KEY",
                    "api_base": "http://localhost:11434",
                },
            },
        ],
        "fallbacks": [{"glm52-zai": ["glm52-ollama"]}],
    },
    "glm52_ollama_primary": {
        "entry_model": "glm52-ollama",
        "model_list": [
            {
                "model_name": "glm52-ollama",
                "litellm_params": {
                    "model": "ollama_chat/glm-5.2:cloud",
                    "api_key_env": "OLLAMA_API_KEY",
                    "api_base": "http://localhost:11434",
                },
            },
            {
                "model_name": "glm52-zai",
                "litellm_params": {
                    "model": "openai/glm-5.2",
                    "api_key_env": "ZAI_API_KEY",
                    "api_base": "https://api.z.ai/api/coding/paas/v4",
                },
            },
        ],
        "fallbacks": [{"glm52-ollama": ["glm52-zai"]}],
    },
}


def list_model_configs() -> list[str]:
    return sorted(MODEL_CONFIGS)


def has_model_config(name: str) -> bool:
    return name in MODEL_CONFIGS


def get_model_config_env_vars(name: str) -> list[str]:
    try:
        config = MODEL_CONFIGS[name]
    except KeyError as exc:
        available = ", ".join(list_model_configs()) or "<none>"
        raise KeyError(f"Unknown model config: {name}. Available configs: {available}") from exc

    env_vars: set[str] = set()
    for deployment in config.get("model_list", []):
        params = deployment.get("litellm_params", {})
        for field_name in ("api_key_env", "api_base_env"):
            env_name = params.get(field_name)
            if env_name:
                env_vars.add(env_name)
    return sorted(env_vars)


def get_model_config(name: str) -> ModelConfig:
    try:
        config = deepcopy(MODEL_CONFIGS[name])
    except KeyError as exc:
        available = ", ".join(list_model_configs()) or "<none>"
        raise KeyError(f"Unknown model config: {name}. Available configs: {available}") from exc

    entry_model = config.get("entry_model")
    model_names = {
        deployment.get("model_name")
        for deployment in config.get("model_list", [])
        if deployment.get("model_name")
    }
    if not entry_model or entry_model not in model_names:
        raise ValueError(f"Model config '{name}' has invalid entry_model={entry_model!r}")

    for deployment in config.get("model_list", []):
        params = deployment.setdefault("litellm_params", {})
        _resolve_secret(params, "api_key_env", "api_key")
        _resolve_secret(params, "api_base_env", "api_base")

    return config


def rewrite_model_config_base_urls(
    config: ModelConfig,
    *,
    runtime: str,
) -> ModelConfig:
    """Rewrite router deployment ``api_base`` values for host/container runtime.

    Router configs are shared between the host-side user simulator and the
    in-container agent worker. Host-local bases should stay as ``localhost`` on
    the host, but must be rewritten to ``host.docker.internal`` for the
    container to reach host services such as Ollama.
    """
    rewritten = deepcopy(config)
    for deployment in rewritten.get("model_list", []):
        params = deployment.get("litellm_params", {})
        params["api_base"] = rewrite_api_base_for_runtime(
            params.get("api_base"),
            runtime=runtime,
        )
    return rewritten


def runtime_context_from_env() -> str:
    value = (os.getenv("DBAGENT_RUNTIME_CONTEXT") or "").strip().lower()
    return "container" if value == "container" else "host"


def _resolve_secret(params: dict[str, Any], env_field: str, target_field: str) -> None:
    env_name = params.pop(env_field, None)
    if not env_name:
        return
    env_value = os.getenv(env_name)
    if not env_value:
        raise RuntimeError(f"Missing environment variable: {env_name}")
    params[target_field] = env_value


def rewrite_api_base_for_runtime(
    api_base: str | None,
    *,
    runtime: str,
) -> str | None:
    if not api_base:
        return api_base
    parsed = urlparse(api_base)
    host = parsed.hostname
    if not host:
        return api_base

    if runtime == "container":
        if platform.system() not in {"Darwin", "Linux"}:
            return api_base
        if host not in {"localhost", "127.0.0.1"}:
            return api_base
        netloc = "host.docker.internal"
        if parsed.port is not None:
            netloc = f"{netloc}:{parsed.port}"
        return urlunparse(parsed._replace(netloc=netloc))

    if host != "host.docker.internal":
        return api_base
    netloc = "localhost"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))
