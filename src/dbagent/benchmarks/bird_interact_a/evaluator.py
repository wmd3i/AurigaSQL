from __future__ import annotations

import json
import os
import platform
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Callable


# a-mode reward per phase on a passing submission (no debug-discount tier; see
# evaluate_interact_prediction). Phase 1 = 0.7, Phase 2 (follow-up) = 0.3.
PHASE_REWARD = {1: 0.7, 2: 0.3}


@dataclass(slots=True)
class PostgresConfig:
    host: str = "127.0.0.1"
    port: int = 5432
    user: str = "root"
    password: str = "123123"
    maintenance_db: str = "postgres"
    connect_timeout: int = 10
    agent_host: str | None = None

    @classmethod
    def from_env(cls) -> "PostgresConfig":
        host = os.getenv("BIRD_INTERACT_PG_HOST", "127.0.0.1")
        agent_host = os.getenv("BIRD_INTERACT_AGENT_PG_HOST")
        if agent_host is None and platform.system() in {"Darwin", "Linux"} and host in {"127.0.0.1", "localhost"}:
            agent_host = "host.docker.internal"
        return cls(
            host=host,
            port=int(os.getenv("BIRD_INTERACT_PG_PORT", "5432")),
            user=os.getenv("BIRD_INTERACT_PG_USER", "root"),
            password=os.getenv("BIRD_INTERACT_PG_PASSWORD", "123123"),
            maintenance_db=os.getenv("BIRD_INTERACT_PG_MAINTENANCE_DB", "postgres"),
            connect_timeout=int(os.getenv("BIRD_INTERACT_PG_CONNECT_TIMEOUT", "10")),
            agent_host=agent_host,
        )

    def dsn(self, db_name: str, *, for_agent: bool = False) -> str:
        host = self.agent_host if for_agent and self.agent_host else self.host
        return f"postgresql://{self.user}:{self.password}@{host}:{self.port}/{db_name}"


@dataclass(slots=True)
class QueryExecution:
    result: Any = None
    error: str | None = None
    timeout: bool = False
    columns: list[str] = field(default_factory=list)


@dataclass(slots=True)
class AttemptResult:
    phase: int
    # 1-based submission number within the phase; the highest value in a phase's
    # attempts is that phase's attempt count. a-mode does not branch reward on it.
    attempt: int
    sqls: list[str]
    passed: bool
    reward: float = 0.0
    status: str = "failed"
    error_message: str = ""
    error_type: str | None = None
    execution: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class InteractEvaluation:
    passed: bool
    total_reward: float
    phase1_passed: bool
    phase2_passed: bool
    has_follow_up: bool
    attempts: list[AttemptResult]
    error_type: str | None = None

    def to_details(self) -> dict[str, Any]:
        return {
            "total_reward": self.total_reward,
            "phase1_passed": self.phase1_passed,
            "phase2_passed": self.phase2_passed,
            "has_follow_up": self.has_follow_up,
            # How many submissions the agent made per phase (first try + retries).
            "phase1_attempts": sum(1 for a in self.attempts if a.phase == 1),
            "phase2_attempts": sum(1 for a in self.attempts if a.phase == 2),
            "attempts": [attempt.to_dict() for attempt in self.attempts],
        }


def _require_psycopg():
    try:
        import psycopg
        from psycopg import sql as pg_sql
    except Exception as exc:  # pragma: no cover - depends on optional runtime dep.
        raise RuntimeError("psycopg is required for BIRD-Interact evaluation") from exc
    return psycopg, pg_sql


def coerce_sql_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(coerce_sql_list(item))
        return result
    if not isinstance(value, str):
        return []

    text = _strip_code_fence(value.strip())
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        return coerce_sql_list(parsed)
    if isinstance(parsed, str):
        return coerce_sql_list(parsed)
    return [part.strip() for part in re.split(r"\[split\]\s*", text) if part.strip()]


