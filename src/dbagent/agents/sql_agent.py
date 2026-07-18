from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

from dbagent.agents.dbtools import DBType, build_tool_handler_map, build_llm_tools, list_duckdb_tables, list_sqlite_tables
from dbagent.agents.interaction_tools import (
    build_interaction_handlers,
    build_interaction_tool_schemas,
)
from dbagent.agents.trajectory import TrajectoryList
from dbagent.config import AgentConfig
from dbagent.connectors.base import LLMConnector, UsageStats


@dataclass(slots=True)
class AgentRunOutput:
    final_text: str
    final_sql: str
    trajectory: list[dict[str, Any]]
    llm_responses_path: str | None
    trajectory_path: str | None
    usage: UsageStats
    llm_call_count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SQLAgent:
    def __init__(self, connector: LLMConnector, config: AgentConfig) -> None:
        self.connector = connector
        self.config = config

    def run(
        self,
        *,
        prompt: str,
        db_type: DBType,
        db_path: str | None,
        log_dir: Path | None = None,
        task_id: str | None = None,
        kb_entries: list[dict[str, Any]] | None = None,
        column_meanings: dict[str, str] | None = None,
        resume_messages: list[dict[str, Any]] | None = None,
        ipc_dir: str | None = None,
    ) -> AgentRunOutput:
        tool_handler_map = build_tool_handler_map()
        # Product interaction tools are optional: knowledge appears only when a
        # datasource ships metadata, while ask is available whenever the frontend
        # IPC bridge is active.
        extra_tools: list[dict[str, Any]] | None = None
        has_kb = bool(kb_entries)
        has_column_meanings = bool(column_meanings)
        has_ask = bool(ipc_dir)
        if has_kb or has_column_meanings or has_ask:
            extra_tools = build_interaction_tool_schemas(
                include_ask=has_ask,
                include_column_meanings=has_column_meanings,
                include_knowledge=has_kb,
            )
            tool_handler_map.update(
                build_interaction_handlers(kb_entries, column_meanings, ipc_dir)
            )
        tools = build_llm_tools(db_type=db_type, extra_tools=extra_tools)
        system_prompt = self._build_system_prompt(
            db_type=db_type,
            db_path=db_path,
        )
        trajectory_path = str(log_dir / "trajectory.json") if log_dir else None
        llm_responses_path = str(log_dir / "llm_responses.jsonl") if log_dir else None
        trajectory = TrajectoryList(trajectory_path)
        if resume_messages:
            # Continue the same product conversation: replay the prior messages,
            # then append the newest user turn.
            trajectory.extend(resume_messages)
            trajectory.append({"role": "user", "content": prompt})
        else:
            trajectory.extend([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ])
        total_usage = UsageStats()
        turn = 0
        logger.info(
            "agent_started task_id=%s db_type=%s prompt_chars=%d tool_count=%d",
            task_id, db_type.value, len(prompt), len(tools),
        )

        while self.config.max_steps is None or turn < self.config.max_steps:
            turn += 1
            logger.info("llm_call_started task_id=%s turn=%d model=%s message_count=%d tool_count=%d", task_id, turn, self.connector.model_name, len(trajectory), len(tools))
            llm_t0 = time.monotonic()
            response = self.connector.complete(
                messages=trajectory,
                tools=tools,
            )
            llm_duration = time.monotonic() - llm_t0
            self._add_usage(total_usage, response.usage)
            logger.info("llm_call_finished task_id=%s turn=%d duration_secs=%.2f finish_reason=%s prompt_tokens=%s completion_tokens=%s total_tokens=%s", task_id, turn, llm_duration, response.finish_reason, response.usage.prompt_tokens, response.usage.completion_tokens, response.usage.total_tokens)
            if llm_responses_path:
                with open(llm_responses_path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(response.raw_response, ensure_ascii=False) + "\n")
                logger.info("llm_response_saved task_id=%s turn=%d file=%s", task_id, turn, Path(llm_responses_path).name)

            trajectory.append(response.raw_message)
            tool_calls = response.tool_calls

            if response.finish_reason != "tool_calls" and not tool_calls:
                final_text = response.content or ""
                if trajectory_path:
                    Path(trajectory_path).write_text(
                        json.dumps(trajectory, indent=2, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    logger.info("trajectory_saved task_id=%s file=%s", task_id, Path(trajectory_path).name)
                final_sql = self._extract_sql(final_text)
                logger.info("agent_finished task_id=%s turns=%d final_text_chars=%d final_sql_chars=%d", task_id, turn, len(final_text), len(final_sql))
                return AgentRunOutput(
                    final_text=final_text,
                    final_sql=final_sql,
                    trajectory=trajectory,
                    llm_responses_path=llm_responses_path,
                    trajectory_path=trajectory_path,
                    usage=total_usage,
                    llm_call_count=turn,
                )

            handled_any = False
            for block in tool_calls:
                if block.get("type") != "function":
                    continue
                handled_any = True
                function_info = block.get("function", {})
                tool_name = function_info.get("name")
                raw_arguments = function_info.get("arguments") or "{}"
                handler = tool_handler_map.get(tool_name)
                logger.info("tool_call_started task_id=%s turn=%d tool=%s", task_id, turn, tool_name)
                tool_t0 = time.monotonic()
                try:
                    args = json.loads(raw_arguments)
                    tool_response = handler(**args) if handler else f"Error: unknown tool {tool_name}"
                except Exception as exc:
                    tool_response = f"Error: invalid tool arguments for {tool_name}: {exc}"
                    logger.warning("tool_call_exception task_id=%s turn=%d tool=%s error=%s", task_id, turn, tool_name, exc)
                tool_status = "error" if str(tool_response).startswith("Error:") else "success"
                logger.info("tool_call_finished task_id=%s turn=%d tool=%s status=%s duration_secs=%.2f output_chars=%d", task_id, turn, tool_name, tool_status, time.monotonic() - tool_t0, len(str(tool_response)))
                trajectory.append(
                    {
                        "tool_call_id": block.get("id"),
                        "role": "tool",
                        "name": tool_name,
                        "content": tool_response,
                    }
                )

            if not handled_any:
                logger.warning("no_executable_tool_calls task_id=%s turn=%d finish_reason=tool_calls", task_id, turn)

        if trajectory_path:
            Path(trajectory_path).write_text(
                json.dumps(trajectory, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            logger.info("trajectory_saved task_id=%s file=%s", task_id, Path(trajectory_path).name)
        logger.warning(
            "agent_stopped_max_steps task_id=%s turns=%d max_steps=%d",
            task_id,
            turn,
            self.config.max_steps,
        )
        return AgentRunOutput(
            final_text="",
            final_sql="",
            trajectory=trajectory,
            llm_responses_path=llm_responses_path,
            trajectory_path=trajectory_path,
            usage=total_usage,
            llm_call_count=turn,
        )

    def _build_system_prompt(
        self,
        db_type: DBType,
        db_path: str | None,
    ) -> str:
        base = (
            "You are a SQL agent. "
            "You have access to SQL tools for schema inspection, sampling, read-only queries, EXPLAIN plans, and SQL validation. "
        )
        if self.config.max_steps is None:
            base += "Use as many iterations as needed before returning the final answer. "
        else:
            base += f"The maximum number of steps you can take is {self.config.max_steps}. "
        if db_type == DBType.SQLITE:
            base += (
                "Ground your filters in the actual data: before filtering on a string or date value, check how it "
                "is really stored in the column. Do not assume the question's wording matches the stored form. "
                "Before giving the final answer, verify your SQL by executing it with run_sqlite_readonly and "
                "inspecting the returned rows: confirm the result actually answers the question. "
                "An empty or surprising result usually means a wrong assumption in your choice of tables, joins, "
                "or filter literals -- re-check those first. "
                "You may use validate_sqlite_query as a final syntax check, but executing the query is the real test. "
                "Answer exactly what is asked -- no more, no less: do not add information, transformations, or "
                "conditions the question did not request, and do not omit anything it did. "
                "Unless asked to transform them, return values as they appear in the database. "
                "When in doubt, stay closer to the literal question. "
                "As a final audit before answering, re-read the question and check your SELECT list: every column "
                "you return is one the question asks for, and nothing it asks for is missing. "
                "The final answer must contain only one SQL query in a single fenced code block like ```sql ... ```, with no explanation before or after it. "
            )
            if db_path:
                base += f"\n\nDatabase schema:\n{list_sqlite_tables(db_path)}"
        elif db_type == DBType.DUCKDB:
            base += (
                "Before giving the final answer for a DuckDB task, always validate the final SQL with the validate_duckdb_query tool. "
                "If validation fails, revise the SQL and validate again. "
                "The final answer must contain only one SQL query in a single fenced code block like ```sql ... ```, with no explanation before or after it. "
            )
            if db_path:
                base += f"\n\nDatabase schema:\n{list_duckdb_tables(db_path)}"
        elif db_type == DBType.POSTGRES:
            base += (
                "For a PostgreSQL task, test your query before finalizing it: run it with run_postgres_readonly to confirm the results look "
                "correct, and validate it with validate_postgres_query, which resolves every table/column reference against the live schema "
                "and catches mistakes like double-quoting a mixed-case identifier (e.g. \"SiteTie\") when the real column is stored lowercase "
                "(sitetie). Always run and validate the final SQL before answering; if either reports an error or an unexpected result, revise "
                "the SQL and check again. "
            )
        elif db_type == DBType.MYSQL:
            base += (
                "For a MySQL task, test your query before finalizing it: run it with run_mysql_readonly to confirm the results look correct, "
                "and validate it with validate_mysql_query, which resolves table/column references against the live schema using EXPLAIN. "
                "Always run and validate the final SQL before answering; if either reports an error or an unexpected result, revise the SQL "
                "and check again. "
            )
        return base

    @staticmethod
    def _sum_usage(usages: list[UsageStats]) -> UsageStats:
        total = UsageStats()
        for field in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"):
            values = [getattr(usage, field) for usage in usages if getattr(usage, field) is not None]
            if values:
                setattr(total, field, sum(values))
        return total

    @staticmethod
    def _extract_sql(text: str) -> str:
        return text.replace("```sql", "").replace("```", "").strip()

    @staticmethod
    def _add_usage(total: UsageStats, usage: UsageStats) -> None:
        for field in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"):
            value = getattr(usage, field)
            if value is None:
                continue
            current = getattr(total, field)
            setattr(total, field, value if current is None else current + value)
