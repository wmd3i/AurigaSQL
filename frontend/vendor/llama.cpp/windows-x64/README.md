# llama.cpp Windows x64 Runtime

This directory contains the Windows x64 llama.cpp runtime bundled with the
AurigaSQL desktop app.

Expected packaged path:

```text
resources/llama.cpp/llama-server.exe
```

The Electron main process sets `AURIGASQL_LLAMA_SERVER_PATH` to that packaged
path when the app runs on Windows.