def parse_prediction(text: str) -> dict[str, list[str]]:
    payload = _parse_prediction_json(text)
    if payload is not None:
        return {
            "phase1_sql": _first_present(payload, ("phase1_sql", "p1_sql", "sql", "pred_sqls")),
            "phase1_debug_sql": _first_present(payload, ("phase1_debug_sql", "p1_debug_sql", "debug_sql")),
            "phase2_sql": _first_present(payload, ("phase2_sql", "p2_sql", "follow_up_sql", "fu_sql")),
            "phase2_debug_sql": _first_present(payload, ("phase2_debug_sql", "p2_debug_sql", "follow_up_debug_sql", "fu_debug_sql")),
        }

    extracted = _extract_sql_from_text(text)
    return {
        "phase1_sql": coerce_sql_list(extracted),
        "phase1_debug_sql": [],
        "phase2_sql": [],
        "phase2_debug_sql": [],
    }


def evaluate_interact_prediction(
    record: dict[str, Any],
    prediction_text: str,
    *,
    pg_config: PostgresConfig | None = None,
) -> InteractEvaluation:
    pg_config = pg_config or PostgresConfig.from_env()
    prediction = parse_prediction(prediction_text)
    attempts: list[AttemptResult] = []
    total_reward = 0.0
    successful_phase1_sqls: list[str] = []

    # a-mode awards the full first-try reward on any passing submission and has
    # NO debug-discount tier: the original shared reward server applies
    # phase_rewards_debug (0.5/0.2) only when interact_mode == "c-interact"
    # (db_environment/server.py); a-mode always takes phase_rewards_first
    # (0.7/0.3). The agent may iterate within its action budget, but scoring does
    # not penalize a later-passing submission.
    phase1 = evaluate_phase_attempt(
        record,
        phase=1,
        attempt=1,
        pred_sqls=prediction["phase1_sql"],
        pg_config=pg_config,
    )
    attempts.append(phase1)
    phase1_passed = phase1.passed
    if phase1.passed:
        phase1.reward = PHASE_REWARD[1]
        total_reward += phase1.reward
        successful_phase1_sqls = phase1.sqls

    has_follow_up = bool(record.get("follow_up") and coerce_sql_list(record["follow_up"].get("sol_sql")))
    phase2_passed = False
    if phase1_passed and has_follow_up and prediction["phase2_sql"]:
        phase2 = evaluate_phase_attempt(
            record,
            phase=2,
            attempt=1,
            pred_sqls=prediction["phase2_sql"],
            pg_config=pg_config,
            phase1_state_sqls=successful_phase1_sqls,
        )
        attempts.append(phase2)
        phase2_passed = phase2.passed
        if phase2.passed:
            phase2.reward = PHASE_REWARD[2]
            total_reward += phase2.reward

    passed = phase1_passed and (phase2_passed if has_follow_up else True)
    return InteractEvaluation(
        passed=passed,
        total_reward=round(total_reward, 4),
        phase1_passed=phase1_passed,
        phase2_passed=phase2_passed,
        has_follow_up=has_follow_up,
        attempts=attempts,
        error_type=None if passed else _pick_error_type(attempts),
    )


