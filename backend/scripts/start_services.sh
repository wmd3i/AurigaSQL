#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
cd "$PROJECT_DIR"
export PYTHONPATH="$PROJECT_DIR:$REPO_DIR/src"
DATASET_NAME="${DATASET:-lite}"
export BIRD_INTERACT_DATA_DIR="${BIRD_INTERACT_DATA_DIR:-$REPO_DIR/datasets/bird-interact-$DATASET_NAME}"
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
export no_proxy="${no_proxy:-127.0.0.1,localhost}"
export LITELLM_LOCAL_MODEL_COST_MAP="${LITELLM_LOCAL_MODEL_COST_MAP:-True}"
export LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS="${LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS:-True}"
export SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/ssl/cert.pem}"
export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-/etc/ssl/cert.pem}"

PYTHON_BIN="python3"
if [ -x "$PROJECT_DIR/.venv-runtime/bin/python" ]; then
    PYTHON_BIN="$PROJECT_DIR/.venv-runtime/bin/python"
elif [ -x "$REPO_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$REPO_DIR/.venv/bin/python"
elif [ -x "$PROJECT_DIR/.venv-adk/bin/python" ]; then
    PYTHON_BIN="$PROJECT_DIR/.venv-adk/bin/python"
elif [ -n "${CONDA_PREFIX:-}" ] && [ -x "${CONDA_PREFIX}/bin/python" ]; then
    PYTHON_BIN="${CONDA_PREFIX}/bin/python"
elif [ -x "$PROJECT_DIR/.conda-py310/bin/python" ]; then
    PYTHON_BIN="$PROJECT_DIR/.conda-py310/bin/python"
fi

PYTHON_VERSION="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo "AurigaSQL backend requires Python 3.11+; got $PYTHON_VERSION from $PYTHON_BIN" >&2
    echo "Create a Python 3.11 environment and install backend/requirements.txt." >&2
    exit 1
fi

HOST="${SERVICE_HOST:-127.0.0.1}"
LOG_DIR="${PROJECT_DIR}/logs/services"
mkdir -p "$LOG_DIR"

# Ensure stale development servers do not keep the API port occupied.
pkill -9 -f 'uvicorn .*600[0-3]' 2>/dev/null || true
pkill -9 -f 'api.app:app' 2>/dev/null || true
sleep 1

: > "$LOG_DIR/api.log"

"$PYTHON_BIN" "$PROJECT_DIR/scripts/start_detached.py" "$LOG_DIR/api.log" \
    "$PYTHON_BIN" -m uvicorn api.app:app --host "$HOST" --port 6003 --log-level warning

for i in $(seq 1 120); do
    if curl --noproxy '*' -s "http://127.0.0.1:6003/health" > /dev/null 2>&1; then
        echo "BFF_READY (port 6003)"
        exit 0
    fi
    sleep 1
done

echo "SERVICES_FAILED"
for svc in api; do
    port=6003
    if curl --noproxy '*' -s "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
        echo "[$svc] healthy on :$port"
    else
        echo "[$svc] NOT healthy on :$port"
        echo "---- last 40 lines: $LOG_DIR/${svc}.log ----"
        tail -n 40 "$LOG_DIR/${svc}.log" 2>/dev/null || true
    fi
done
exit 1
