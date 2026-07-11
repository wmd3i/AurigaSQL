"""CLI viewer for a run's failure report.

    python -m dbagent.failure_analysis.serve --run runs/bird_2026-... [--port 8770]
    python -m dbagent.failure_analysis.serve --run runs/bird_2026-... --bake

Serves a live-refreshing page (no LLM, no codex — pure viewer). ``--bake`` just
writes the static ``failure_report.html`` and exits, identical to what the
runner produces at the end of a run.

The server is the Python standard-library ``http.server`` — no FastAPI/uvicorn,
so the viewer has zero third-party dependencies. It answers two GETs:
  - ``/``           -> the full page (with the JS poller)
  - ``/api/state``  -> just the ``#report`` fragment the poller swaps in
The page polls ``/api/state`` every few seconds and replaces the report body, so
serving over http keeps the refresh smooth (no full-page flicker).
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .render import build_html, render_body_html


def parse_args():
    p = argparse.ArgumentParser(prog="python -m dbagent.failure_analysis.serve")
    p.add_argument("--run", type=Path, required=True, help="path to a runs/<run_id> directory")
    p.add_argument("--port", type=int, default=8770)
    p.add_argument("--bake", action="store_true",
                   help="write <run>/failure_report.html and exit (no server)")
    return p.parse_args()


# Bound to loopback only, on purpose: this is an unauthenticated read-only
# viewer that renders local files — it must never be exposed on the network.
BIND = "127.0.0.1"


def make_server(run_dir: Path, port: int) -> ThreadingHTTPServer:
    """Build a stdlib http server that renders the report on each request.

    Rendering happens per-request (the run dir is re-read each time), so a page
    open during a live run picks up newly-written failure_analysis.json files on
    the next poll. ThreadingHTTPServer so a slow render can't block the poller.
    """

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (stdlib API name)
            if self.path == "/":
                body = build_html(run_dir, live=True)
            elif self.path.split("?", 1)[0] == "/api/state":
                # Just the #report fragment; the page's poller swaps it in.
                body = render_body_html(run_dir)
            else:
                self.send_error(404)
                return
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # silence per-request stderr logging
            pass

    return ThreadingHTTPServer((BIND, port), Handler)


def main():
    args = parse_args()
    run_dir = args.run
    if not run_dir.exists():
        raise SystemExit(f"run dir not found: {run_dir}")

    if args.bake:
        out = run_dir / "failure_report.html"
        out.write_text(build_html(run_dir, live=False), encoding="utf-8")
        print(f"wrote {out}")
        return

    server = make_server(run_dir, args.port)
    print(f"serving failure report for {run_dir} at http://{BIND}:{args.port}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
