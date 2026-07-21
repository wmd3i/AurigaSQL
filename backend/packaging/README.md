# Desktop packaging

The desktop app bundles a curated SQLite demo subset rather than the complete
BIRD and BIRD-Interact source datasets.

## Demo datasets

`datasets/demo/` is tracked in Git so a fresh checkout can build and run the
product without access to the original benchmark datasets. It contains:

- selected native BIRD SQLite databases;
- selected BIRD-Interact databases converted from PostgreSQL to SQLite;
- public BIRD-Interact column meanings and external knowledge;
- a safe example-question file without evaluation answers or test cases;
- a conversion report with table and row counts.

Regenerate it only when changing the curated demo subset. Start the
BIRD-Interact Lite PostgreSQL image, then run:

```bash
docker compose -f tools/demo-data/docker-compose.yml up -d postgresql
python tools/demo-data/build_demo_datasets.py
```

`frontend/package.json` packages `datasets/demo/`, the bundled backend, and the
platform-specific `llama.cpp` runtime files.

## Build the bundled backend and app

Use Python 3.11.x for PyInstaller builds. This is the currently validated
packaging version and should match the environment at `backend/.venv-runtime`.

```bash
python3.11 -m venv backend/.venv-runtime
source backend/.venv-runtime/bin/activate
python -m pip install -e .
python -m pip install -r backend/requirements.txt
python -m pip install -r backend/requirements-build.txt
cd frontend
npm run pack:desktop
```

`npm run pack:desktop` builds a fresh macOS ARM64 backend, renderer, and
unsigned unpacked app for local smoke testing. It does not perform Apple signing
or notarization.

Release builds remain separate:

```bash
npm run dist:desktop:mac-arm64
npm run dist:desktop:win-x64
```

Use the packaged backend smoke directly when debugging resource paths:

```bash
python backend/packaging/smoke-packaged-backend.py \
  --executable frontend/release/mac-arm64/AurigaSQL.app/Contents/Resources/backend/aurigasql-bff \
  --resources-dir frontend/release/mac-arm64/AurigaSQL.app/Contents/Resources \
  --datasets-dir frontend/release/mac-arm64/AurigaSQL.app/Contents/Resources/datasets \
  --llama-server-path frontend/release/mac-arm64/AurigaSQL.app/Contents/Resources/llama.cpp/llama-server
```
