# llama.cpp macOS x64 Runtime

This directory contains the macOS Intel runtime bundled with AurigaSQL.

- Version: b9990 (`259ae1df8`)
- Architecture: x86_64
- Source archive: https://github.com/ggml-org/llama.cpp/releases/download/b9990/llama-b9990-bin-macos-x64.tar.gz
- Source archive SHA-256: `3e5cb5767c84a49cfa53f762334ea7ae4302856d06d2ad6edb8f4d855803be64`
- Verified: 2026-07-22
- License: MIT; see `LICENSE`

Expected packaged path:

```text
resources/llama.cpp/llama-server
```

Only `llama-server` and its required dynamic libraries are bundled into the
AurigaSQL app.
