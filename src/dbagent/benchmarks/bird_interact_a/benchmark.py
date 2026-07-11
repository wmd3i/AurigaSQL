from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from .bird_interact_tools import (
    BIRD_INTERACT_ACTION_COSTS,
    BIRD_INTERACT_TOOL_COSTS,
)
from .user_simulator import UserSimulator
from dbagent.benchmarks.base import BenchmarkAdapter, BenchmarkCase, CaseOutcome, EvaluationRecord, TaskSpec

from .evaluator import (
    InteractEvaluation,
    PHASE_REWARD,
    PostgresConfig,
    _pick_error_type,
    coerce_sql_list,
    drop_database,
    evaluate_interact_prediction,
    evaluate_phase_attempt,
    execute_queries,
    parse_prediction,
    reset_database,
    _extract_sql_from_text,
)


logger = logging.getLogger(__name__)

# Per-case budget = ENV + SUBMIT + (ambiguity_count * ask_cost) + user_patience_budget.
_ENV_INTERACT_BUDGET = 3.0
_SUBMIT_BUDGET = 3.0
# User-patience: the original defaults to 6.
_USER_PATIENCE_BUDGET = 6.0

from .setup import (
    ensure_bird_interact_postgres,
    prepare_bird_interact_dataset,
    resolve_bird_interact_layout,
    teardown_bird_interact_postgres,
)


class _SubmitScorer:
    """Live host-side grader for one phase's ``submit()`` calls.

    Wired to the container via the shared IPC channel (see ``IpcResponder``),
    it scores each submission against a dedicated *eval* database (cloned from the
    template per attempt) so grading never disturbs the agent's own working DB.
    Every attempt is recorded so ``run_case`` can read the verdicts and reward
    back after the agent run. The first-try / retry distinction is tracked only for
    diagnostics: a-mode awards the full phase reward on any passing submission.
    """

    def __init__(
        self,
        *,
        record: dict[str, Any],
        phase: int,
        pg_config: "PostgresConfig",
        eval_db: str,
        phase1_state_sqls: list[str] | None = None,
    ) -> None:
        # Point evaluation at a throwaway DB so resets don't touch the agent's DB.
        self._record = {**record, "working_db": eval_db}
        self._phase = phase
        self._pg = pg_config
        self._phase1_state_sqls = phase1_state_sqls
        self.attempts: list[Any] = []
        self.passed = False
        self.passing_attempt: Any | None = None
        self.passing_sqls: list[str] = []

    def evaluate(self, sql: str) -> dict[str, Any]:
        pred_sqls = coerce_sql_list(_extract_sql_from_text(sql))
        result = evaluate_phase_attempt(
            self._record,
            phase=self._phase,
            attempt=len(self.attempts) + 1,
            pred_sqls=pred_sqls,
            pg_config=self._pg,
            phase1_state_sqls=self._phase1_state_sqls,
        )
        self.attempts.append(result)
        if result.passed and not self.passed:
            self.passed = True
            self.passing_attempt = result
            self.passing_sqls = result.sqls
        has_follow_up = bool(
            self._record.get("follow_up") and coerce_sql_list(self._record["follow_up"].get("sol_sql"))
        )
        follow_up_query = (self._record.get("follow_up") or {}).get("query", "") if has_follow_up else ""
        reward = PHASE_REWARD.get(self._phase, 0.0)
        if result.passed:
            message = f"Phase {self._phase} correct! (Reward: {reward})."
            message += "\nMoving to Phase 2." if self._phase == 1 and has_follow_up else "\nTask finished."
        else:
            message = f"SQL failed Phase {self._phase}.\n{result.error_message or 'Your SQL is not correct.'}"
        verdict = {
            "passed": result.passed,
            "message": message,
            "phase": self._phase,
            "attempt": result.attempt,
            "reward": reward if result.passed else 0.0,
            "has_follow_up": has_follow_up,
            "follow_up_query": follow_up_query,
        }
        if result.passed:
            return verdict
        return verdict


