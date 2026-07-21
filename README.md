# AurigaSQL

AurigaSQL is a SQL agent for exploring databases with natural
language. It combines a React chat and canvas interface, a FastAPI backend, and
a reusable Python SQL agent that inspects schemas, runs read-only queries, and
returns the final SQL together with its result.

The repository includes curated demo databases, so a fresh checkout can be run
without downloading benchmark datasets or configuring a database server.

## Features

- Chat and canvas workflows for database questions and follow-up analysis
- Schema inspection, query validation, SQL execution, and result previews
- Built-in SQLite demo databases derived from BIRD and BIRD-Interact
- User connections for SQLite, DuckDB, PostgreSQL, and MySQL
- Model profiles for OpenAI, Gemini, Z.AI, Anthropic, MiniMax, xAI, Ollama, and
  other OpenAI-compatible endpoints
- Web development mode and an Electron desktop application
- Optional local GGUF model support through the bundled `llama.cpp` runtime

## Architecture

The browser and Electron renderer communicate only with the FastAPI BFF. The
BFF owns application state, database sessions, model profiles, and the SQL agent
runtime.

```text
React / Electron frontend
          |
          | HTTP + SSE
          v
FastAPI BFF (backend/api)
          |
          +-- session orchestration (backend/runtime)
          +-- database connections and engines (backend/data)
          +-- model configuration (backend/shared)
          |
          v
SQL agent and tools (src/dbagent)
```

Repository layout:

```text
frontend/          React, Vite, and Electron application
backend/api/       HTTP and SSE API
backend/runtime/   Agent sessions, event streaming, and conversation state
backend/data/      Demo catalog, saved connections, and database engines
backend/shared/    Configuration, model profiles, and LiteLLM integration
backend/packaging/ PyInstaller and desktop packaging scripts
src/dbagent/       Reusable SQL agent, connectors, and database tools
datasets/demo/     Curated databases and public knowledge bundled with the app
tools/demo-data/   Demo dataset regeneration utility
```

Product-specific behavior belongs under `backend/`; `src/dbagent/` should stay
usable as the lower-level agent package.

## Requirements

- Python 3.11.x
- Node.js `^20.19.0` or `>=22.12.0`
- npm

Python 3.11.x is the currently validated version for both backend development
and Desktop packaging. Using the same minor version keeps the local runtime and
the PyInstaller build environment consistent.

PostgreSQL, MySQL, Ollama, and local GGUF models are optional. They are needed
only when you choose those connection or model types.

## Quick Start

### 1. Install the backend

From the repository root, create the runtime environment expected by the start
script. Confirm that `python3.11 --version` reports Python 3.11.x first:

```bash
python3.11 -m venv backend/.venv-runtime
source backend/.venv-runtime/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
python -m pip install -r backend/requirements.txt
```

Optional development overrides are documented in `.env.example`. You do not
need to create a `.env` file for the bundled demo.

### 2. Install the frontend

```bash
cd frontend
npm ci
cd ..
```

### 3. Start AurigaSQL

Start the BFF from the repository root:

```bash
bash backend/scripts/start_services.sh
```

Then start Vite in a second terminal:

```bash
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173`. The BFF listens on
`http://127.0.0.1:6003`.

The backend log is written to `backend/logs/services/api.log`.

## Configure a Model

Open **Settings** in AurigaSQL, add a model profile, test the connection, and set
it as the default. Cloud providers require an API key. Ollama and other local
OpenAI-compatible services can use a base URL without a key when the service
allows it.

Model profiles and saved database connections are stored in AurigaSQL's local
user-data directory, outside the Git repository. API keys are masked in API
responses, but the local profile file is not an operating-system keychain; keep
your user account and data directory private.

For environment-based development overrides, copy only the settings you need
from `.env.example` into a local `.env`. Never commit real credentials.

## Connect Data

Use **Connect data** in the application to add:

- a local SQLite database (`.sqlite`, `.sqlite3`, or `.db`)
- a local DuckDB database (`.duckdb`)
- a PostgreSQL server
- a MySQL server

AurigaSQL validates a connection before saving it. Agent database tools are
designed for schema exploration and read-only query execution; still use a
least-privilege database account for network databases.

The bundled demo catalog is defined by `datasets/demo/manifest.json`. Its source
and license notices are in `datasets/demo/README.md`.

## Development Commands

Backend health check:

```bash
curl http://127.0.0.1:6003/health
```

Frontend checks:

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

Run the Electron shell against the development frontend:

```bash
cd frontend
npm run dev:desktop
```

The development shell uses the AurigaSQL product name and icon. It still runs
from Electron's development executable; distributable application metadata is
applied by the packaging commands below.

Set `VITE_BFF_BASE_URL` in `frontend/.env.local` only when the BFF is not running
at `http://127.0.0.1:6003`.

## Desktop Packaging

Desktop packaging uses the same Python 3.11.x virtual environment created in
Quick Start. Activate it and install the packaging dependencies first:

```bash
source backend/.venv-runtime/bin/activate
python -m pip install -r backend/requirements-build.txt
```

Build an unsigned, unpacked macOS ARM64 app for local functional testing:

```bash
cd frontend
npm run pack:desktop:mac-arm64
```

Build distributable artifacts:

```bash
npm run dist:desktop:mac-arm64
npm run dist:desktop:win-x64
```

Artifacts are written under `frontend/release/`. macOS ARM64 packaging has been
functionally validated. The Windows x64 build path is present but remains
experimental and should be validated on a Windows machine before release.

The public project does not ship Apple signing or notarization credentials.
Unsigned macOS builds may require users to approve the app in macOS privacy and
security settings.

## Local GGUF Models

The desktop package includes platform-specific `llama.cpp` runtime files. In
AurigaSQL Settings, the local demo model flow can download a supported GGUF model
into the local user-data directory and start `llama-server` on demand.

For development, runtime locations and the local model port can be overridden
with the `AURIGASQL_LLAMA_SERVER_PATH` and
`AURIGASQL_LOCAL_MODEL_PORT` variables shown in `.env.example`.

## License

AurigaSQL is licensed under the [MIT License](LICENSE).

Bundled datasets and third-party components may be subject to their own
licenses and attribution requirements.
