from __future__ import annotations

import os

import uvicorn


def main() -> None:
    port = int(os.getenv("AURIGASQL_BFF_PORT", "6013"))
    uvicorn.run(
        "api.app:app",
        host="127.0.0.1",
        port=port,
        log_level=os.getenv("AURIGASQL_BFF_LOG_LEVEL", "warning"),
        access_log=False,
    )


if __name__ == "__main__":
    main()