class BirdInteractABenchmark(BenchmarkAdapter):
    benchmark_id = "bird-interact-a"
    docker_execution_scope = "case"
    docker_image = "dbagent-bird-interact-a-agent"
    dockerfile_path = None
    docker_build_context = None

    def __init__(self, workdir: Path, *, split: str = "full") -> None:
        self.workdir = workdir.expanduser().resolve()
        self.dockerfile_path = self.workdir / "src" / "dbagent" / "benchmarks" / "bird_interact_a" / "Dockerfile"
        self.docker_build_context = self.workdir
        self.source_root: Path | None = None
        self.data_dir: Path | None = None
        self.data_path: Path | None = None
        # Prepare the dataset for the requested split (lite and full use different Postgres image)
        self.setup_split = self._normalize_split(split)
        self._prepare_dataset_if_needed()
        ensure_bird_interact_postgres(self.workdir, self.setup_split)
        self.pg_config = PostgresConfig.from_env()

    def finish_run(self, run_dir: Path) -> None:
        teardown_bird_interact_postgres(self.workdir, self.setup_split)

    def iter_cases(self, split: str, limit: int | None = None) -> list[BenchmarkCase]:
        normalized_split = self._normalize_split(split)
        self._set_layout(normalized_split)
        assert self.data_path is not None
        data = self._load_jsonl(self.data_path)
        if limit is not None:
            data = data[:limit]
        return [
            BenchmarkCase(
                case_id=item["instance_id"],
                case_index=index,
                split=normalized_split,
                payload=item,
            )
            for index, item in enumerate(data)
        ]

    def build_task(self, case: BenchmarkCase) -> TaskSpec:
        item = case.payload
        db_name = item["selected_database"]
        # Mirror the original BIRD-Interact task_db lifecycle.
        # Before the agent runs, clone a per-case working DB from the template,
        # e.g. for case "solar_panel_1" on database "solar_panel":
        #     CREATE DATABASE "solar_panel__solar_panel_1" TEMPLATE "solar_panel_template"
        # so the agent has an isolated DB to explore.
        template_db = f"{db_name}_template"
        agent_db_name = self._task_db_name(case.case_id, db_name)
        reset_database(agent_db_name, self.pg_config, template_db=template_db)
        has_follow_up = bool(item.get("follow_up") and item["follow_up"].get("query"))
        budget = self._initial_budget(item)
        kb_entries = self._visible_knowledge(db_name, item)
        column_meanings = self._column_meanings(db_name)
        prompt = self._build_prompt(item, budget=budget)
        schema_path = self._db_asset_path(db_name, f"{db_name}_schema.txt")

        return TaskSpec(
            benchmark_id=self.benchmark_id,
            case_id=case.case_id,
            case_index=case.case_index,
            split=case.split,
            prompt=prompt,
            # a-mode hands the agent the ambiguous query only (it feeds
            # the user simulator)
            user_question=item.get("amb_user_query", ""),
            db_type="postgres",
            db_path=self.pg_config.dsn(agent_db_name, for_agent=True),
            input_record={
                "instance_id": item["instance_id"],
                "selected_database": db_name,
                "working_db": agent_db_name,
                "amb_user_query": item.get("amb_user_query", ""),
                "category": item.get("category", "Query"),
                "difficulty_tier": item.get("difficulty_tier"),
                "has_follow_up": has_follow_up,
                "budget": budget,
                "schema_path": str(schema_path) if schema_path else None,
                "data_path": str(self.data_path) if self.data_path else None,
            },
            reference={
                "query": item.get("query", ""),
                "sol_sql": item.get("sol_sql", []),
                "test_cases": item.get("test_cases", []),
                "conditions": item.get("conditions", {}),
                "preprocess_sql": item.get("preprocess_sql", []),
                "clean_up_sqls": item.get("clean_up_sqls", []),
                "follow_up": item.get("follow_up", {}),
                "user_query_ambiguity": item.get("user_query_ambiguity", {}),
                "knowledge_ambiguity": item.get("knowledge_ambiguity", []),
            },
            metadata={
                "task_workspace": str(self._agent_workspace(case.case_id)),
                "postgres_dsn": self.pg_config.dsn(agent_db_name, for_agent=True),
                # Agent-side a-mode tools + action budget, forwarded opaquely by
                # the runner into SQLAgent.run() via agent_kwargs. KB/column data
                # are public (no ground truth) and delivered here so the tools
                # never read the dataset dir, which holds the merged GT (sol_sql).
                "agent_kwargs": {
                    "kb_entries": kb_entries,
                    "column_meanings": column_meanings,
                    "budget": budget,
                    "tool_costs": BIRD_INTERACT_TOOL_COSTS,
                    # The agent submits its final SQL by calling submit(sql); that
                    # tool call is terminal and ends the phase.
                    "terminal_tool": "submit",
                },
            },
        )

    def get_evaluation_prediction(self, task: TaskSpec, prediction: dict[str, Any]) -> str:
        return str(prediction.get("raw_text") or prediction.get("final_sql") or "")

    def evaluate_prediction(self, task: TaskSpec, prediction_sql: str) -> EvaluationRecord:
        record = {
            **task.input_record,
            **task.reference,
        }
        try:
            evaluation = evaluate_interact_prediction(record, prediction_sql, pg_config=self.pg_config)
        except Exception as exc:
            return EvaluationRecord(
                passed=False,
                score=0.0,
                mode="bird_interact_a",
                details={"error": str(exc), "prediction": prediction_sql},
                error_type="evaluation_error",
            )
        finally:
            # Drop the per-case working DB created in build_task (mirrors /cleanup_task).
            # Best-effort; never fail the case on cleanup.
            working_db = task.input_record.get("working_db")
            if working_db:
                try:
                    drop_database(working_db, self.pg_config)
                except Exception:
                    logger.warning("failed to drop per-case working DB %s", working_db, exc_info=True)
            self._cleanup_agent_workspace(task.metadata.get("task_workspace"))

        details = evaluation.to_details()
        details["parsed_prediction"] = parse_prediction(prediction_sql)
        return EvaluationRecord(
            passed=evaluation.passed,
            score=evaluation.total_reward,
            mode="bird_interact_a",
            details=details,
            error_type=evaluation.error_type,
        )

    def run_case(self, task: TaskSpec, run_agent) -> CaseOutcome:
        """Strict two-phase interaction, mirroring the original a-mode flow.

        Phase 1: the agent sees only the ambiguous query and submits ``phase1_sql``.
        The host evaluates it (ground truth stays host-side; the agent container
        never sees it). Only if Phase 1 passes is the follow-up revealed; the agent
        then continues in the SAME conversation, drawing from its REMAINING shared
        budget, and submits ``phase2_sql``. Rewards are the a-mode first-try values
        (0.7 / 0.3) with no debug-discount tier.
        """
        record = {**task.input_record, **task.reference}
        pg = self.pg_config
        base_db = task.input_record["selected_database"]
        working_db = task.input_record.get("working_db") or base_db
        template_db = f"{base_db}_template"
        # Throwaway DB for live submit grading: cloned from the template per
        # attempt so resets never disturb the agent's own working DB. Kept distinct
        # from working_db and within Postgres' 63-byte identifier limit.
        eval_db = f"{working_db[:57]}__eval"

        try:
            # ── Phase 1 ──
            # The agent submits via submit(sql); each submission is graded live by
            # scorer1 over the IPC channel, with feedback + retry until it passes or
            # the budget runs out (see SQLAgent.run / IpcResponder).
            scorer1 = _SubmitScorer(record=record, phase=1, pg_config=pg, eval_db=eval_db)
            out1 = run_agent(
                phase_label="p1",
                user_sim_config=self._user_sim_config(record, phase=1, db_name=base_db),
                submit_eval_config={"scorer": scorer1},
            )
            attempts = list(scorer1.attempts)
            # Fallback: the agent ended without a graded submit (plain final SQL
            # block, or a grading timeout). Score the final answer once, host-side.
            if not attempts:
                fallback_sqls = self._extract_pass_sql(out1["final_text"])
                attempts.append(evaluate_phase_attempt(
                    record, phase=1, attempt=1,
                    pred_sqls=fallback_sqls, pg_config=pg,
                ))
            total_reward = 0.0
            phase1_attempt = next((a for a in attempts if a.passed), None)
            phase1_passed = phase1_attempt is not None
            successful_phase1_sqls = phase1_attempt.sqls if phase1_attempt else []
            if phase1_passed:
                phase1_attempt.reward = PHASE_REWARD[1]
                total_reward += PHASE_REWARD[1]
            p1_sqls = successful_phase1_sqls or self._extract_pass_sql(out1["final_text"])

            has_follow_up = bool(
                record.get("follow_up") and coerce_sql_list(record["follow_up"].get("sol_sql"))
            )
            phase2_passed = False
            p2_sqls = []
            output = out1

            # ── Phase 2 (only if Phase 1 passed and a follow-up exists) ──
            if phase1_passed and has_follow_up:
                # Rebuild the working DB to the post-Phase-1 state so the agent
                # explores the same DB the Phase 2 evaluation will score against.
                reset_database(working_db, pg, template_db=template_db)
                if successful_phase1_sqls:
                    try:
                        execute_queries(successful_phase1_sqls, working_db)
                    except Exception:
                        logger.warning("phase1 state replay failed for %s", working_db, exc_info=True)
                scorer2 = _SubmitScorer(
                    record=record, phase=2, pg_config=pg, eval_db=eval_db,
                    phase1_state_sqls=successful_phase1_sqls,
                )
                out2 = run_agent(
                    phase_label="p2",
                    prompt_override=self._build_followup_message(task),
                    agent_kwargs_override={
                        "resume_messages": self._resume_messages(out1),
                        "budget": out1.get("remaining_budget"),
                    },
                    user_sim_config=self._user_sim_config(record, phase=2, db_name=base_db),
                    submit_eval_config={"scorer": scorer2},
                )
                output = self._merge_agent_outputs(out1, out2)
                p2_attempts = list(scorer2.attempts)
                if not p2_attempts:
                    fallback2 = self._extract_pass_sql(out2["final_text"])
                    p2_attempts.append(evaluate_phase_attempt(
                        record, phase=2, attempt=1,
                        pred_sqls=fallback2, pg_config=pg,
                        phase1_state_sqls=successful_phase1_sqls,
                    ))
                attempts.extend(p2_attempts)
                phase2_attempt = next((a for a in p2_attempts if a.passed), None)
                phase2_passed = phase2_attempt is not None
                if phase2_passed:
                    phase2_attempt.reward = PHASE_REWARD[2]
                    total_reward += PHASE_REWARD[2]
                p2_sqls = phase2_attempt.sqls if phase2_attempt else self._extract_pass_sql(out2["final_text"])

            passed = phase1_passed and (phase2_passed if has_follow_up else True)
            evaluation = InteractEvaluation(
                passed=passed,
                total_reward=round(total_reward, 4),
                phase1_passed=phase1_passed,
                phase2_passed=phase2_passed,
                has_follow_up=has_follow_up,
                attempts=attempts,
                error_type=None if passed else _pick_error_type(attempts),
            )
        finally:
            if task.input_record.get("working_db"):
                try:
                    drop_database(task.input_record["working_db"], pg)
                except Exception:
                    logger.warning("failed to drop per-case working DB %s", working_db, exc_info=True)
            # Drop the live-grading eval DB (created lazily on first submit).
            try:
                drop_database(eval_db, pg)
            except Exception:
                logger.warning("failed to drop eval DB %s", eval_db, exc_info=True)
            self._cleanup_agent_workspace(task.metadata.get("task_workspace"))

        # Combined, re-scoreable prediction (parse_prediction can re-extract both).
        raw_text = json.dumps(
            {"phase1_sql": p1_sqls, "phase2_sql": p2_sqls},
            ensure_ascii=False,
        )
        details = evaluation.to_details()
        details["parsed_prediction"] = {"phase1_sql": p1_sqls, "phase2_sql": p2_sqls}
        prediction_payload = {
            "raw_text": raw_text,
            "final_sql": "\n".join(p1_sqls + p2_sqls),
            "final_artifact_path": None,
        }
        evaluation_record = EvaluationRecord(
            passed=evaluation.passed,
            score=evaluation.total_reward,
            mode="bird_interact_a",
            details=details,
            error_type=evaluation.error_type,
        )
        return CaseOutcome(
            prediction=prediction_payload,
            evaluation=evaluation_record,
            agent_output=output,
        )

    @staticmethod
    def _merge_agent_outputs(out1: dict[str, Any], out2: dict[str, Any]) -> dict[str, Any]:
        # Phase 2 ran with Phase 1's trajectory replayed, so out2's trajectory file
        # already holds the full conversation; keep out2 as the base and just fold
        # in Phase 1's call count + token usage for accurate per-case accounting.
        merged = dict(out2)
        merged["llm_call_count"] = (out1.get("llm_call_count") or 0) + (out2.get("llm_call_count") or 0)
        usage1 = out1.get("usage") or {}
        usage2 = out2.get("usage") or {}
        merged["usage"] = {
            key: (usage1.get(key) or 0) + (usage2.get(key) or 0)
            for key in set(usage1) | set(usage2)
            if isinstance(usage1.get(key, 0), (int, float)) and isinstance(usage2.get(key, 0), (int, float))
        }
        return merged

    def export_predictions(self, run_dir: Path, sample_results: list[dict[str, Any]]) -> Path:
        submission_dir = run_dir / "submission"
        submission_dir.mkdir(parents=True, exist_ok=True)
        output_path = submission_dir / "bird_interact_a_predictions.jsonl"
        with output_path.open("w", encoding="utf-8") as handle:
            for sample in sample_results:
                raw_text = sample.get("prediction", {}).get("raw_text") or sample.get("prediction", {}).get("final_sql") or ""
                input_record = sample.get("input", {})
                handle.write(
                    json.dumps(
                        {
                            "instance_id": input_record.get("instance_id"),
                            "selected_database": input_record.get("selected_database"),
                            "prediction": parse_prediction(raw_text),
                            "raw_text": raw_text,
                            "score": sample.get("evaluation", {}).get("score"),
                            "passed": sample.get("evaluation", {}).get("passed"),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        return output_path

    def _prepare_dataset_if_needed(self) -> None:
        layout = prepare_bird_interact_dataset(self.workdir, self.setup_split)
        self.source_root = layout["source_root"]
        self.data_dir = layout["data_dir"]
        self.data_path = layout["data_path"]

    def _set_layout(self, split: str) -> None:
        layout = resolve_bird_interact_layout(self.workdir, self._normalize_split(split))
        self.source_root = layout["source_root"]
        self.data_dir = layout["data_dir"]
        self.data_path = layout["data_path"]

    @staticmethod
    def _normalize_split(split: str) -> str:
        normalized = split.strip().lower()
        if normalized in {"lite", "full"}:
            return normalized
        raise ValueError(f"BIRD-Interact-A currently supports split=full/lite, got {split!r}")

    def _build_prompt(self, item: dict[str, Any], *, budget: float) -> str:
        # Phase 1 prompt: the agent sees only the ambiguous query. The follow-up is
        # deliberately withheld here and revealed (via _build_followup_message) only
        # after Phase 1 passes, matching the original a-mode two-phase interaction.
        return (
            f"BIRD-Interact-A instance: {item['instance_id']}\n"
            f"PostgreSQL database: {item['selected_database']}\n\n"
            f"Ambiguous user query:\n{item.get('amb_user_query', '')}\n\n"
            "You are an agent resolving an intentionally ambiguous request against a live PostgreSQL "
            "database. You have tools to inspect tables, run read-only SQL, look up per-column meanings "
            "(get_column_meaning / get_all_column_meanings), and read external knowledge "
            "(get_all_external_knowledge_names / get_knowledge_definition / get_all_knowledge_definitions). "
            "The request is intentionally ambiguous and some knowledge may be deliberately withheld. When the "
            "schema, column meanings, and knowledge do not resolve an ambiguity, ask() the user rather than "
            "guessing or settling on the most likely reading—they answer in natural language. Ask one "
            "question at a time, only to resolve the request's ambiguity (off-topic questions are refused), "
            "and use the schema, column meanings, and knowledge to make each question precise. If an answer "
            "resolves one ambiguity but reveals another, keep asking until the request is fully pinned down. "
            "Stop asking about a point only once the user has answered it or made clear they cannot resolve "
            "it—then, for that point alone, fall back to the interpretation best supported by the evidence.\n\n"
            "Each tool call consumes a limited budget; when it is used up you must submit immediately. Spend "
            "it on resolving the ambiguity and validating your query, and prefer one precise question that "
            "resolves several unknowns over many narrow ones or a long chain of inspection.\n\n"
            "Submit your answer by calling the submit(sql) tool with a single SQL query. Each submission is "
            "graded immediately: if it passes, the phase ends; if it fails, you get the reason and may revise "
            "and submit again while budget remains. Once the budget is gone, your next submission is final.\n\n"
            "Before finalizing, explicitly resolve the core ambiguity types: metric or formula, grouping "
            "dimension, filtered-count definition, and sort direction (if the request implies ordering but "
            "omits ascending/descending, treat the direction as ambiguous). If a user term maps to multiple "
            "plausible columns or knowledge entries after targeted inspection, ask which one they mean rather "
            "than choosing from the name alone; when a term could mean either a metric or its complement, "
            "prefer the reading that best fits the wording.\n\n"
            "If a metric, formula, ratio, or threshold the request depends on is not defined in any available "
            "source (external knowledge, schema, or column meanings) and cannot be derived exactly from them, "
            "ask() the user for it rather than inventing or guessing a value. Decide this quickly: once a "
            "brief check does not turn up the definition, an empty lookup is itself the signal to ask()—do "
            "not keep digging or try to reconstruct it through many inspection steps.\n\n"
            "Once you have obtained a definition, formula, or rule—whether from a reference source or from "
            "the user—implement it exactly as specified, not a paraphrase or close approximation: preserve "
            "its components, operators, constants, and structure, and do not introduce transformations, "
            "simplifications, or substitutions it does not call for. If it refers to something you have not "
            "confirmed exists, verify that before relying on it rather than assuming a similar-looking "
            "alternative.\n\n"
            "Return exactly what the request asks for and nothing extra, and leave values in their natural "
            "form: do not round, cast, or otherwise format values unless the user explicitly asks for a "
            "particular format, since such cosmetic changes can affect how the result is compared.\n\n"
            "Before each submission, actually execute your full candidate answer and check the observed "
            "result against every requirement you resolved—the output columns and their order, the level of "
            "aggregation, any required filtering, and any ordering—rather than judging it only by inspection. "
            "Submit only once what you observe matches what you intended."
        )

    @staticmethod
    def _extract_pass_sql(final_text: str) -> list[str]:
        # Each phase is its own agent pass that ends with a single ```sql ... ```
        # block, so we just pull the SQL out of that block (falls back to the whole
        # text if the model omitted the fence). No phase keys to disambiguate.
        return coerce_sql_list(_extract_sql_from_text(final_text))

    def _user_sim_config(self, record: dict[str, Any], *, phase: int, db_name: str) -> dict[str, Any]:
        """Host-side config for the ``ask`` user simulator (never sent to the agent).

        Carries a ``factory(llm_caller) -> UserSimulator`` closure over this case's
        ground truth so the runner can build the simulator with its own LLM caller.
        Phase 1 exposes the labeled ambiguity; phase 2 (the follow-up) has none.
        """
        db_schema = self._read_db_asset(db_name, f"{db_name}_schema.txt") or ""
        if phase == 1:
            clear_query = record.get("query", "")
            reference_sql = record.get("sol_sql", [])
            ambiguity = {
                "user_query_ambiguity": record.get("user_query_ambiguity", {}),
                "knowledge_ambiguity": record.get("knowledge_ambiguity", []),
            }
        else:
            follow_up = record.get("follow_up") or {}
            clear_query = follow_up.get("query", "")
            reference_sql = follow_up.get("sol_sql", [])
            ambiguity = {}

        def factory(llm_caller):
            return UserSimulator(
                clear_query=clear_query,
                reference_sql=reference_sql,
                ambiguity=ambiguity,
                db_schema=db_schema,
                llm=llm_caller,
            )

        return {"factory": factory}

    @staticmethod
    def _resume_messages(out: dict[str, Any]) -> list[dict[str, Any]]:
        # Phase 2 continues Phase 1's conversation. The agent's in-memory
        # trajectory is not serialized back across the container boundary
        # (out["trajectory"] is empty); the real Phase 1 transcript lives on
        # disk at out["trajectory_path"] (trajectory_p1.json). Load it so Phase 2
        # actually inherits the Phase 1 context (schema exploration, clarifications,
        # the passing SQL), mirroring the original single-session ADK flow.
        msgs = out.get("trajectory")
        if msgs:
            return msgs
        path = out.get("trajectory_path")
        if path and Path(path).exists():
            return json.loads(Path(path).read_text(encoding="utf-8"))
        return []

    def _build_followup_message(self, task: TaskSpec) -> str:
        # Revealed only after Phase 1 passes (see run_case). The agent continues in
        # the same conversation with its remaining shared budget. Kept terse to match
        # the original BIRD-Interact-ADK phase-transition message (system_agent/
        # tools.py submit_sql): a pass notice + the follow-up query, with no extra
        # solving guidance injected.
        follow_up_query = (task.reference.get("follow_up") or {}).get("query", "")
        return (
            "Phase 1 correct! Moving to Phase 2.\n"
            f"Follow-up question: {follow_up_query}\n"
            "When done, submit your final answer by calling submit(sql)."
        )

    @staticmethod
    def _task_db_name(case_id: str, db_name: str) -> str:
        # Postgres identifiers cap at 63 bytes. Keep a short hash so two long case
        # IDs sharing a prefix stay unique after truncation (matters under
        # concurrency). Cap at 57 so the derived "{working_db}__eval" DB also fits.
        safe_id = re.sub(r"[^0-9a-zA-Z_]", "_", case_id)
        digest = hashlib.sha1(f"{db_name}__{case_id}".encode()).hexdigest()[:6]
        return f"{f'{db_name}__{safe_id}'[:50]}_{digest}"

    def _agent_workspace(self, case_id: str) -> Path:
        # The agent's bash tool runs in (and the runner bind-mounts) this dir.
        # It must NOT be the dataset dir, which holds the merged GT answer file
        # (bird_interact_data.jsonl with sol_sql) and would let the agent grep the
        # answer. Schema + knowledge are already in the prompt and the DB is reached
        # over the network, so a clean empty per-case dir is all the agent needs.
        safe_id = re.sub(r"[^0-9A-Za-z_]", "_", case_id)
        workspace = self.workdir / ".bird_interact_agent_ws" / safe_id
        workspace.mkdir(parents=True, exist_ok=True)
        return workspace

    def _cleanup_agent_workspace(self, task_workspace: str | None) -> None:
        # Remove the per-case scratch dir created in build_task. Guarded to only
        # ever delete paths under our ".bird_interact_agent_ws" marker dir.
        if not task_workspace:
            return
        path = Path(task_workspace)
        if path.parent.name != ".bird_interact_agent_ws":
            return
        try:
            shutil.rmtree(path, ignore_errors=True)
        except Exception:
            logger.warning("failed to remove agent workspace %s", path, exc_info=True)

    def _visible_knowledge(self, db_name: str, item: dict[str, Any]) -> list[dict[str, Any]]:
        # Knowledge served to the a-mode KB tools, with entries hidden by
        # knowledge_ambiguity (deleted_knowledge) removed so the intended
        # ambiguity the agent must detect is preserved.
        kb_path = self._db_asset_path(db_name, f"{db_name}_kb.jsonl")
        if kb_path is None:
            return []
        deleted_ids = {
            ambiguity.get("deleted_knowledge")
            for ambiguity in item.get("knowledge_ambiguity", [])
            if ambiguity.get("deleted_knowledge") is not None
        }
        visible = []
        with kb_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("id") in deleted_ids:
                    continue
                visible.append(
                    {
                        key: entry[key]
                        for key in ("id", "knowledge", "description", "definition")
                        if key in entry
                    }
                )
        return visible

    def _column_meanings(self, db_name: str) -> dict[str, str]:
        # Public per-column descriptions served by the get_*_column_meaning tools.
        path = self._db_asset_path(db_name, f"{db_name}_column_meaning_base.json")
        if path is None:
            return {}
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            logger.warning("failed to load column meanings for %s", db_name, exc_info=True)
            return {}
        return {str(k): str(v) for k, v in data.items()}

    def _read_db_asset(self, db_name: str, filename: str) -> str | None:
        path = self._db_asset_path(db_name, filename)
        if path is None:
            return None
        return path.read_text(encoding="utf-8")

    def _db_asset_path(self, db_name: str, filename: str) -> Path | None:
        if self.data_dir is None:
            return None
        path = self.data_dir / db_name / filename
        return path if path.exists() else None

    def _initial_budget(self, item: dict[str, Any]) -> float:
        # Port of calculate_initial_budget (batch_run_bird_interact/main.py): the
        # agent gets one ask's worth of budget per critical / knowledge ambiguity,
        # on top of fixed env + submit budgets and the user-patience component.
        user_ambiguity = item.get("user_query_ambiguity") or {}
        critical = user_ambiguity.get("critical_ambiguity") or []
        knowledge = item.get("knowledge_ambiguity") or []
        amb_count = len(critical) + len(knowledge)
        return (
            _ENV_INTERACT_BUDGET
            + _SUBMIT_BUDGET
            + amb_count * BIRD_INTERACT_ACTION_COSTS["ask"]
            + _USER_PATIENCE_BUDGET
        )

    @staticmethod
    def _load_jsonl(path: Path) -> list[dict[str, Any]]:
        with path.open("r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
