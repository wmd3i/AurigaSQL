"""Run with PYTHONPATH=backend:src python -m unittest discover -s backend/tests."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from api import handlers
from api.app import create_app
from runtime.events import EventBus


class FakeRuntime:
    def __init__(self):
        self.event_bus = EventBus()
        self.events = {"task-a": [{"type": "user_message", "text": "hi"}, {"type": "assistant_text", "text": "thinking"}]}

    def public_state(self, task_id):
        if task_id not in self.events:
            raise KeyError(task_id)
        return {"agent_events": self.events[task_id]}


class EventsSocketTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime()
        patcher = patch.object(handlers, "AGENT_RUNTIME", self.runtime)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Skip startup side effects (default demo connections etc.).
        startup = patch.object(handlers, "startup_defaults", lambda: _noop())
        startup.start()
        self.addCleanup(startup.stop)
        self.client = TestClient(create_app())

    def test_replays_after_cursor_then_streams_live_events(self):
        with self.client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:5173"}) as ws:
            ws.send_json({"op": "subscribe", "task_id": "task-a", "after": 0})
            self.assertEqual(ws.receive_json(), {"task_id": "task-a", "index": 1, "event": {"type": "assistant_text", "text": "thinking"}})
            ws.portal.call(lambda: self.runtime.event_bus.publish("task-a", {"type": "done"}, 2))
            self.assertEqual(ws.receive_json(), {"task_id": "task-a", "index": 2, "event": {"type": "done"}})

    def test_many_tasks_share_one_socket_and_unknown_tasks_are_reported(self):
        self.runtime.events["task-b"] = [{"type": "user_message", "text": "b"}]
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"op": "subscribe", "task_id": "gone", "after": -1})
            self.assertEqual(ws.receive_json(), {"task_id": "gone", "type": "not_found"})
            ws.send_json({"op": "subscribe", "task_id": "task-b", "after": -1})
            self.assertEqual(ws.receive_json()["task_id"], "task-b")
            ws.send_json({"op": "unsubscribe", "task_id": "task-b"})
            # Messages are handled in order, so this replay proves the unsubscribe landed.
            ws.send_json({"op": "subscribe", "task_id": "task-a", "after": 0})
            self.assertEqual(ws.receive_json()["index"], 1)
            ws.portal.call(lambda: self.runtime.event_bus.publish("task-b", {"type": "done"}, 1))
            ws.portal.call(lambda: self.runtime.event_bus.publish("task-a", {"type": "done"}, 2))
            self.assertEqual(ws.receive_json(), {"task_id": "task-a", "index": 2, "event": {"type": "done"}})

    def test_rejects_other_web_origins(self):
        with self.assertRaises(WebSocketDisconnect) as ctx:
            with self.client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        self.assertEqual(ctx.exception.code, 1008)

    def test_sse_returns_404_for_unknown_task(self):
        self.assertEqual(self.client.get("/events/gone").status_code, 404)


async def _noop():
    return None


if __name__ == "__main__":
    unittest.main()
