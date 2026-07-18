from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, List, Literal, Optional

from pydantic import BaseModel, Field, ValidationError

from shared.config import CONFIG_DIR

logger = logging.getLogger(__name__)

PROFILE_PATH = CONFIG_DIR / "llm_profiles.json"
LOCK_PATH = CONFIG_DIR / "llm_profiles.lock"
MASK_SENTINELS = {"****", "set", "__MASKED__", "Key already saved"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class LlmProvider(str):
    pass


ProviderName = Literal["openai", "gemini", "zai", "anthropic", "minimax", "xai", "ollama", "other"]
ProfileSource = Literal["user", "env"]


class StoredProfile(BaseModel):
    id: str
    label: str
    provider: ProviderName
    model: str
    api_key: str = ""
    api_base: str = ""
    enabled: bool = True
    source: ProfileSource = "user"
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class ProfileFile(BaseModel):
    version: int = 1
    default_model_id: str = ""
    profiles: List[StoredProfile] = Field(default_factory=list)


class ProfileView(BaseModel):
    id: str
    label: str
    provider: ProviderName
    model: str
    api_base: str = ""
    enabled: bool = True
    available: bool = True
    source: ProfileSource = "user"
    read_only: bool = False
    api_key_masked: str = ""
    created_at: str = ""
    updated_at: str = ""


def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def mask_api_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "set"
    return f"{key[:4]}...{key[-4:]}"


def _normalize_id(label: str, provider: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", f"{provider}-{label}".strip().lower()).strip("-")
    return base or f"{provider}-model"


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


def load_profile_file() -> ProfileFile:
    ensure_config_dir()
    if not PROFILE_PATH.exists():
        return ProfileFile()
    try:
        raw = PROFILE_PATH.read_text(encoding="utf-8")
        payload = json.loads(raw)
        return ProfileFile.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        logger.warning("Invalid llm_profiles.json, falling back to empty config: %s", exc)
        return ProfileFile()


def save_profile_file(data: ProfileFile) -> None:
    with _locked_file():
        _atomic_write_text(PROFILE_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")


def list_user_profiles() -> List[StoredProfile]:
    return load_profile_file().profiles


def list_user_profile_views(availability_by_id: Optional[dict[str, bool]] = None) -> List[ProfileView]:
    availability_by_id = availability_by_id or {}
    return [
        ProfileView(
            id=profile.id,
            label=profile.label,
            provider=profile.provider,
            model=profile.model,
            api_base=profile.api_base,
            enabled=profile.enabled,
            available=availability_by_id.get(
                profile.id,
                bool(profile.api_key) or (profile.provider in {"ollama", "other"} and bool(profile.api_base)),
            ),
            source=profile.source,
            read_only=False,
            api_key_masked=mask_api_key(profile.api_key),
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )
        for profile in load_profile_file().profiles
    ]


def get_user_profile(profile_id: str) -> Optional[StoredProfile]:
    for profile in load_profile_file().profiles:
        if profile.id == profile_id:
            return profile
    return None


def create_profile(
    *,
    label: str,
    provider: ProviderName,
    model: str,
    api_key: str,
    api_base: str,
    enabled: bool,
) -> StoredProfile:
    with _locked_file():
        data = load_profile_file()
        existing_ids = {profile.id for profile in data.profiles}
        profile_id = _normalize_id(label, provider)
        suffix = 2
        while profile_id in existing_ids:
            profile_id = f"{_normalize_id(label, provider)}-{suffix}"
            suffix += 1
        now = utc_now_iso()
        profile = StoredProfile(
            id=profile_id,
            label=label.strip(),
            provider=provider,
            model=model.strip(),
            api_key=api_key.strip(),
            api_base=api_base.strip(),
            enabled=enabled,
            source="user",
            created_at=now,
            updated_at=now,
        )
        data.profiles.append(profile)
        if not data.default_model_id:
            data.default_model_id = profile.id
        _atomic_write_text(PROFILE_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")
        return profile


def update_profile(
    profile_id: str,
    *,
    label: Optional[str] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    api_base: Optional[str] = None,
    enabled: Optional[bool] = None,
) -> StoredProfile:
    with _locked_file():
        data = load_profile_file()
        for idx, current in enumerate(data.profiles):
            if current.id != profile_id:
                continue
            updated = current.model_copy(deep=True)
            if label is not None:
                updated.label = label.strip()
            if model is not None:
                updated.model = model.strip()
            if api_key is not None and api_key not in MASK_SENTINELS:
                updated.api_key = api_key.strip()
            if api_base is not None:
                updated.api_base = api_base.strip()
            if enabled is not None:
                updated.enabled = enabled
            updated.updated_at = utc_now_iso()
            data.profiles[idx] = updated
            _atomic_write_text(PROFILE_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")
            return updated
    raise KeyError(profile_id)


def set_default_profile(profile_id: str) -> None:
    with _locked_file():
        data = load_profile_file()
        if profile_id and any(profile.id == profile_id for profile in data.profiles):
            data.default_model_id = profile_id
            _atomic_write_text(PROFILE_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")
            return
    raise KeyError(profile_id)


def delete_profile(profile_id: str) -> None:
    with _locked_file():
        data = load_profile_file()
        profiles = [profile for profile in data.profiles if profile.id != profile_id]
        if len(profiles) == len(data.profiles):
            raise KeyError(profile_id)
        data.profiles = profiles
        if data.default_model_id == profile_id:
            data.default_model_id = profiles[0].id if profiles else ""
        _atomic_write_text(PROFILE_PATH, json.dumps(data.model_dump(), indent=2, ensure_ascii=True) + "\n")


def default_model_id_from_store() -> str:
    return load_profile_file().default_model_id
