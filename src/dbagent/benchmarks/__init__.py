from pathlib import Path

from .base import BenchmarkAdapter, BenchmarkCase, EvaluationRecord, TaskSpec


def default_split(benchmark_id: str) -> str:
    return {
        "bird": "dev",
        "bird-interact-a": "full",
        "spider2-dbt": "test",
    }.get(benchmark_id) or _raise_unsupported_split(benchmark_id)


def _raise_unsupported_split(benchmark_id: str):
    raise ValueError(f"Unsupported benchmark split default for {benchmark_id!r}")


def build_benchmark(workdir: Path, benchmark_id: str, split: str) -> BenchmarkAdapter:
    workdir = workdir.expanduser().resolve()
    if benchmark_id == "bird":
        from .bird import BirdBenchmark

        return BirdBenchmark(workdir)
    if benchmark_id == "bird-interact-a":
        from .bird_interact_a import BirdInteractABenchmark

        return BirdInteractABenchmark(workdir, split=split)
    if benchmark_id == "spider2-dbt":
        from .spider2_dbt import Spider2DbtBenchmark

        return Spider2DbtBenchmark(workdir)
    raise ValueError(f"Benchmark {benchmark_id!r} not supported")

__all__ = [
    "BenchmarkAdapter",
    "BenchmarkCase",
    "EvaluationRecord",
    "TaskSpec",
    "build_benchmark",
    "default_split",
]
