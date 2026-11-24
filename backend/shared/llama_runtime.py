"""Resolve the bundled llama.cpp runtime for supported desktop platforms."""

from __future__ import annotations

import platform
from pathlib import Path


SUPPORTED_LLAMA_PLATFORMS = "macOS ARM64, macOS x64, and Windows x64"


def platform_runtime_relative_path(
    system: str | None = None,
    machine: str | None = None,
) -> Path:
    """Return the repo-relative runtime executable for the requested platform."""

    system_name = (system or platform.system()).strip().lower()
    machine_name = (machine or platform.machine()).strip().lower()

    if system_name == "darwin":
        if machine_name in {"arm64", "aarch64"}:
            return Path("macos-arm64") / "llama-server"
        if machine_name in {"x86_64", "amd64"}:
            return Path("macos-x64") / "llama-server"
    elif system_name == "windows" and machine_name in {"x86_64", "amd64"}:
        return Path("windows-x64") / "llama-server.exe"

    raise RuntimeError(
        f"Unsupported llama.cpp platform: system={system or platform.system()!r}, "
        f"machine={machine or platform.machine()!r}. Supported platforms: "
        f"{SUPPORTED_LLAMA_PLATFORMS}."
    )
