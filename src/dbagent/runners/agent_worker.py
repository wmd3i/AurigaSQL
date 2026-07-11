from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path

from dbagent.agents.dbtools import DBType, POSTGRES_DSN_ENV
from dbagent.agents.sql_agent import SQLAgent
from dbagent.config import AgentConfig, ConnectorConfig
from dbagent.connectors.litellm_connector import LiteLLMConnector


def _attach_run_log_handler(run_log_path: Path) -> None:
    """Append in-container dbagent logs to the host run.log on the fly.

    The run.log handler lives in the host process; this worker runs in a
    separate process inside the container, so without this its logs (LLM
    prompts/responses, tool calls, retries) would be lost. run.log is bind-
    mounted into the container, so an append-mode handler here streams the
    worker's logs straight into the single host run.log as they happen. Cases
    run sequentially and the host is blocked during docker exec, and O_APPEND
    makes the cross-process appends safe. UTC timestamps match the host format.
    """
    run_log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(run_log_path, encoding="utf-8")
    handler.setLevel(logging.DEBUG)
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S+0000",
    )
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    package_logger = logging.getLogger("dbagent")
    package_logger.addHandler(handler)
    package_logger.setLevel(min(package_logger.level or logging.DEBUG, logging.DEBUG))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one dbAgent task inside a Docker container")
    parser.add_argument("--input", required=True, help="JSON file containing task and config payload.")
    parser.add_argument("--output", required=True, help="Path to write AgentRunOutput JSON.")
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    task = payload["task"]
    connector_config = ConnectorConfig(**payload["connector_config"])
    agent_config = AgentConfig(**payload["agent_config"])
    log_dir = Path(payload["log_dir"])
    task_workspace = Path(payload["task_workspace"]) if payload.get("task_workspace") else None
    db_path = task.get("db_path")

    if task.get("db_type") == DBType.POSTGRES.value and db_path:
        os.environ[POSTGRES_DSN_ENV] = db_path
    # Router-backed model configs may include host-local LLM endpoints (for
    # example Ollama on localhost). Mark this process as containerized so the
    # connector can rewrite those bases to host.docker.internal.
    os.environ["DBAGENT_RUNTIME_CONTEXT"] = "container"

    if payload.get("run_log_path"):
        _attach_run_log_handler(Path(payload["run_log_path"]))

    connector = LiteLLMConnector(connector_config)
    agent = SQLAgent(connector, agent_config, workdir=Path(payload["workdir"]))
    output = agent.run(
        prompt=task["prompt"],
        db_type=DBType(task["db_type"]),
        db_path=db_path,
        user_question=task.get("user_question") or "",
        log_dir=log_dir,
        case_id=task["case_id"],
        task_workspace=task_workspace,
        # Benchmark-specific extras (e.g. BIRD-Interact's knowledge/column data
        # and action budget) are forwarded opaquely by the runner under
        # agent_kwargs; unpack them into the agent's named keyword args here.
        **task.get("agent_kwargs", {}),
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output.to_dict(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
