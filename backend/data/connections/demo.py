from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Literal, cast

from pydantic import BaseModel, Field, ValidationError

from shared.config import CONFIG_DIR

DemoGroupId = Literal["bird", "bird_interact_a"]
DEMO_GROUP_IDS: tuple[DemoGroupId, ...] = ("bird", "bird_interact_a")

DEMO_CONNECTIONS_PATH = CONFIG_DIR / "demo_connections.json"
LEGACY_CONNECTIONS_PATH = CONFIG_DIR / "benchmark_connections.json"
LOCK_PATH = CONFIG_DIR / "demo_connections.lock"

DEMO_PRESETS: dict[DemoGroupId, dict[str, str]] = {
    "bird": {
        "label": "BIRD SQLite",
        "engine": "sqlite",
        "description": "Bundled BIRD SQLite demo databases",
    },
    "bird_interact_a": {
        "label": "BIRD-Interact Demo (SQLite Edition)",
        "engine": "sqlite",
        "description": "Curated BIRD-Interact databases converted to embedded SQLite",
    },
}


class DemoConnectionFile(BaseModel):
    version: int = 1
    connected: list[str] = Field(default_factory=list)


def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def _locked_file() -> Iterator[None]:
    ensure_config_dir()
    with open(LOCK_PATH, "a+", encoding="utf-8") as lock_file:
        try:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass


def _atomic_write_text(path: Path, text: str) -> None:
    ensure_config_dir()
    fd, tmp_path = tempfile.mkstemp(prefix=f"{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(text)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


def load_demo_connection_file() -> DemoConnectionFile:
    ensure_config_dir()
    path = DEMO_CONNECTIONS_PATH if DEMO_CONNECTIONS_PATH.exists() else LEGACY_CONNECTIONS_PATH
    if not path.exists():
        return DemoConnectionFile()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return DemoConnectionFile.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError):
        return DemoConnectionFile()


def list_connected_demo_groups() -> set[DemoGroupId]:
    connected = [
        cast(DemoGroupId, source_group)
        for source_group in load_demo_connection_file().connected
        if source_group in DEMO_PRESETS
    ]
    return {connected[-1]} if connected else set()


def connect_demo_group(source_group: DemoGroupId) -> DemoConnectionFile:
    with _locked_file():
        data = load_demo_connection_file()
        next_connected = [
            item
            for item in data.connected
            if item not in DEMO_GROUP_IDS or item == source_group
        ]
        if source_group not in next_connected:
            next_connected.append(source_group)
        if next_connected != data.connected:
            data.connected = next_connected
            _atomic_write_text(
                DEMO_CONNECTIONS_PATH,
                json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n",
            )
        return data


def disconnect_demo_group(source_group: DemoGroupId) -> DemoConnectionFile:
    with _locked_file():
        data = load_demo_connection_file()
        next_connected = [item for item in data.connected if item != source_group]
        if len(next_connected) != len(data.connected):
            data.connected = next_connected
            _atomic_write_text(
                DEMO_CONNECTIONS_PATH,
                json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n",
            )
        return data
