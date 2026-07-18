"""Centralized configuration.

Settings are loaded in this priority (highest wins):
  1. Environment variables
  2. .env file in backend root (user-specific, gitignored)
  3. Defaults defined below

Users: copy .env.example to .env and edit.
See .env.example for all available settings.
"""

import logging
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

CODE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = CODE_ROOT.parent


def _path_from_env(name: str, fallback: Path) -> Path:
    value = os.getenv(name, "").strip()
    if value:
        return Path(value).expanduser().resolve()
    return fallback.resolve()


RESOURCE_ROOT = _path_from_env("AURIGASQL_RESOURCES_DIR", REPO_ROOT)
RUNTIME_ROOT = _path_from_env("AURIGASQL_USER_DATA_DIR", CODE_ROOT)
PROJECT_ROOT = CODE_ROOT
CONFIG_DIR = RUNTIME_ROOT / "config"
LOGS_DIR = RUNTIME_ROOT / "logs"
DATASETS_ROOT = _path_from_env("AURIGASQL_DATASETS_DIR", RESOURCE_ROOT / "datasets")

if getattr(sys, "frozen", False):
    PROJECT_ROOT = CODE_ROOT

logging.getLogger("httpx").setLevel(logging.WARNING)

load_dotenv(REPO_ROOT / ".env")
load_dotenv(CONFIG_DIR / ".env")
os.environ.setdefault("LLM_LOG_PATH", str(LOGS_DIR / "llm_calls.jsonl"))

try:
    from shared import llm_logger  # noqa: F401
except Exception as _e:  # pragma: no cover
    logging.getLogger(__name__).warning("llm_logger setup failed: %s", _e)


class Settings(BaseSettings):
    llm_provider: str = "litellm"

    user_sim_model: str = "anthropic/claude-haiku-4-5-20251001"
    system_agent_model: str = "anthropic/claude-sonnet-4-20250514"

    # Model used to route a free-text question to a database (entry-page Auto mode).
    # Falls back to user_sim_model when empty. Override with DB_ROUTER_MODEL.
    db_router_model: str = ""

    # Max completion tokens for the system agent. Default suits Claude (64k);
    # override per model — e.g. gpt-4.1-mini caps output at 32768.
    system_agent_max_tokens: int = 64000

    litellm_api_base: str = ""
    litellm_api_key: str = ""

    @property
    def demo_data_dir(self) -> Path:
        return DATASETS_ROOT / "demo"

    @property
    def demo_questions_path(self) -> Path:
        return self.demo_data_dir / "demo_questions.json"

    class Config:
        env_file = str(CONFIG_DIR / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