def evaluate_phase_attempt(
    record: dict[str, Any],
    *,
    phase: int,
    attempt: int,
    pred_sqls: list[str],
    pg_config: PostgresConfig,
    phase1_state_sqls: list[str] | None = None,
) -> AttemptResult:
    if not pred_sqls:
        return AttemptResult(
            phase=phase,
            attempt=attempt,
            sqls=[],
            passed=False,
            error_message="missing prediction SQL",
            error_type="wrong_answer",
        )

    phase_record = record.get("follow_up", {}) if phase == 2 else record
    sol_sqls = coerce_sql_list(phase_record.get("sol_sql"))
    if not sol_sqls:
        return AttemptResult(
            phase=phase,
            attempt=attempt,
            sqls=pred_sqls,
            passed=False,
            error_message="missing gold SQL for phase",
            error_type="evaluation_error",
        )

    base_db = record["selected_database"]
    # Mirror the original BIRD-Interact task_db lifecycle: evaluate against the
    # per-task working DB (created from the base template), resetting it from
    # "{base_db}_template" before each attempt. Falls back to the base db name
    # when no working_db was provisioned.
    db_name = record.get("working_db") or base_db
    template_db = f"{base_db}_template"
    preprocess_sqls = coerce_sql_list(record.get("preprocess_sql"))
    cleanup_sqls = coerce_sql_list(record.get("clean_up_sqls"))
    test_cases = _coerce_test_cases(phase_record.get("test_cases"))
    conditions = phase_record.get("conditions") or {}
    category = phase_record.get("category") or record.get("category") or "Query"

    try:
        reset_database(db_name, pg_config, template_db=template_db)
        conn = connect_database(db_name, pg_config)
    except Exception as exc:
        return AttemptResult(
            phase=phase,
            attempt=attempt,
            sqls=pred_sqls,
            passed=False,
            error_message=f"database setup error: {exc}",
            error_type="evaluation_error",
        )

    pred_execution = QueryExecution()
    try:
        setup_execution = execute_queries(preprocess_sqls, db_name, conn=conn)
        if setup_execution.error or setup_execution.timeout:
            return _failed_attempt(
                phase,
                attempt,
                pred_sqls,
                "preprocess SQL failed",
                setup_execution,
                "evaluation_error",
            )

        if phase == 2 and phase1_state_sqls:
            state_execution = execute_queries(phase1_state_sqls, db_name, conn=conn)
            if state_execution.error or state_execution.timeout:
                return _failed_attempt(
                    phase,
                    attempt,
                    pred_sqls,
                    "phase 1 state SQL failed",
                    state_execution,
                    "evaluation_error",
                )

        pred_execution = execute_queries(pred_sqls, db_name, conn=conn)
        if pred_execution.error:
            return _failed_attempt(
                phase,
                attempt,
                pred_sqls,
                f"[exec_err_flg] {pred_execution.error}",
                pred_execution,
                "execution_error",
            )
        if pred_execution.timeout:
            return _failed_attempt(
                phase,
                attempt,
                pred_sqls,
                "[exec_err_flg] submitted SQL execution timed out",
                pred_execution,
                "execution_error",
            )

        if category == "Query" or not test_cases:
            test_case_default(pred_sqls, sol_sqls, db_name, conn, conditions)
        else:
            _run_custom_test_cases(
                test_cases,
                pred_sqls,
                sol_sqls,
                db_name,
                conn,
                pred_execution.result,
            )
    except AssertionError as exc:
        return _failed_attempt(phase, attempt, pred_sqls, str(exc) or "wrong answer", pred_execution, "wrong_answer")
    except Exception as exc:
        return _failed_attempt(phase, attempt, pred_sqls, str(exc) or "wrong answer", pred_execution, "wrong_answer")
    finally:
        try:
            execute_queries(cleanup_sqls, db_name, conn=conn)
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass

    return AttemptResult(
        phase=phase,
        attempt=attempt,
        sqls=pred_sqls,
        passed=True,
        status="success",
        execution=_execution_dict(pred_execution),
    )


def connect_database(db_name: str, config: PostgresConfig):
    psycopg, _ = _require_psycopg()
    return psycopg.connect(
        dbname=db_name,
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        connect_timeout=config.connect_timeout,
    )


# Postgres rejects concurrent CREATE DATABASE from the same template; serialize per template.
_template_clone_locks: dict[str, threading.Lock] = {}
_template_clone_guard = threading.Lock()


def _template_clone_lock(template: str) -> threading.Lock:
    with _template_clone_guard:
        return _template_clone_locks.setdefault(template, threading.Lock())


def reset_database(db_name: str, config: PostgresConfig, template_db: str | None = None) -> None:
    _, pg_sql = _require_psycopg()
    template = template_db or f"{db_name}_template"
    with connect_database(config.maintenance_db, config) as conn:
        conn.autocommit = True
        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            (db_name,),
        )
        conn.execute(pg_sql.SQL("DROP DATABASE IF EXISTS {}").format(pg_sql.Identifier(db_name)))
        with _template_clone_lock(template):
            conn.execute(
                pg_sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(
                    pg_sql.Identifier(db_name),
                    pg_sql.Identifier(template),
                )
            )


def drop_database(db_name: str, config: PostgresConfig) -> None:
    """Terminate connections and drop a (per-task) database. Best-effort."""
    _, pg_sql = _require_psycopg()
    with connect_database(config.maintenance_db, config) as conn:
        conn.autocommit = True
        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            (db_name,),
        )
        conn.execute(pg_sql.SQL("DROP DATABASE IF EXISTS {}").format(pg_sql.Identifier(db_name)))


