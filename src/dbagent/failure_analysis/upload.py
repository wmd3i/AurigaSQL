"""Run/case upload helpers backed by generic WebDAV storage.

When uploads are enabled, the runner writes benchmark artifacts into a WebDAV
folder hierarchy:

```
{WEBDAV_BASE_PATH}/{run_id}/run.json
{WEBDAV_BASE_PATH}/{run_id}/run.log.tar.gz
{WEBDAV_BASE_PATH}/{run_id}/source_snapshot.tar.gz
{WEBDAV_BASE_PATH}/{run_id}/evaluation_summary.json
{WEBDAV_BASE_PATH}/{run_id}/cases/{case_id}.tar.gz
{WEBDAV_BASE_PATH}/{run_id}/failure-analysis/cases/{case_id}/failure_analysis.json
{WEBDAV_BASE_PATH}/{run_id}/failure-analysis/failure_summary.json
{WEBDAV_BASE_PATH}/{run_id}/success-analysis/cases/{case_id}/success_analysis.json
{WEBDAV_BASE_PATH}/{run_id}/success-analysis/dump.json
{WEBDAV_BASE_PATH}/{run_id}/success-analysis/success_summary.json
```

The run upload writes the already-materialized local ``run.json`` and
``source_snapshot.tar.gz`` files directly. It uploads ``run.log`` as a single-file
tar-gzip archive. Each case upload contains the full ``cases/<case_id>/``
directory tar-gzipped in-memory.

Best-effort by contract: every error is caught, logged, and swallowed.
Uploading must never bring down a benchmark run. Stdlib only (``urllib``,
``tarfile``); no new dependency.

Configuration (read from the environment / ``.env``):

- ``WEBDAV_URL``       — base WebDAV URL, e.g.
  ``https://app.koofr.net/dav/Koofr``.
- ``WEBDAV_USER``      — WebDAV username.
- ``WEBDAV_PASSWORD``  — WebDAV password.
- ``WEBDAV_BASE_PATH`` — optional remote root, default ``/dbagent``.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import posixpath
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

WEBDAV_URL_ENV = "WEBDAV_URL"
WEBDAV_USER_ENV = "WEBDAV_USER"
WEBDAV_PASSWORD_ENV = "WEBDAV_PASSWORD"
WEBDAV_BASE_PATH_ENV = "WEBDAV_BASE_PATH"

SERVER_URL_ENV = WEBDAV_URL_ENV
REQUIRED_ENV_VARS = (WEBDAV_URL_ENV, WEBDAV_USER_ENV, WEBDAV_PASSWORD_ENV)
_RETRYABLE_4XX = {408, 409, 423, 429}

_UPLOAD_TIMEOUT_SECONDS = 600.0
_UPLOAD_RETRIES = 5
_UPLOAD_RETRY_BACKOFF_SECONDS = 1.0


def _env(name: str) -> str | None:
    load_dotenv(override=True)
    value = (os.environ.get(name) or "").strip()
    return value or None


def webdav_url() -> str | None:
    value = _env(WEBDAV_URL_ENV)
    return value.rstrip("/") if value else None


def webdav_user() -> str | None:
    return _env(WEBDAV_USER_ENV)


def webdav_password() -> str | None:
    return _env(WEBDAV_PASSWORD_ENV)


def webdav_base_path() -> str:
    value = _env(WEBDAV_BASE_PATH_ENV) or "/dbagent"
    normalized = "/" + value.strip("/")
    return normalized if normalized != "/" else "/dbagent"


def run_root_remote_path(run_id: str) -> str:
    return posixpath.join(webdav_base_path().rstrip("/"), run_id)


def run_json_remote_path(run_id: str) -> str:
    return posixpath.join(run_root_remote_path(run_id), "run.json")


def run_log_remote_path(run_id: str) -> str:
    return posixpath.join(run_root_remote_path(run_id), "run.log.tar.gz")


def source_snapshot_remote_path(run_id: str) -> str:
    return posixpath.join(run_root_remote_path(run_id), "source_snapshot.tar.gz")


def evaluation_summary_remote_path(run_id: str) -> str:
    return posixpath.join(run_root_remote_path(run_id), "evaluation_summary.json")


def case_zip_remote_path(run_id: str, case_id: str) -> str:
    return posixpath.join(run_root_remote_path(run_id), "cases", f"{case_id}.tar.gz")


def analysis_root_remote_path(
    run_id: str,
    artifact_root_path: str | None = None,
) -> str:
    root = artifact_root_path or run_root_remote_path(run_id)
    return posixpath.join(root.rstrip("/"), "failure-analysis")


def analysis_case_remote_dir(
    run_id: str,
    case_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(analysis_root_remote_path(run_id, artifact_root_path), "cases", case_id)


def analysis_case_output_remote_path(
    run_id: str,
    case_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(analysis_case_remote_dir(run_id, case_id, artifact_root_path), "failure_analysis.json")


def analysis_summary_remote_path(
    run_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(analysis_root_remote_path(run_id, artifact_root_path), "failure_summary.json")


def success_analysis_root_remote_path(
    run_id: str,
    artifact_root_path: str | None = None,
) -> str:
    root = artifact_root_path or run_root_remote_path(run_id)
    return posixpath.join(root.rstrip("/"), "success-analysis")


def success_analysis_case_remote_dir(
    run_id: str,
    case_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(success_analysis_root_remote_path(run_id, artifact_root_path), "cases", case_id)


def success_analysis_case_output_remote_path(
    run_id: str,
    case_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(success_analysis_case_remote_dir(run_id, case_id, artifact_root_path), "success_analysis.json")


def success_analysis_summary_remote_path(
    run_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(success_analysis_root_remote_path(run_id, artifact_root_path), "success_summary.json")


def success_analysis_dump_remote_path(
    run_id: str,
    artifact_root_path: str | None = None,
) -> str:
    return posixpath.join(success_analysis_root_remote_path(run_id, artifact_root_path), "dump.json")


def is_enabled() -> bool:
    """True when WebDAV credentials are fully configured."""
    return all(_env(name) for name in REQUIRED_ENV_VARS)


def missing_env_vars() -> list[str]:
    return [name for name in REQUIRED_ENV_VARS if not _env(name)]


def _case_dir(case_result: dict[str, Any]) -> Path | None:
    """Locate the on-disk case directory from a case-result payload."""
    path = (case_result.get("artifacts") or {}).get("case_result_path")
    if not path:
        return None
    return Path(path).parent


def _tar_gz_dir(root_dir: Path) -> bytes:
    """Tar-gzip a directory into an in-memory archive (paths relative to it)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as archive:
        for path in sorted(root_dir.rglob("*")):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(root_dir).as_posix())
    return buf.getvalue()


