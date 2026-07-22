This directory contains the macOS ARM64 llama.cpp runtime bundled with the
AurigaSQL desktop app.

- Version: b9990 (`259ae1df8`)
- Architecture: arm64
- Source archive: https://github.com/ggml-org/llama.cpp/releases/download/b9990/llama-b9990-bin-macos-arm64.tar.gz
- Source archive SHA-256: `924d9397144b66524983ecefc174d659c248f8c4297ee252ab40ccea625c4077`
- Executable SHA-256: `af7f9fbdfc9b2187188b646e8b51db121bb90e574c08e510ce4ad0b4ac21c648`
- Verified: 2026-07-22
- License: MIT; see `LICENSE`

Expected packaged path:

```text
resources/llama.cpp/llama-server
```

The backend starts this binary when the user chooses the local demo model.