def execute_queries(queries: list[str] | str, db_name: str, conn=None) -> QueryExecution:
    if isinstance(queries, str):
        queries = coerce_sql_list(queries)
    if not queries:
        return QueryExecution()
    own_conn = conn is None
    if own_conn:
        conn = connect_database(db_name, PostgresConfig.from_env())

    result: Any = None
    columns: list[str] = []
    try:
        for query in queries:
            if not query.strip():
                continue
            with conn.cursor() as cursor:
                cursor.execute("SET statement_timeout = '60s'")
                cursor.execute(query)
                conn.commit()
                if cursor.description:
                    rows = cursor.fetchmany(10001)
                    result = rows[:10000]
                    columns = [desc.name for desc in cursor.description]
                else:
                    result = None
                    columns = []
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        if _is_timeout_error(exc):
            return QueryExecution(result=None, timeout=True)
        return QueryExecution(result=None, error=str(exc) or repr(exc))
    finally:
        if own_conn:
            try:
                conn.close()
            except Exception:
                pass
    return QueryExecution(result=result, columns=columns)


def test_case_default(
    pred_sqls: list[str],
    sol_sqls: list[str],
    db_name: str,
    conn,
    conditions: dict[str, Any] | None = None,
) -> int:
    pred_sqls = remove_round(remove_distinct(remove_comments(pred_sqls)))
    sol_sqls = remove_round(remove_distinct(remove_comments(sol_sqls)))
    result = ex_base(pred_sqls, sol_sqls, db_name, conn, conditions)
    assert result == 1, f"ex_base returned {result} but expected 1."
    return result


def ex_base(
    pred_sqls: list[str],
    sol_sqls: list[str],
    db_name: str,
    conn,
    conditions: dict[str, Any] | None = None,
) -> int:
    if not pred_sqls or not sol_sqls:
        return 0
    pred_execution = execute_queries(pred_sqls, db_name, conn=conn)
    gold_execution = execute_queries(sol_sqls, db_name, conn=conn)
    if pred_execution.error or pred_execution.timeout or gold_execution.error or gold_execution.timeout:
        return 0

    predicted = preprocess_results(pred_execution.result)
    gold = preprocess_results(gold_execution.result)
    if not predicted or not gold:
        return 0
    if conditions and conditions.get("order", False):
        return 1 if predicted == gold else 0
    return 1 if set(predicted) == set(gold) else 0


def preprocess_results(results: Any, decimal_places: int = 2) -> list[tuple[Any, ...]]:
    if results is None:
        return []
    processed = []
    for row in results:
        processed_row = []
        for item in row:
            if isinstance(item, (date, datetime)):
                processed_row.append(item.strftime("%Y-%m-%d"))
            else:
                processed_item = _process_decimals_recursive(item, decimal_places)
                if isinstance(processed_item, (dict, list)):
                    processed_row.append(json.dumps(processed_item, sort_keys=True))
                else:
                    processed_row.append(processed_item)
        processed.append(tuple(processed_row))
    return processed


def remove_comments(sql_list: list[str]) -> list[str]:
    cleaned = []
    for sql in sql_list:
        no_block = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
        no_line = re.sub(r"--.*?(\r\n|\r|\n)", r"\1", no_block)
        no_blank = re.sub(r"\n\s*\n+", "\n", no_line)
        cleaned.append(no_blank.strip())
    return cleaned


def remove_distinct(sql_list: list[str]) -> list[str]:
    return [" ".join(token for token in sql.split(" ") if token.lower() != "distinct") for sql in sql_list]


def remove_round(sql_list: list[str]) -> list[str]:
    return [_remove_round_functions(sql) for sql in sql_list]


