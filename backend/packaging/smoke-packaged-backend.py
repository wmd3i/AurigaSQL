from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _json_get(base_url: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    with urllib.request.urlopen(f"{base_url}{path}", timeout=timeout) as response:
        body = response.read().decode("utf-8")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise RuntimeError(f"{path} returned non-object JSON")
    return payload


def _json_post(base_url: str, path: str, payload: dict[str, Any], timeout: float = 3.0) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    response_payload = json.loads(body)
    if not isinstance(response_payload, dict):
        raise RuntimeError(f"{path} returned non-object JSON")
    return response_payload


def _wait_for_health(base_url: str, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            payload = _json_get(base_url, "/health", timeout=1.5)
            if payload.get("status") == "ok":
                return
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(0.5)
    raise TimeoutError(f"backend did not become healthy at {base_url}: {last_error}")


def _assert_packaged_api(base_url: str) -> None:
    catalog = _json_get(base_url, "/data-sources/demo")
    sources = catalog.get("sources")
    if not isinstance(sources, list) or len(sources) != 12:
        raise AssertionError(f"expected 12 demo sources, got {len(sources) if isinstance(sources, list) else sources!r}")
    groups = {source.get("source_group") for source in sources if isinstance(source, dict)}
    if groups != {"bird", "bird_interact_a"}:
        raise AssertionError(f"unexpected demo source groups: {groups!r}")

    _json_post(base_url, "/demo-connections", {"source_group": "bird"})
    schema = _json_get(base_url, "/databases/Formula%201/schema")
    if schema.get("dialect") != "sqlite" or not str(schema.get("schema") or "").strip():
        raise AssertionError("Formula 1 schema was not available from the packaged backend")

    _json_post(base_url, "/demo-connections", {"source_group": "bird_interact_a"})
    connected = _json_get(base_url, "/data-sources")
    connected_sources = connected.get("sources")
    if not isinstance(connected_sources, list) or not connected_sources:
        raise AssertionError("connected demo sources were not available from the packaged backend")

    tasks = _json_get(base_url, "/tasks")
    if tasks.get("dataset") != "demo" or not tasks.get("tasks"):
        raise AssertionError("demo tasks were not available from the packaged backend")

    model_status = _json_get(base_url, "/local-model/status")
    if "downloaded" not in model_status or "running" not in model_status:
        raise AssertionError(f"unexpected local model status payload: {model_status!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test an AurigaSQL packaged BFF executable.")
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--resources-dir", required=True, type=Path)
    parser.add_argument("--datasets-dir", required=True, type=Path)
    parser.add_argument("--llama-server-path", type=Path)
    parser.add_argument("--port", type=int, default=6123)
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()

    executable = args.executable.resolve()
    resources_dir = args.resources_dir.resolve()
    datasets_dir = args.datasets_dir.resolve()
    if not executable.exists():
        raise FileNotFoundError(executable)
    if not resources_dir.exists():
        raise FileNotFoundError(resources_dir)
    if not datasets_dir.exists():
        raise FileNotFoundError(datasets_dir)

    with tempfile.TemporaryDirectory(prefix="aurigasql-packaged-smoke-", ignore_cleanup_errors=True) as user_data:
        env = {
            **os.environ,
            "AURIGASQL_DESKTOP": "1",
            "AURIGASQL_BFF_PORT": str(args.port),
            "AURIGASQL_RESOURCES_DIR": str(resources_dir),
            "AURIGASQL_DATASETS_DIR": str(datasets_dir),
            "AURIGASQL_USER_DATA_DIR": user_data,
            "PYTHONUNBUFFERED": "1",
        }
        if args.llama_server_path:
            env["AURIGASQL_LLAMA_SERVER_PATH"] = str(args.llama_server_path.resolve())

        proc = subprocess.Popen(
            [str(executable)],
            cwd=user_data,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        base_url = f"http://127.0.0.1:{args.port}"
        try:
            _wait_for_health(base_url, args.timeout)
            _assert_packaged_api(base_url)
        except Exception:
            if proc.poll() is not None and proc.stdout is not None:
                sys.stderr.write(proc.stdout.read())
            raise
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=8)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
