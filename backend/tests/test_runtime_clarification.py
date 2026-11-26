"""Run with PYTHONPATH=backend:src python -m unittest discover -s backend/tests."""
import asyncio
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from data.models import DataSource
from data.engines.models import AgentRunConfig, DataSourceSession
from dbagent.agents import dbtools
from dbagent.connectors.base import LLMResponse
from runtime.runtime import DbAgentRuntime


class FakeConnector:
    model_name = "test"

    def __init__(self, _):
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.calls == 1 and "User question:\nhi" in messages[1]["content"]:
            call = {"id": "ask-1", "type": "function", "function": {"name": "ask", "arguments": '{"question":"Which drivers?"}'}}
            return LLMResponse("", "tool_calls", {"role": "assistant", "tool_calls": [call]}, [call])
        sql = "```sql\nSELECT COUNT(*) AS n FROM drivers\n```"
        return LLMResponse(sql, "stop", {"role": "assistant", "content": sql})


class RuntimeClarificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.runtime = DbAgentRuntime()
        self.runtime._ipc_dir_for_task = lambda task: self.mkdir(task + "-ipc")
        self.runtime._log_dir_for_task = lambda task: self.mkdir(task + "-log")

    def mkdir(self, name):
        path = self.root / name
        path.mkdir(exist_ok=True)
        return path

    async def add_session(self, name, count, query):
        path = self.root / (name + ".sqlite")
        with sqlite3.connect(path) as conn:
            conn.execute("CREATE TABLE drivers (id INTEGER)")
            conn.executemany("INSERT INTO drivers VALUES (?)", [(i,) for i in range(count)])
        source = DataSource(name, "test", "sqlite", name, True, db_path=path)
        session = DataSourceSession(name, source, AgentRunConfig(dbtools.DBType.SQLITE, str(path), ""), self.root)
        await self.runtime.init_session(task_id=name, data_session=session, user_query=query, model=None)

    async def test_waiting_a_does_not_block_b_then_a_resumes(self):
        await self.add_session("a", 2, "hi")
        await self.add_session("b", 5, "how many f1 players")
        with patch("runtime.runtime.RegistryLiteLLMConnector", FakeConnector):
            a = asyncio.create_task(self.runtime.run_turn(task_id="a", message="hi"))
            try:
                async def wait_for_question():
                    while not self.runtime.public_state("a")["pending_question"]:
                        await asyncio.sleep(0.01)
                await asyncio.wait_for(wait_for_question(), 3)
                snapshot = self.runtime.session_response("a")["state"]
                self.assertEqual(snapshot["execution_status"], "waiting_user")
                self.assertEqual(snapshot["pending_question"], "Which drivers?")
                with self.assertRaises(ValueError):
                    await self.runtime.run_turn(task_id="a", message="duplicate")
                b = await asyncio.wait_for(self.runtime.run_turn(task_id="b", message="how many f1 players"), 3)
                self.assertTrue(b["state"]["task_done"])
                self.assertIn("5", b["state"]["_freechat_result"])
                self.assertFalse(a.done())
                self.assertTrue(await self.runtime.answer_user("a", "All drivers"))
                result = await asyncio.wait_for(a, 3)
                self.assertIn("2", result["state"]["_freechat_result"])
                self.assertIsNone(result["state"]["pending_question"])
                self.assertEqual(result["state"]["execution_status"], "done")
                self.assertTrue(any(e["type"] == "clarification_answer" for e in result["state"]["agent_events"]))
            finally:
                self.runtime.request_cancel("a")
                await asyncio.wait_for(a, 3)

    async def test_expired_ipc_request_does_not_leave_bridge_waiting(self):
        await self.add_session("a", 1, "hi")
        state = self.runtime._sessions["a"]
        request = self.root / "req_expired.json"
        request.write_text("{}")
        answer = asyncio.create_task(self.runtime._request_user_answer(state, "Which drivers?", request))
        await asyncio.sleep(0)
        request.unlink()
        self.assertEqual(await asyncio.wait_for(answer, 1), "The clarification request expired.")
        self.assertIsNone(state.pending_question)
        self.assertIsNone(state.pending_answer)


class ConnectionIsolationTests(unittest.TestCase):
    def test_concurrent_credentials_and_environment_fallback(self):
        barrier = threading.Barrier(2)
        def read(dsn):
            with dbtools.database_connection_scope(dbtools.DBType.POSTGRES, dsn):
                barrier.wait(timeout=3)
                return dbtools.connect_postgres()
        with patch.dict(os.environ, {"POSTGRES_DSN": "cli-default"}), patch.object(dbtools, "psycopg") as driver:
            driver.connect.side_effect = lambda dsn: dsn
            with ThreadPoolExecutor(2) as pool:
                a = pool.submit(read, "session-a")
                b = pool.submit(read, "session-b")
                self.assertEqual(a.result(), "session-a")
                self.assertEqual(b.result(), "session-b")
            self.assertEqual(os.environ["POSTGRES_DSN"], "cli-default")
            self.assertEqual(dbtools.connect_postgres(), "cli-default")
            with dbtools.database_connection_scope(dbtools.DBType.SQLITE, "test.sqlite"):
                with self.assertRaises(RuntimeError):
                    dbtools.connect_postgres()

    def test_scope_resets_after_exception(self):
        with patch.dict(os.environ, {"MYSQL_DSN": "cli-default"}):
            with self.assertRaisesRegex(ValueError, "test"):
                with dbtools.database_connection_scope(dbtools.DBType.MYSQL, "session-mysql"):
                    self.assertEqual(dbtools._connection_dsn("MYSQL_DSN"), "session-mysql")
                    raise ValueError("test")
            self.assertEqual(dbtools._connection_dsn("MYSQL_DSN"), "cli-default")
