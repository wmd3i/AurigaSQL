from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shared.config import DATASETS_ROOT

from .models import DataSource


DEMO_ROOT = DATASETS_ROOT / "demo"
MANIFEST_PATH = DEMO_ROOT / "manifest.json"
DEMO_GROUP_IDS = ("bird", "bird_interact_a")


def _optional_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return DEMO_ROOT / value


def _not_ready(source_group: str, reason: str) -> DataSource:
    label = "BIRD-Interact SQLite" if source_group == "bird_interact_a" else "BIRD SQLite"
    return DataSource(
        id=f"{source_group}:not_ready",
        source_group=source_group,
        engine="sqlite",
        display_name=f"{label} dataset not found",
        ready=False,
        description=f"Bundled {label} demo subset",
        reason=reason,
    )


def list_sources() -> list[DataSource]:
    try:
        payload = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        reason = f"Demo dataset manifest not found: {MANIFEST_PATH}"
        return [_not_ready(source_group, reason) for source_group in DEMO_GROUP_IDS]
    except (OSError, json.JSONDecodeError) as exc:
        reason = f"Demo dataset manifest is invalid: {exc}"
        return [_not_ready(source_group, reason) for source_group in DEMO_GROUP_IDS]

    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list):
        reason = f"Demo dataset manifest has no sources list: {MANIFEST_PATH}"
        return [_not_ready(source_group, reason) for source_group in DEMO_GROUP_IDS]

    sources: list[DataSource] = []
    present_groups: set[str] = set()
    for item in raw_sources:
        if not isinstance(item, dict):
            continue
        source_id = item.get("source_id")
        source_group = item.get("source_group")
        database = item.get("database")
        display_name = item.get("display_name")
        db_path = _optional_path(item.get("db_path"))
        if not all(isinstance(value, str) and value for value in (source_id, source_group, database, display_name)):
            continue
        if source_group not in DEMO_GROUP_IDS:
            continue
        present_groups.add(source_group)
        ready = bool(db_path and db_path.is_file())
        sources.append(
            DataSource(
                id=source_id,
                source_group=source_group,
                engine="sqlite",
                display_name=display_name,
                ready=ready,
                database=database,
                db_path=db_path,
                schema_path=_optional_path(item.get("schema_path")),
                column_meanings_path=_optional_path(item.get("column_meanings_path")),
                knowledge_path=_optional_path(item.get("knowledge_path")),
                description=str(item.get("description") or "Bundled SQLite demo database"),
                reason="" if ready else f"Bundled SQLite database not found: {db_path}",
            )
        )

    for source_group in DEMO_GROUP_IDS:
        if source_group not in present_groups:
            sources.append(_not_ready(source_group, f"No {source_group} sources found in {MANIFEST_PATH}"))
    return sources
