#!/usr/bin/env python3
"""Start a command detached from the caller and redirect output to a log file."""

from __future__ import annotations

import os
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: start_detached.py LOG_PATH COMMAND [ARG ...]", file=sys.stderr)
        return 2

    log_path = sys.argv[1]
    command = sys.argv[2:]
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "ab", buffering=0) as log_file:
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
