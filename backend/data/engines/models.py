from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dbagent.agents.dbtools import DBType
from data.models import DataSource


@dataclass(frozen=True)
class AgentRunConfig:
    db_type: DBType
    db_path: str | None
    prompt_prefix: str
    kb_entries: list[dict[str, Any]] | None = None
    column_meanings: dict[str, str] | None = None


@dataclass
class DataSourceSession:
    task_id: str
    source: DataSource
    run_config: AgentRunConfig
    workspace_dir: Path
    cleanup_paths: list[Path] | None = None

    def public_source(self) -> dict:
        return self.source.to_public_dict()
