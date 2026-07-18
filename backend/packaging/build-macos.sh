#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_PYTHON="$REPO_ROOT/backend/.venv-runtime/bin/python"
if [[ ! -x "$DEFAULT_PYTHON" ]]; then
  DEFAULT_PYTHON="python3"
fi
PYTHON_BIN="${PYTHON:-$DEFAULT_PYTHON}"
DIST_DIR="${AURIGASQL_BACKEND_DIST_DIR:-$REPO_ROOT/frontend/electron-backend}"

PYTHON_VERSION="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$PYTHON_VERSION" != 3.11* ]]; then
  echo "AurigaSQL desktop backend builds require Python 3.11; got $PYTHON_VERSION from $PYTHON_BIN" >&2
  exit 1
fi

cd "$REPO_ROOT"
export PYINSTALLER_CONFIG_DIR="$REPO_ROOT/build/pyinstaller-cache"
mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/aurigasql-bff"

"$PYTHON_BIN" -m PyInstaller \
  --clean \
  --noconfirm \
  --onefile \
  --name aurigasql-bff \
  --distpath "$DIST_DIR" \
  --workpath build/pyinstaller-aurigasql-bff \
  --specpath build/pyinstaller-aurigasql-bff \
  --paths backend \
  --paths src \
  --hidden-import api.app \
  --hidden-import runtime.runtime \
  --hidden-import data.bundled_demo \
  --hidden-import data.engines.sqlite \
  --hidden-import data.engines.duckdb \
  --hidden-import data.engines.postgres \
  --hidden-import data.engines.mysql \
  --hidden-import dbagent.agents.sql_agent \
  --hidden-import dbagent.agents.dbtools \
  --hidden-import dbagent.agents.interaction_tools \
  --hidden-import tiktoken_ext.openai_public \
  --collect-all litellm \
  --collect-all sqlglot \
  --collect-all tiktoken \
  --collect-all pydantic_settings \
  backend/packaging/aurigasql_bff.py
