from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

from dbagent.agents.dbtools import DBType, build_tool_handler_map, build_llm_tools, list_duckdb_tables, list_sqlite_tables
from dbagent.benchmarks.bird_interact_a.bird_interact_tools import (
    TerminalVerdict,
    build_bird_interact_handlers,
    build_bird_interact_tool_schemas,
    build_submit_terminal_handler,
)
from dbagent.agents.trajectory import TrajectoryList
from dbagent.config import AgentConfig
from dbagent.connectors.base import LLMConnector, UsageStats


@dataclass(slots=True)
class AgentRunOutput:
    final_text: str
    final_sql: str
    final_artifact_path: str | None
    trajectory: list[dict[str, Any]]
    llm_responses_path: str | None
    trajectory_path: str | None
    usage: UsageStats
    llm_call_count: int
    # Budget left when the agent stopped; None when the budget economy is off.
    # Carried across phases so a resumed run (BIRD-Interact-a Phase 2) continues
    # from the same shared pool
    remaining_budget: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SQLAgent:
    def __init__(self, connector: LLMConnector, config: AgentConfig, workdir: Path) -> None:
        self.connector = connector
        self.config = config
        self.workdir = workdir

    def run(
        self,
        *,
        prompt: str,
        db_type: DBType,
        db_path: str | None,
        user_question: str = "",
        log_dir: Path | None = None,
        case_id: str | None = None,
        task_workspace: Path | None = None,
        kb_entries: list[dict[str, Any]] | None = None,
        column_meanings: dict[str, str] | None = None,
        budget: float | None = None,
        tool_costs: dict[str, float] | None = None,
        resume_messages: list[dict[str, Any]] | None = None,
        ipc_dir: str | None = None,
        terminal_tool: str | None = None,
    ) -> AgentRunOutput:
        # Set up the tools and system prompt
        active_workdir = task_workspace or self.workdir
        workspace_mode = task_workspace is not None and db_path is None
        tool_handler_map = build_tool_handler_map(active_workdir)
        # BIRD-Interact knowledge/column-meaning tools are added only when the
        # benchmark injects their (public) data through the payload.
        extra_tools: list[dict[str, Any]] | None = None
        # Handler for the terminal tool (submit): grades the answer and returns a
        # verdict; the loop only does terminate/retry control flow with it.
        terminal_handler = None
        if kb_entries is not None or column_meanings is not None:
            extra_tools = build_bird_interact_tool_schemas()
            tool_handler_map.update(
                build_bird_interact_handlers(kb_entries, column_meanings, ipc_dir)
            )
            if terminal_tool:
                terminal_handler = build_submit_terminal_handler(ipc_dir)
        tools = build_llm_tools(db_type=db_type, yolo=self.config.yolo, extra_tools=extra_tools)
        # When a benchmark exposes an explicit terminal tool (e.g. BIRD-Interact-a's
        # submit(sql)), keep its schema handy so it stays available even after the
        # action budget is depleted -- the agent must always be able to submit.
        terminal_schema = [
            tool for tool in tools
            if terminal_tool and tool.get("function", {}).get("name") == terminal_tool
        ]
        system_prompt = self._build_system_prompt(
            db_type=db_type,
            db_path=db_path,
            workspace_mode=workspace_mode,
            workdir=active_workdir,
        )
        trajectory_path = str(log_dir / "trajectory.json") if log_dir else None
        llm_responses_path = str(log_dir / "llm_responses.jsonl") if log_dir else None
        trajectory = TrajectoryList(trajectory_path)
        if resume_messages:
            # Continuation (e.g. BIRD-Interact-a Phase 2): replay the prior
            # conversation, then append the new user turn (the revealed follow-up).
            # resume_messages already starts with the system prompt, so it is not
            # re-added; budget passed in is the remaining shared pool, not a reset.
            trajectory.extend(resume_messages)
            trajectory.append({"role": "user", "content": prompt})
        else:
            trajectory.extend([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ])
        total_usage = UsageStats()
        turn = 0
        # Optional action-budget economy (BIRD-Interact "user patience"): each tool
        # call deducts its cost; when the budget is exhausted the agent is forced to
        # submit (tools withdrawn) on the next turn. Disabled when budget is None.
        budget_enabled = budget is not None
        total_budget = float(budget) if budget_enabled else 0.0
        remaining_budget = total_budget
        costs = tool_costs or {}
        force_submit = budget_enabled and remaining_budget <= 0
        logger.info(
            "agent_started case_id=%s db_type=%s db_path=%s prompt_chars=%d tool_count=%d budget=%s",
            case_id, db_type.value, db_path, len(prompt), len(tools),
            f"{total_budget:.1f}" if budget_enabled else "off",
        )
        if force_submit:
            logger.info(
                "agent_budget_depleted_at_start case_id=%s total_budget=%.1f",
                case_id,
                total_budget,
            )

        # Main agent loop
        while self.config.max_steps is None or turn < self.config.max_steps:
            turn += 1
            # When the budget is spent, withdraw tools so the model must submit.
            # If the benchmark has an explicit terminal tool, leave only that one
            # available so the model submits via the tool rather than by free text.
            if force_submit:
                active_tools = terminal_schema if terminal_schema else []
            else:
                active_tools = tools
            # LLM invocation
            logger.info("llm_call_started case_id=%s turn=%d model=%s message_count=%d tool_count=%d", case_id, turn, self.connector.model_name, len(trajectory), len(active_tools))
            llm_t0 = time.monotonic()
            response = self.connector.complete(
                messages=trajectory,
                tools=active_tools,
            )
            llm_duration = time.monotonic() - llm_t0
            self._add_usage(total_usage, response.usage)
            logger.info("llm_call_finished case_id=%s turn=%d duration_secs=%.2f finish_reason=%s prompt_tokens=%s completion_tokens=%s total_tokens=%s", case_id, turn, llm_duration, response.finish_reason, response.usage.prompt_tokens, response.usage.completion_tokens, response.usage.total_tokens)
            if llm_responses_path:
                with open(llm_responses_path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(response.raw_response, ensure_ascii=False) + "\n")
                logger.info("llm_response_saved case_id=%s turn=%d file=%s", case_id, turn, Path(llm_responses_path).name)

            # Update trajectory with the raw message
            trajectory.append(response.raw_message)
            tool_calls = response.tool_calls

            # If finished -> return the result
            if response.finish_reason != "tool_calls" and not tool_calls:
                final_text = response.content or ""
                if trajectory_path:
                    Path(trajectory_path).write_text(
                        json.dumps(trajectory, indent=2, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    logger.info("trajectory_saved case_id=%s file=%s", case_id, Path(trajectory_path).name)
                final_sql = self._extract_sql(final_text)
                final_artifact_path = final_text.strip() if workspace_mode else None
                logger.info("agent_finished case_id=%s turns=%d final_text_chars=%d final_sql_chars=%d final_artifact_path=%s", case_id, turn, len(final_text), len(final_sql), final_artifact_path)
                return AgentRunOutput(
                    final_text=final_text,
                    final_sql=final_sql,
                    final_artifact_path=final_artifact_path,
                    trajectory=trajectory,
                    llm_responses_path=llm_responses_path,
                    trajectory_path=trajectory_path,
                    usage=total_usage,
                    llm_call_count=turn,
                    remaining_budget=remaining_budget if budget_enabled else None,
                )

            # If not finished -> process the tool call(s)
            handled_any = False
            for block in tool_calls:
                if block.get("type") != "function":
                    continue
                handled_any = True
                function_info = block.get("function", {})
                tool_name = function_info.get("name")
                raw_arguments = function_info.get("arguments") or "{}"
                is_terminal = bool(terminal_tool and tool_name == terminal_tool)
                cost = costs.get(tool_name, 0)
                # ADK-style budget gate: a normal tool the remaining budget cannot
                # afford is *not* executed. Instead the agent is told to submit and
                # tools are withdrawn next turn. The terminal tool (submit) is always
                # allowed even on an empty budget -- a free exit, mirroring the ADK
                # ``submit_sql`` branch -- and is charged below when it runs.
                if budget_enabled and not is_terminal and remaining_budget < cost:
                    force_submit = True
                    trajectory.append(
                        {
                            "tool_call_id": block.get("id"),
                            "role": "tool",
                            "name": tool_name,
                            "content": (
                                f"Budget exhausted ({remaining_budget:.1f} remaining). "
                                "You MUST call submit now with your best SQL."
                            ),
                        }
                    )
                    logger.info(
                        "agent_tool_budget_blocked case_id=%s turn=%d tool=%s remaining_budget=%.1f cost=%.1f",
                        case_id,
                        turn,
                        tool_name,
                        remaining_budget,
                        cost,
                    )
                    continue
                if budget_enabled:
                    if is_terminal and remaining_budget < cost:
                        # ADK free exit: submit on an unaffordable budget is allowed
                        # but *not* charged; the budget is pinned to -1 to signal
                        # exhaustion (mirrors callbacks.py's submit_sql branch) rather
                        # than driven negative by the unaffordable cost.
                        remaining_budget = -1.0
                    else:
                        remaining_budget -= cost
                # Terminal tool (e.g. submit(sql)): the handler grades the answer
                # and returns a verdict; the loop only decides terminate-vs-retry.
                # A graded rejection retries (feeds the reason back) while budget
                # remains; a pass, an ungraded result, or no budget ends the phase.
                if is_terminal:
                    try:
                        term_args = json.loads(raw_arguments)
                    except Exception:
                        term_args = {}
                    verdict = (
                        terminal_handler(term_args)
                        if terminal_handler is not None
                        else TerminalVerdict(final_sql=str(term_args.get("sql", "")).strip(), passed=None)
                    )
                    if verdict.passed is False and budget_enabled and remaining_budget > 0:
                        trajectory.append(
                            {
                                "tool_call_id": block.get("id"),
                                "role": "tool",
                                "name": tool_name,
                                "content": self._format_submit_retry_observation(
                                    verdict,
                                    remaining_budget=remaining_budget,
                                    total_budget=total_budget,
                                ),
                            }
                        )
                        logger.info("agent_submit_rejected case_id=%s turn=%d remaining_budget=%.1f", case_id, turn, remaining_budget)
                        continue
                    trajectory.append(
                        {
                            "tool_call_id": block.get("id"),
                            "role": "tool",
                            "name": tool_name,
                            "content": self._format_submit_terminal_observation(
                                verdict,
                                remaining_budget=remaining_budget if budget_enabled else None,
                                total_budget=total_budget if budget_enabled else None,
                            ),
                        }
                    )
                    if trajectory_path:
                        Path(trajectory_path).write_text(
                            json.dumps(trajectory, indent=2, ensure_ascii=False),
                            encoding="utf-8",
                        )
                        logger.info("trajectory_saved case_id=%s file=%s", case_id, Path(trajectory_path).name)
                    final_text = f"```sql\n{verdict.final_sql}\n```" if verdict.final_sql else ""
                    logger.info("agent_submitted case_id=%s turns=%d final_sql_chars=%d graded_pass=%s", case_id, turn, len(verdict.final_sql), verdict.passed)
                    return AgentRunOutput(
                        final_text=final_text,
                        final_sql=verdict.final_sql,
                        final_artifact_path=None,
                        trajectory=trajectory,
                        llm_responses_path=llm_responses_path,
                        trajectory_path=trajectory_path,
                        usage=total_usage,
                        llm_call_count=turn,
                        remaining_budget=remaining_budget if budget_enabled else None,
                    )
                handler = tool_handler_map.get(tool_name)
                logger.info("tool_call_started case_id=%s turn=%d tool=%s arguments=%s", case_id, turn, tool_name, self._format_log_value(raw_arguments))
                tool_t0 = time.monotonic()
                try:
                    args = json.loads(raw_arguments)
                    tool_response = handler(**args) if handler else f"Error: unknown tool {tool_name}"
                except Exception as exc:
                    tool_response = f"Error: invalid tool arguments for {tool_name}: {exc}"
                    logger.warning("tool_call_exception case_id=%s turn=%d tool=%s error=%s", case_id, turn, tool_name, exc)
                tool_status = "error" if str(tool_response).startswith("Error:") else "success"
                logger.info("tool_call_finished case_id=%s turn=%d tool=%s status=%s duration_secs=%.2f output_chars=%d", case_id, turn, tool_name, tool_status, time.monotonic() - tool_t0, len(str(tool_response)))
                # See: https://docs.litellm.ai/docs/completion/function_call
                trajectory.append(
                    {
                        "tool_call_id": block.get("id"),
                        "role": "tool",
                        "name": tool_name,
                        "content": tool_response,
                    }
                )

            if not handled_any:
                logger.warning("no_executable_tool_calls case_id=%s turn=%d finish_reason=tool_calls", case_id, turn)

            # Force submission once spent. Regular DB/tool observations keep the
            # dbAgent text/JSON format; submit retry observations carry budget.
            if budget_enabled and not force_submit:
                if remaining_budget <= 0:
                    force_submit = True
                    logger.info("agent_budget_depleted case_id=%s turn=%d total_budget=%.1f", case_id, turn, total_budget)

        if trajectory_path:
            Path(trajectory_path).write_text(
                json.dumps(trajectory, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            logger.info("trajectory_saved case_id=%s file=%s", case_id, Path(trajectory_path).name)
        logger.warning(
            "agent_stopped_max_steps case_id=%s turns=%d max_steps=%d",
            case_id,
            turn,
            self.config.max_steps,
        )
        return AgentRunOutput(
            final_text="",
            final_sql="",
            final_artifact_path=None,
            trajectory=trajectory,
            llm_responses_path=llm_responses_path,
            trajectory_path=trajectory_path,
            usage=total_usage,
            llm_call_count=turn,
            remaining_budget=remaining_budget if budget_enabled else None,
        )

    def _build_system_prompt(
        self,
        db_type: DBType,
        db_path: str | None,
        workspace_mode: bool,
        workdir: Path,
    ) -> str:
        # ask_user is only available when not yolo (see build_llm_tools); keep the
        # clarification instruction paired with the tool so they stay consistent.
        clarify_text = (
            ""
            if self.config.yolo
            else "If the user's intent is unclear, ask for clarification before acting. "
        )
        base = (
            f"You are a SQL agent at working directory: {workdir}. "
            "You have access to SQL tools for schema inspection, sampling, read-only queries, EXPLAIN plans, and SQL validation. "
        )
        if self.config.max_steps is None:
            base += "Use as many iterations as needed before returning the final answer. "
        else:
            base += f"The maximum number of steps you can take is {self.config.max_steps}. "
        base += (
            "Use bash only when the SQL tools are not enough. "
            f"{clarify_text}"
        )
        if workspace_mode:
            max_steps_text = (
                f"The maximum number of steps you can take is {self.config.max_steps}. "
                if self.config.max_steps is not None
                else "Use as many iterations as needed before returning the final answer. "
            )
            return (
                f"You are a DBT and DuckDB agent working inside {workdir}. "
                "Your goal is to complete the given Spider2-DBT task. "
                "Start by inspecting the workspace files, especially dbt_project.yml, profiles.yml, models/, macros/, seeds/, and README or markdown files. "
                "Use bash to read files, edit SQL or YAML files, and install project dependencies if needed. "
                "Use the run_dbt tool to run dbt; do not run dbt through bash. "
                "Keep all changes inside this workspace. "
                f"{clarify_text}"
                f"{max_steps_text}"
                "After making changes, run dbt so the project materializes the expected result tables or files. "
                "Before answering, verify which .duckdb, .csv, or other artifact should be submitted. "
                "Prefer reusing existing logic over inventing it. If a target model is missing "
                "or stubbed, recover its canonical definition from dbt_packages/, a sibling or "
                "analogous model, or the model's own .yml column descriptions and tests, and "
                "mirror its grain, filters, sign conventions, and date boundaries exactly. Do "
                "not modify models that already exist. Treat each model's .yml columns, order, "
                "tests, and docs as the authoritative contract for what to produce. A passing "
                "dbt run or dbt test proves the SQL is valid, not that the values are correct; "
                "do not treat green tests as done. "
                "The final answer must be only one relative file path inside the workspace, with no code fence and no explanation. "
                "Prefer returning a .duckdb artifact when one exists and contains the produced tables."
            )
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
        return base

    @staticmethod
    def _format_submit_retry_observation(
        verdict: TerminalVerdict,
        *,
        remaining_budget: float,
        total_budget: float,
    ) -> str:
        response = verdict.message or "Your SQL is not correct."
        return SQLAgent._append_budget_note(response, remaining_budget, total_budget)

    @staticmethod
    def _format_submit_terminal_observation(
        verdict: TerminalVerdict,
        *,
        remaining_budget: float | None,
        total_budget: float | None,
    ) -> str:
        if verdict.passed is None:
            response = "Final SQL submitted; phase ended (graded by host)."
        elif verdict.passed is True:
            response = "Final SQL accepted; phase ended."
        else:
            response = "Final SQL rejected and budget exhausted; phase ended."
        if (
            verdict.passed is not True
            and remaining_budget is not None
            and total_budget is not None
            and remaining_budget >= 0
        ):
            response = SQLAgent._append_budget_note(response, remaining_budget, total_budget)
        return response

    @staticmethod
    def _append_budget_note(content: str, remaining_budget: float, total_budget: float) -> str:
        shown_remaining = max(remaining_budget, 0.0)
        return f"{content}\n\n[SYSTEM NOTE: Remaining budget: {shown_remaining:.1f}/{total_budget:.1f}]"

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
    def _format_log_value(value: str) -> str:
        return value.replace("\n", "\\n").replace("\r", "\\r")

    @staticmethod
    def _add_usage(total: UsageStats, usage: UsageStats) -> None:
        for field in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"):
            value = getattr(usage, field)
            if value is None:
                continue
            current = getattr(total, field)
            setattr(total, field, value if current is None else current + value)
