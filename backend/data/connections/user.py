from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Literal, Optional

from pydantic import BaseModel, Field, ValidationError

from data.models import DataSource
from shared.config import CONFIG_DIR
from data.connections.validation import (
    ConnectionEngine,
    PostgresSslMode,
    build_mysql_dsn,
    build_postgres_dsn,
    mask_mysql_location,
    mask_postgres_location,
    normalize_local_path,
    validate_local_database,
    validate_mysql_connection,
    validate_postgres_connection,
)

logger = logging.getLogger(__name__)

CONNECTIONS_PATH = CONFIG_DIR / "user_connections.json"
LOCK_PATH = CONFIG_DIR / "user_connections.lock"

ConnectionMode = Literal["local_path", "network"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class StoredConnection(BaseModel):
    id: str
    name: str
    engine: ConnectionEngine
    mode: ConnectionMode = "local_path"
    path: str = ""
    host: str = ""
    port: int = 5432
    database: str = ""
    username: str = ""
    password: str = ""
    sslmode: PostgresSslMode = "prefer"
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class ConnectionFile(BaseModel):
    version: int = 1
    connections: list[StoredConnection] = Field(default_factory=list)


def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def _locked_file() -> Iterator[None]:
    ensure_config_dir()
    with open(LOCK_PATH, "a+", encoding="utf-8") as lock_file:
        try:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass


def _atomic_write_text(path: Path, text: str) -> None:
    ensure_config_dir()
    fd, tmp_path = tempfile.mkstemp(prefix=f"{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(text)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


def load_connection_file() -> ConnectionFile:
    ensure_config_dir()
    if not CONNECTIONS_PATH.exists():
        return ConnectionFile()
    try:
        payload = json.loads(CONNECTIONS_PATH.read_text(encoding="utf-8"))
        return ConnectionFile.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        logger.warning("Invalid user_connections.json, falling back to empty config: %s", exc)
        return ConnectionFile()


def save_connection_file(data: ConnectionFile) -> None:
    with _locked_file():
        _atomic_write_text(CONNECTIONS_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")


def _normalize_id(name: str, engine: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", f"{engine}-{name}".strip().lower()).strip("-")
    return base or f"{engine}-connection"


def list_connections() -> list[StoredConnection]:
    return load_connection_file().connections


def get_connection(connection_id: str) -> Optional[StoredConnection]:
    for connection in list_connections():
        if connection.id == connection_id:
            return connection
    return None


def create_connection(
    *,
    name: str,
    engine: ConnectionEngine,
    path: str = "",
    host: str = "",
    port: int = 5432,
    database: str = "",
    username: str = "",
    password: str = "",
    sslmode: PostgresSslMode = "prefer",
) -> StoredConnection:
    label = name.strip()
    if not label:
        raise ValueError("name is required")
    normalized_path: Path | None = None
    if engine == "postgres":
        ok, message = validate_postgres_connection(
            host=host,
            port=port,
            database=database,
            username=username,
            password=password,
            sslmode=sslmode,
        )
        if not ok:
            raise ValueError(message)
    elif engine == "mysql":
        ok, message = validate_mysql_connection(
            host=host,
            port=port,
            database=database,
            username=username,
            password=password,
        )
        if not ok:
            raise ValueError(message)
    else:
        ok, message, normalized_path = validate_local_database(engine, path)
        if not ok or normalized_path is None:
            raise ValueError(message)

    with _locked_file():
        data = load_connection_file()
        existing_ids = {connection.id for connection in data.connections}
        connection_id = _normalize_id(label, engine)
        suffix = 2
        while connection_id in existing_ids:
            connection_id = f"{_normalize_id(label, engine)}-{suffix}"
            suffix += 1
        now = utc_now_iso()
        connection = StoredConnection(
            id=connection_id,
            name=label,
            engine=engine,
            mode="network" if engine in {"postgres", "mysql"} else "local_path",
            path=str(normalized_path) if normalized_path is not None else "",
            host=host.strip(),
            port=port,
            database=database.strip(),
            username=username.strip(),
            password=password,
            sslmode=sslmode,
            created_at=now,
            updated_at=now,
        )
        data.connections.append(connection)
        _atomic_write_text(CONNECTIONS_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")
        return connection


def update_connection(
    connection_id: str,
    *,
    name: Optional[str] = None,
    path: Optional[str] = None,
    host: Optional[str] = None,
    port: Optional[int] = None,
    database: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    sslmode: Optional[PostgresSslMode] = None,
) -> StoredConnection:
    with _locked_file():
        data = load_connection_file()
        for idx, current in enumerate(data.connections):
            if current.id != connection_id:
                continue
            updated = current.model_copy(deep=True)
            if name is not None:
                label = name.strip()
                if not label:
                    raise ValueError("name is required")
                updated.name = label
            if current.engine in {"postgres", "mysql"}:
                next_host = host if host is not None else current.host
                next_port = port if port is not None else current.port
                next_database = database if database is not None else current.database
                next_username = username if username is not None else current.username
                next_password = password if password is not None else current.password
                next_sslmode = sslmode if sslmode is not None else current.sslmode
                if current.engine == "postgres":
                    ok, message = validate_postgres_connection(
                        host=next_host,
                        port=next_port,
                        database=next_database,
                        username=next_username,
                        password=next_password,
                        sslmode=next_sslmode,
                    )
                else:
                    ok, message = validate_mysql_connection(
                        host=next_host,
                        port=next_port,
                        database=next_database,
                        username=next_username,
                        password=next_password,
                    )
                if not ok:
                    raise ValueError(message)
                updated.host = next_host.strip()
                updated.port = next_port
                updated.database = next_database.strip()
                updated.username = next_username.strip()
                updated.password = next_password
                updated.sslmode = next_sslmode
            elif path is not None:
                ok, message, normalized_path = validate_local_database(current.engine, path)
                if not ok or normalized_path is None:
                    raise ValueError(message)
                updated.path = str(normalized_path)
            updated.updated_at = utc_now_iso()
            data.connections[idx] = updated
            _atomic_write_text(CONNECTIONS_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")
            return updated
    raise KeyError(connection_id)


def delete_connection(connection_id: str) -> None:
    with _locked_file():
        data = load_connection_file()
        connections = [connection for connection in data.connections if connection.id != connection_id]
        if len(connections) == len(data.connections):
            raise KeyError(connection_id)
        data.connections = connections
        _atomic_write_text(CONNECTIONS_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")


def connection_to_source(connection: StoredConnection) -> DataSource:
    dsn = None
    if connection.engine in {"postgres", "mysql"}:
        if connection.engine == "postgres":
            ok, message = validate_postgres_connection(
                host=connection.host,
                port=connection.port,
                database=connection.database,
                username=connection.username,
                password=connection.password,
                sslmode=connection.sslmode,
            )
        else:
            ok, message = validate_mysql_connection(
                host=connection.host,
                port=connection.port,
                database=connection.database,
                username=connection.username,
                password=connection.password,
            )
        db_path: Path | None = None
        if ok:
            if connection.engine == "postgres":
                dsn = build_postgres_dsn(
                    host=connection.host,
                    port=connection.port,
                    database=connection.database,
                    username=connection.username,
                    password=connection.password,
                    sslmode=connection.sslmode,
                )
            else:
                dsn = build_mysql_dsn(
                    host=connection.host,
                    port=connection.port,
                    database=connection.database,
                    username=connection.username,
                    password=connection.password,
                )
    else:
        ok, message, normalized_path = validate_local_database(connection.engine, connection.path)
        db_path = normalized_path
        if db_path is None:
            try:
                db_path = normalize_local_path(connection.path)
            except ValueError:
                db_path = Path(connection.path).expanduser()
    return DataSource(
        id=f"connection:{connection.id}",
        source_group="user_connection",
        engine=connection.engine,
        display_name=connection.name,
        ready=ok,
        source_type="user_connection",
        database=connection.database if connection.engine in {"postgres", "mysql"} else connection.name,
        db_path=db_path,
        dsn=dsn,
        connection_id=connection.id,
        description=_connection_description(connection),
        reason="" if ok else message,
    )


def _connection_description(connection: StoredConnection) -> str:
    if connection.engine == "postgres":
        location = mask_postgres_location(connection.host, connection.port, connection.database, connection.username)
        return f"User PostgreSQL connection to {location}"
    if connection.engine == "mysql":
        location = mask_mysql_location(connection.host, connection.port, connection.database, connection.username)
        return f"User MySQL connection to {location}"
    return f"User {connection.engine.upper()} local file connection"


def list_connection_sources() -> list[DataSource]:
    return [connection_to_source(connection) for connection in list_connections()]


def resolve_connection_source(source_id: str) -> DataSource:
    prefix = "connection:"
    if not source_id.startswith(prefix):
        raise KeyError(source_id)
    connection = get_connection(source_id[len(prefix):])
    if not connection:
        raise KeyError(source_id)
    return connection_to_source(connection)


def connection_public_dict(connection: StoredConnection) -> dict:
    source = connection_to_source(connection)
    payload = {
        "id": connection.id,
        "name": connection.name,
        "engine": connection.engine,
        "mode": connection.mode,
        "path": "" if connection.engine in {"postgres", "mysql"} else connection.path,
        "host": connection.host if connection.engine in {"postgres", "mysql"} else "",
        "port": connection.port if connection.engine in {"postgres", "mysql"} else None,
        "database": connection.database if connection.engine in {"postgres", "mysql"} else "",
        "username": connection.username if connection.engine in {"postgres", "mysql"} else "",
        "sslmode": connection.sslmode if connection.engine == "postgres" else "",
        "location": (
            mask_postgres_location(connection.host, connection.port, connection.database, connection.username)
            if connection.engine == "postgres"
            else mask_mysql_location(connection.host, connection.port, connection.database, connection.username)
            if connection.engine == "mysql"
            else connection.path
        ),
        "ready": source.ready,
        "reason": source.reason,
        "created_at": connection.created_at,
        "updated_at": connection.updated_at,
        "source": source.to_public_dict(),
    }
    return payload