def _run_custom_test_cases(
    test_cases: list[str],
    pred_sqls: list[str],
    sol_sqls: list[str],
    db_name: str,
    conn,
    pred_query_result: Any,
) -> None:
    def execute_queries_compat(queries, db_name_arg, conn_arg=None):
        execution = execute_queries(coerce_sql_list(queries), db_name_arg, conn=conn_arg)
        return execution.result, bool(execution.error), execution.timeout

    globals_for_exec: dict[str, Any] = {
        "execute_queries": execute_queries_compat,
        "ex_base": ex_base,
        "remove_distinct": remove_distinct,
        "remove_comments": remove_comments,
        "remove_round": remove_round,
        "pred_query_result": pred_query_result,
    }
    funcs: list[Callable[..., Any]] = []
    for code in test_cases:
        local_ns: dict[str, Any] = {}
        exec(code, globals_for_exec, local_ns)
        if callable(local_ns.get("test_case")):
            funcs.append(local_ns["test_case"])
        else:
            funcs.extend(value for value in local_ns.values() if callable(value))

    if not funcs:
        raise AssertionError("no callable test case found")
    for func in funcs:
        func(pred_sqls, sol_sqls, db_name, conn)


def _first_present(payload: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
    for key in keys:
        if key in payload:
            return coerce_sql_list(payload[key])
    return []


def _parse_prediction_json(text: str) -> dict[str, Any] | None:
    candidates = [text.strip()]
    candidates.extend(match.group(1).strip() for match in re.finditer(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE))
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _extract_sql_from_text(text: str) -> str:
    tag_match = re.search(r"<t>\s*(.*?)\s*</t>", text, re.DOTALL | re.IGNORECASE)
    if tag_match:
        text = tag_match.group(1)
    matches = list(re.finditer(r"```(?:sql|postgresql)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE))
    if matches:
        return matches[-1].group(1).strip()
    return text.strip()


def _strip_code_fence(text: str) -> str:
    match = re.fullmatch(r"```(?:sql|postgresql|json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else text


def _coerce_test_cases(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item.strip()]
    return [value] if isinstance(value, str) and value.strip() else []


def _failed_attempt(
    phase: int,
    attempt: int,
    sqls: list[str],
    message: str,
    execution: QueryExecution,
    error_type: str,
) -> AttemptResult:
    return AttemptResult(
        phase=phase,
        attempt=attempt,
        sqls=sqls,
        passed=False,
        error_message=message,
        error_type=error_type,
        execution=_execution_dict(execution),
    )


def _execution_dict(execution: QueryExecution) -> dict[str, Any]:
    return {
        "error": execution.error,
        "timeout": execution.timeout,
        "columns": execution.columns,
        "result_preview": execution.result[:20] if isinstance(execution.result, list) else execution.result,
    }


def _pick_error_type(attempts: list[AttemptResult]) -> str:
    for candidate in ("evaluation_error", "execution_error", "wrong_answer"):
        if any(attempt.error_type == candidate for attempt in attempts):
            return candidate
    return "wrong_answer"


def _is_timeout_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "statement timeout" in text or "canceling statement due to statement timeout" in text


def _process_decimals_recursive(item: Any, decimal_places: int) -> Any:
    quantizer = Decimal(1).scaleb(-decimal_places)
    if isinstance(item, Decimal):
        return item.quantize(quantizer, rounding=ROUND_HALF_UP)
    if isinstance(item, float):
        return round(item, decimal_places)
    if isinstance(item, (list, tuple)):
        return type(item)(_process_decimals_recursive(value, decimal_places) for value in item)
    if isinstance(item, dict):
        return {key: _process_decimals_recursive(value, decimal_places) for key, value in item.items()}
    return item


def _remove_round_functions(sql_string: str) -> str:
    def find_matching_paren(text: str, start: int) -> int:
        depth = 0
        for index in range(start, len(text)):
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                depth -= 1
                if depth == 0:
                    return index
        return -1

    def find_first_arg_end(text: str, start: int) -> int:
        depth = 0
        for index in range(start, len(text)):
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                if depth == 0:
                    return index
                depth -= 1
            elif text[index] == "," and depth == 0:
                return index
        return len(text)

    result = sql_string
    while True:
        match = re.search(r"ROUND\s*\(", result, re.IGNORECASE)
        if not match:
            break
        start = match.start()
        open_paren = match.end() - 1
        first_arg_end = find_first_arg_end(result, open_paren + 1)
        close_paren = find_matching_paren(result, open_paren)
        if close_paren == -1:
            break
        first_arg = result[open_paren + 1:first_arg_end].strip()
        result = result[:start] + first_arg + result[close_paren + 1:]
    return result
