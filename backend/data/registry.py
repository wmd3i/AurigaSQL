from __future__ import annotations

from functools import lru_cache

from . import bundled_demo
from .models import DataSource
from data.connections.demo import list_connected_demo_groups
from data.connections.user import list_connection_sources, resolve_connection_source


@lru_cache(maxsize=1)
def _cached_demo_sources() -> tuple[DataSource, ...]:
    sources: list[DataSource] = []
    sources.extend(bundled_demo.list_sources())
    return tuple(sources)


def list_data_sources(*, include_not_ready: bool = True) -> list[DataSource]:
    connected_demo_groups = list_connected_demo_groups()
    sources = [
        source
        for source in _cached_demo_sources()
        if source.source_group in connected_demo_groups
    ]
    sources.extend(list_connection_sources())
    if include_not_ready:
        return sources
    return [source for source in sources if source.ready]


def list_demo_data_sources(*, include_not_ready: bool = True) -> list[DataSource]:
    sources = list(_cached_demo_sources())
    if include_not_ready:
        return sources
    return [source for source in sources if source.ready]


def resolve_data_source(source_id: str) -> DataSource:
    if source_id.startswith("connection:"):
        return resolve_connection_source(source_id)
    for source in _cached_demo_sources():
        if source.id == source_id:
            return source
    raise KeyError(source_id)


def refresh_data_sources() -> None:
    _cached_demo_sources.cache_clear()
