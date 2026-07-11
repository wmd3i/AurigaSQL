from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class ConnectorConfig:
    provider: str
    model: str
    api_key_env: str
    base_url: str | None
    max_tokens: int = 32768
    max_retries: int = 5
    # Model driving the BIRD-Interact user simulator (the host-side responder for
    # the ``ask`` action). Defaults to ``model`` when unset.
    user_sim_model: str | None = None


@dataclass(slots=True)
class AgentConfig:
    yolo: bool = True
    max_steps: int | None = None


@dataclass(slots=True)
class RunnerConfig:
    output_root: Path
    run_name: str | None = None
    verbose: bool = False
    checkpoint_every: int = 10
    throttle_secs: float = 0.0
    # Opt-in LLM failure analysis: when True, failed cases are analyzed by codex
    # during the run. Default off so a plain run never spawns codex implicitly.
    failure_analysis: bool = False
    # Opt-in LLM success analysis: when True, PASSED cases are analyzed after the
    # run to mine harness-optimization levers. Writes success_analysis.json +
    # success_dump.json + success_summary.json. Default off.
    success_analysis: bool = False
    # Per-case upload: enabled by default. When True (and WebDAV env vars are
    # set), each finished case's dir is archived and uploaded to remote
    # storage. A no-op when WebDAV is not configured.
    upload_cases: bool = True
    # Cases run in parallel; 1 = sequential.
    concurrency: int = 1
    # Opt-in per-run exemplar memory: retrieve verified {question -> SQL} exemplars
    # from earlier passing cases and inject them into the prompt. Requires
    # concurrency == 1 (online accumulation needs sequential order). Default off.
    memory: bool = False
    embedding_model: str | None = None
    embedding_base_url: str | None = None
    # Retrieval knobs. tau default 0.60 is calibrated for Qwen3-Embedding-0.6B on
    # BIRD (a strong paraphrase scores ~0.61; unrelated ~0.37); the design's 0.75
    # was pre-calibration and fires almost never.
    memory_top_k: int = 3
    memory_tau: float = 0.60

@dataclass(slots=True)
class ExperimentConfig:
    split: str = "dev"
    limit: int | None = None
    # Optional explicit zero-based dataset indices, in execution order.
    indices: list[int] | None = None
    tags: dict[str, str] = field(default_factory=dict)
    # Optional free-form label appended to the run_id (e.g.
    # ``han_bird_2026-07-03-16-37-51_{tag}``) and recorded in run.json.
    tag: str | None = None