def _tar_gz_file(path: Path, *, arcname: str) -> bytes:
    """Tar-gzip one file into an in-memory archive."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as archive:
        archive.add(path, arcname=arcname)
    return buf.getvalue()


def _read_file(path: Path) -> bytes:
    return path.read_bytes()


def _quote_path(path: str) -> str:
    return "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))


def _auth_header(user: str, password: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _request(
    *,
    url: str,
    method: str,
    auth_header: str,
    data: bytes | None = None,
    content_type: str | None = None,
) -> int:
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", auth_header)
    if content_type is not None:
        request.add_header("Content-Type", content_type)
    if data is not None:
        request.add_header("Content-Length", str(len(data)))
    with urllib.request.urlopen(request, timeout=_UPLOAD_TIMEOUT_SECONDS) as resp:
        return getattr(resp, "status", resp.getcode())


def _request_bytes(
    *,
    url: str,
    method: str,
    auth_header: str,
) -> bytes:
    request = urllib.request.Request(url, method=method)
    request.add_header("Authorization", auth_header)
    with urllib.request.urlopen(request, timeout=_UPLOAD_TIMEOUT_SECONDS) as resp:
        return resp.read()


def _with_retries(
    *,
    url: str,
    method: str,
    request_name: str,
    auth_header: str,
    data: bytes | None = None,
    content_type: str | None = None,
    success_log: str,
    ok_statuses: set[int] | None = None,
) -> bool:
    attempts = _UPLOAD_RETRIES + 1
    expected = ok_statuses or {200, 201, 204}
    for attempt in range(1, attempts + 1):
        try:
            status = _request(
                url=url,
                method=method,
                auth_header=auth_header,
                data=data,
                content_type=content_type,
            )
            if status not in expected:
                last = f"HTTP {status}"
            else:
                logger.info(success_log, url, status, 0 if data is None else len(data), attempt)
                return True
        except urllib.error.HTTPError as exc:
            if exc.code in expected:
                logger.info(success_log, url, exc.code, 0 if data is None else len(data), attempt)
                return True
            if exc.code < 500 and exc.code not in _RETRYABLE_4XX:
                logger.warning(
                    "%s_http_error url=%s method=%s status=%s reason=%s",
                    request_name,
                    url,
                    method,
                    exc.code,
                    exc.reason,
                )
                return False
            last = f"HTTP {exc.code} {exc.reason}"
        except Exception as exc:
            last = str(exc)

        if attempt < attempts:
            sleep_s = _UPLOAD_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
            logger.warning(
                "%s_retry url=%s method=%s attempt=%d/%d error=%s retry_in=%.1fs",
                request_name,
                url,
                method,
                attempt,
                attempts,
                last,
                sleep_s,
            )
            if sleep_s:
                time.sleep(sleep_s)
        else:
            logger.warning(
                "%s_failed url=%s method=%s attempts=%d error=%s",
                request_name,
                url,
                method,
                attempts,
                last,
            )
    return False


def _remote_url(base_url: str, path: str) -> str:
    clean_path = _quote_path(path.lstrip("/"))
    return f"{base_url}/{clean_path}" if clean_path else base_url


def _ensure_remote_dir(base_url: str, remote_dir: str, auth_header: str) -> bool:
    current = ""
    for part in [p for p in remote_dir.strip("/").split("/") if p]:
        current = posixpath.join(current, part)
        url = _remote_url(base_url, current)
        ok = _with_retries(
            url=url,
            method="MKCOL",
            request_name=f"webdav_mkdir path=/{current}",
            auth_header=auth_header,
            success_log="webdav_mkdir_done url=%s status=%s bytes=%d attempt=%d",
            ok_statuses={201, 405},
        )
        if not ok:
            return False
    return True


def _put_file(
    base_url: str,
    remote_path: str,
    payload: bytes,
    auth_header: str,
    *,
    content_type: str,
) -> bool:
    parent = posixpath.dirname(remote_path)
    if parent and not _ensure_remote_dir(base_url, parent, auth_header):
        return False
    return _with_retries(
        url=_remote_url(base_url, remote_path),
        method="PUT",
        request_name=f"webdav_put path=/{remote_path.strip('/')}",
        auth_header=auth_header,
        data=payload,
        content_type=content_type,
        success_log="webdav_put_done url=%s status=%s bytes=%d attempt=%d",
        ok_statuses={200, 201, 204},
    )


def download_file(
    remote_path: str,
    *,
    base_url: str | None = None,
) -> bytes | None:
    """Download one WebDAV object. Returns None on any failure."""
    base_url = base_url or webdav_url()
    user = webdav_user()
    password = webdav_password()
    if not (base_url and user and password):
        return None

    url = _remote_url(base_url, remote_path.lstrip("/"))
    auth_header = _auth_header(user, password)
    attempts = _UPLOAD_RETRIES + 1
    last = "unknown"
    for attempt in range(1, attempts + 1):
        try:
            payload = _request_bytes(url=url, method="GET", auth_header=auth_header)
            logger.info("webdav_get_done url=%s bytes=%d attempt=%d", url, len(payload), attempt)
            return payload
        except urllib.error.HTTPError as exc:
            if exc.code < 500 and exc.code not in _RETRYABLE_4XX:
                logger.warning("webdav_get_http_error url=%s status=%s reason=%s", url, exc.code, exc.reason)
                return None
            last = f"HTTP {exc.code} {exc.reason}"
        except Exception as exc:
            last = str(exc)

        if attempt < attempts:
            sleep_s = _UPLOAD_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
            logger.warning("webdav_get_retry url=%s attempt=%d/%d error=%s retry_in=%.1fs", url, attempt, attempts, last, sleep_s)
            time.sleep(sleep_s)
    logger.warning("webdav_get_failed url=%s attempts=%d error=%s", url, attempts, last)
    return None


def put_file(
    remote_path: str,
    payload: bytes,
    *,
    base_url: str | None = None,
    content_type: str = "application/octet-stream",
) -> bool:
    """Upload one WebDAV object, creating parent directories as needed."""
    base_url = base_url or webdav_url()
    user = webdav_user()
    password = webdav_password()
    if not (base_url and user and password):
        return False
    return _put_file(
        base_url,
        remote_path.lstrip("/"),
        payload,
        _auth_header(user, password),
        content_type=content_type,
    )


def remove_run(
    *,
    run_id: str,
    base_url: str | None = None,
) -> bool:
    """Delete a run's entire remote folder from WebDAV storage.

    A WebDAV ``DELETE`` on a collection removes it and all its members
    recursively. A ``404`` (already gone) is treated as success.
    """
    base_url = base_url or webdav_url()
    user = webdav_user()
    password = webdav_password()
    if not (base_url and user and password):
        return False
    remote_path = run_root_remote_path(run_id).lstrip("/")
    return _with_retries(
        url=_remote_url(base_url, remote_path),
        method="DELETE",
        request_name=f"webdav_delete path=/{remote_path}",
        auth_header=_auth_header(user, password),
        success_log="webdav_delete_done url=%s status=%s bytes=%d attempt=%d",
        ok_statuses={200, 202, 204, 404},
    )


def register_run(
    *,
    run_id: str,
    run_dir: str | Path,
    repo_root: str | Path | None = None,
    base_url: str | None = None,
) -> bool:
    """Upload run-level artifacts to WebDAV storage."""
    base_url = base_url or webdav_url()
    user = webdav_user()
    password = webdav_password()
    if not (base_url and user and password):
        return False

    run_dir_path = Path(run_dir)
    run_json_path = run_dir_path / "run.json"
    run_log_path = run_dir_path / "run.log"
    snapshot_path = run_dir_path / "source_snapshot.tar.gz"
    evaluation_summary_path = run_dir_path / "evaluation_summary.json"

    try:
        run_json_payload = _read_file(run_json_path)
        snapshot_payload = _read_file(snapshot_path)
    except Exception as exc:
        logger.warning("run_register_read_failed run_id=%s error=%s", run_id, exc)
        return False

    auth_header = _auth_header(user, password)
    run_json_ok = _put_file(
        base_url,
        run_json_remote_path(run_id).lstrip("/"),
        run_json_payload,
        auth_header,
        content_type="application/json",
    )

    run_log_ok = True
    if run_log_path.is_file():
        try:
            run_log_payload = _tar_gz_file(run_log_path, arcname="run.log")
        except Exception as exc:
            logger.warning("run_register_read_failed run_id=%s artifact=run.log error=%s", run_id, exc)
            run_log_ok = False
        else:
            run_log_ok = _put_file(
                base_url,
                run_log_remote_path(run_id).lstrip("/"),
                run_log_payload,
                auth_header,
                content_type="application/gzip",
            )

    snapshot_ok = _put_file(
        base_url,
        source_snapshot_remote_path(run_id).lstrip("/"),
        snapshot_payload,
        auth_header,
        content_type="application/gzip",
    )

    evaluation_summary_ok = True
    if evaluation_summary_path.is_file():
        try:
            evaluation_summary_payload = _read_file(evaluation_summary_path)
        except Exception as exc:
            logger.warning("run_register_read_failed run_id=%s artifact=evaluation_summary.json error=%s", run_id, exc)
            evaluation_summary_ok = False
        else:
            evaluation_summary_ok = _put_file(
                base_url,
                evaluation_summary_remote_path(run_id).lstrip("/"),
                evaluation_summary_payload,
                auth_header,
                content_type="application/json",
            )

    return run_json_ok and run_log_ok and snapshot_ok and evaluation_summary_ok


def upload_case(
    case_result: dict[str, Any],
    *,
    run_id: str | None = None,
    base_url: str | None = None,
) -> bool:
    """Tar-gzip one case dir and write it to WebDAV storage. Returns True on success."""
    base_url = base_url or webdav_url()
    user = webdav_user()
    password = webdav_password()
    if not (base_url and user and password):
        return False

    case_id = str(case_result.get("case_id", "?"))
    run_id = run_id or case_result.get("run_id")
    if not run_id:
        logger.warning("case_upload_skip case=%s reason=no_run_id", case_id)
        return False

    case_dir = _case_dir(case_result)
    if case_dir is None or not case_dir.exists():
        logger.warning("case_upload_skip case=%s reason=no_case_dir", case_id)
        return False

    try:
        payload = _tar_gz_dir(case_dir)
    except Exception as exc:
        logger.warning("case_upload_archive_failed case=%s error=%s", case_id, exc)
        return False

    remote_path = case_zip_remote_path(run_id, case_id).lstrip("/")
    return _put_file(
        base_url,
        remote_path,
        payload,
        _auth_header(user, password),
        content_type="application/gzip",
    )
