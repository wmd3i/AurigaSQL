# llama.cpp Windows x64 Runtime

This directory contains the Windows x64 llama.cpp runtime bundled with the
AurigaSQL desktop app.

- Version: b9990 (`259ae1df8`)
- Architecture: x86_64
- Source archive: https://github.com/ggml-org/llama.cpp/releases/download/b9990/llama-b9990-bin-win-cpu-x64.zip
- Source archive SHA-256: `66b870d9698bade717b040d0699b5516e12d2346b3a9e39fedb6b101c12f776b`
- Verified: 2026-07-22
- License: MIT; see `LICENSE`

Expected packaged path:

```text
resources/llama.cpp/llama-server.exe
```

The Electron main process sets `AURIGASQL_LLAMA_SERVER_PATH` to that packaged
path when the app runs on Windows.
