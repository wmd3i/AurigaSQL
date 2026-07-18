"""Small async event bus for frontend SSE streams."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Dict, List, NamedTuple


class BusEvent(NamedTuple):
    index: int
    payload: dict[str, Any]


class EventBus:
    def __init__(self) -> None:
        self._subs: Dict[str, List[asyncio.Queue]] = defaultdict(list)

    def publish(self, task_id: str, event: dict[str, Any], index: int) -> None:
        item = BusEvent(index=index, payload=event)
        for q in list(self._subs.get(task_id, [])):
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                pass

    async def subscribe(self, task_id: str) -> asyncio.Queue[BusEvent]:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs[task_id].append(q)
        return q

    def unsubscribe(self, task_id: str, q: asyncio.Queue[BusEvent]) -> None:
        subs = self._subs.get(task_id, [])
        if q in subs:
            subs.remove(q)
        if not subs and task_id in self._subs:
            del self._subs[task_id]
