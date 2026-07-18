from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

DataEngine = Literal["postgres", "mysql", "sqlite", "duckdb"]


@dataclass(frozen=True)
class DataSource:
    id: str
    source_group: str
    engine: DataEngine
    display_name: str
    ready: bool
    source_type: Literal["demo", "user_connection"] = "demo"
    database: str | None = None
    db_path: Path | str | None = None
    schema_path: Path | None = None
    column_meanings_path: Path | None = None
    knowledge_path: Path | None = None
    dsn: str | None = None
    connection_id: str | None = None
    description: str = ""
    reason: str = ""

    def to_public_dict(self) -> dict:
        payload = asdict(self)
        payload.pop("dsn", None)
        if isinstance(self.db_path, Path):
            payload["db_path"] = str(self.db_path)
        elif self.source_type == "user_connection" and self.engine in {"postgres", "mysql"}:
            payload["db_path"] = None
        if self.schema_path is not None:
            payload["schema_path"] = str(self.schema_path)
        if self.column_meanings_path is not None:
            payload["column_meanings_path"] = str(self.column_meanings_path)
        if self.knowledge_path is not None:
            payload["knowledge_path"] = str(self.knowledge_path)
        return payload
