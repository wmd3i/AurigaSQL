from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar


MAX_OUTPUT_CHARS = 100000
BASH_TIMEOUT_SECS = 120
AGENT_TIMEOUT_SECS = 1800
# Docker-CLI-compatible runtimes: docker, podman, nerdctl, finch, container (apple).
CONTAINER_CLI = os.getenv("CONTAINER_CLI", "docker")
CONTAINER_WORKSPACE = Path("/workspace")
logger = logging.getLogger(__name__)

@dataclass(slots=True)
class ContainerExecResult:
    returncode: int
    output: str


class ContainerService:
    """Run benchmark agent work inside an ephemeral container."""

    _active_lock: ClassVar[threading.Lock] = threading.Lock()
    _active_services: ClassVar[set["ContainerService"]] = set()

    @staticmethod
    def ensure_image(image: str, *, dockerfile_path: Path, build_context: Path) -> None:
        dockerfile_path = dockerfile_path.expanduser().resolve()
        build_context = build_context.expanduser().resolve()
        if not dockerfile_path.exists():
            raise FileNotFoundError(f"Dockerfile not found: {dockerfile_path}")
        if not build_context.exists():
            raise FileNotFoundError(f"Docker build context not found: {build_context}")

        inspect = subprocess.run(
            [CONTAINER_CLI, "image", "inspect", image],
            capture_output=True,
            text=True,
        )
        if inspect.returncode == 0:
            return

        build = subprocess.run(
            [
                CONTAINER_CLI,
                "build",
                "-f",
                str(dockerfile_path),
                "-t",
                image,
                str(build_context),
            ],
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            output = (build.stdout + build.stderr).strip()
            raise RuntimeError(f"Failed to build Docker image {image}: {output}")

    def __init__(self, *, image: str, case_id: str) -> None:
        # This only runs in the host process, not in the container.
        if shutil.which(CONTAINER_CLI) is None:
            raise RuntimeError(f"Container CLI not found: {CONTAINER_CLI}")
        self.image = image
        safe_case_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", case_id).strip("-") or "case"
        self.container_name = f"dbagent-{safe_case_id}-{uuid.uuid4().hex[:8]}"
        self.primary_host_path: Path | None = None
        self.extra_mount_paths: list[Path] = []
        self.started = False
        self._stop_lock = threading.Lock()
        with self._active_lock:
            self._active_services.add(self)

    def start(
        self,
        host_workspace: Path,
        *,
        extra_mounts: list[Path] | None = None,
        env: dict[str, str] | None = None,
        code_src: Path | None = None,
        code_dest: str = "/opt/dbagent/src",
    ) -> None:
        primary_path = host_workspace.expanduser().resolve()
        primary_path.mkdir(parents=True, exist_ok=True)
        extra_mount_paths: list[Path] = []
        for mount in extra_mounts or []:
            resolved = mount.expanduser().resolve()
            # extra_mounts may be a directory (e.g. the case dir) or a single
            # file (e.g. run.log). Only create directories; for a file, ensure
            # its parent exists and bind-mount the file itself so sibling files
            # under that parent are NOT exposed to the container.
            if resolved.is_file():
                resolved.parent.mkdir(parents=True, exist_ok=True)
            else:
                resolved.mkdir(parents=True, exist_ok=True)
            # Example:
            #   primary_path=/host/run/workspaces/case1
            #   extra_mounts=[/host/run/run.log, /host/run/cases/case1, /host/run/cases/case1, /host/run/workspaces/case1]
            # keeps only run.log and cases/case1 here: skip the primary mount and de-duplicate repeats.
            if resolved != primary_path and resolved not in extra_mount_paths:
                extra_mount_paths.append(resolved)

        command = [
            CONTAINER_CLI,
            "run",
            "--detach",
            "--rm",
            "--name",
            self.container_name,
            "--workdir",
            str(CONTAINER_WORKSPACE),
        ]
        # Run as the host user so files written into bind-mounted workspaces are
        # owned by the host user (not root).
        if hasattr(os, "getuid") and hasattr(os, "getgid"):
            command.extend(["--user", f"{os.getuid()}:{os.getgid()}"])
        # Linux has no built-in host.docker.internal; map it explicitly. Docker
        # Desktop usually injects it on macOS, but some setups (and 4.75 here)
        # don't, so add the host-gateway mapping there too. host-gateway is a
        # no-op alias when the name already resolves.
        if platform.system() in {"Linux", "Darwin"}:
            command.extend(["--add-host", "host.docker.internal:host-gateway"])
        for key, value in (env or {}).items():
            command.extend(["--env", f"{key}={value}"])
        # Mount the primary workspace into the container /workspace
        command.extend(["--volume", f"{primary_path}:{CONTAINER_WORKSPACE}"])
        for mount in extra_mount_paths:
            command.extend(["--volume", f"{mount}:{mount}"])
        command.extend([self.image, "sleep", "infinity"])

        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
        self.primary_host_path = primary_path
        self.extra_mount_paths = extra_mount_paths
        self.started = True

        # Copy the live dbagent source into the running container.
        # The image sets PYTHONPATH to code_dest.
        if code_src is not None:
            resolved_src = code_src.expanduser().resolve()
            if resolved_src.exists():
                subprocess.run(
                    [CONTAINER_CLI, "cp", f"{resolved_src}/.", f"{self.container_name}:{code_dest}"],
                    check=True,
                    capture_output=True,
                    text=True,
                )

    def stop(self) -> None:
        with self._stop_lock:
            if self.started:
                stopped = subprocess.run(
                    [CONTAINER_CLI, "stop", self.container_name],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                if stopped.returncode != 0:
                    subprocess.run(
                        [CONTAINER_CLI, "rm", "-f", self.container_name],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
            else:
                # A signal can arrive after ``docker run`` succeeds but before
                # start() records ``started = True``. Removing by the unique
                # container name closes that startup race; "not found" is safe.
                subprocess.run(
                    [CONTAINER_CLI, "rm", "-f", self.container_name],
                    check=False,
                    capture_output=True,
                    text=True,
                )
            self.started = False
            with self._active_lock:
                self._active_services.discard(self)

    @classmethod
    def stop_all(cls) -> None:
        """Best-effort cleanup of containers created by this Python process."""
        with cls._active_lock:
            services = list(cls._active_services)
        for service in services:
            try:
                service.stop()
            except Exception:
                logger.exception(
                    "docker_container_force_cleanup_failed container=%s",
                    service.container_name,
                )

    def exec(self, command: str, workdir: Path, *, timeout: int = AGENT_TIMEOUT_SECS) -> ContainerExecResult:
        if not self.started:
            return ContainerExecResult(returncode=1, output="Error: Docker container is not running")
        try:
            container_workdir = self.container_path_for(workdir)
            if container_workdir is None:
                return ContainerExecResult(
                    returncode=1,
                    output=f"Error: Docker workdir is outside mounted paths: {workdir}",
                )
        except Exception:
            return ContainerExecResult(returncode=1, output=f"Error: Docker workdir is invalid: {workdir}")

        try:
            result = subprocess.run(
                [
                    CONTAINER_CLI,
                    "exec",
                    "--workdir",
                    str(container_workdir),
                    self.container_name,
                    "/bin/sh",
                    "-lc",
                    command,
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return ContainerExecResult(returncode=1, output=f"Error: Timeout ({timeout}s)")

        output = (result.stdout + result.stderr).strip()
        return ContainerExecResult(
            returncode=result.returncode,
            output=(output[:MAX_OUTPUT_CHARS] if output else "(no output)"),
        )

    def run_bash(self, command: str, workdir: Path) -> str:
        result = self.exec(command, workdir, timeout=BASH_TIMEOUT_SECS)
        return result.output

    def container_path_for(self, path: Path) -> Path | None:
        if self.primary_host_path is None:
            return None

        raw_path = Path(path)
        if raw_path.is_absolute() and self._is_relative_to(raw_path, CONTAINER_WORKSPACE):
            # Example: /workspace or /workspace/cases/case1 already in the container workspace -> keep it unchanged.
            return raw_path

        resolved = raw_path.expanduser().resolve()
        if self._is_relative_to(resolved, self.primary_host_path):
            # Example: host /host/ws/cases/case1 -> container /workspace/cases/case1.
            return CONTAINER_WORKSPACE / resolved.relative_to(self.primary_host_path)

        for mount_path in self.extra_mount_paths:
            if self._is_relative_to(resolved, mount_path):
                # Example: host /host/run/case1/result.json stays the same because
                # extra mounts still use host-path == container-path.
                return resolved

        return None

    def host_path_for(self, path: Path) -> Path | None:
        if self.primary_host_path is None:
            return None

        raw_path = Path(path)
        if raw_path.is_absolute() and self._is_relative_to(raw_path, CONTAINER_WORKSPACE):
            # Example: container: /workspace/cases/case1/result.json -> host: /host/ws/cases/case1/result.json.
            return self.primary_host_path / raw_path.relative_to(CONTAINER_WORKSPACE)

        resolved = raw_path.expanduser().resolve()
        if self._is_relative_to(resolved, self.primary_host_path):
            # Example: /host/ws/cases/case1/result.json is already a host path, so keep it.
            return resolved
        for mount_path in self.extra_mount_paths:
            if self._is_relative_to(resolved, mount_path):
                # Example: /host/run/case1/run.log is an extra mount and stays unchanged.
                return resolved
        return None

    @staticmethod
    def _is_relative_to(path: Path, parent: Path) -> bool:
        try:
            path.relative_to(parent)
            return True
        except ValueError:
            return False
