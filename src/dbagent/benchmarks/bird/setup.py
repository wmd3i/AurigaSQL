from __future__ import annotations

import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from urllib.request import urlopen


# Source archive for the BIRD dev set. Overridable via BIRD_DEV_URL; the literal
# below is the default.
DEFAULT_URL = os.environ.get(
    "BIRD_DEV_URL", "https://bird-bench.oss-cn-beijing.aliyuncs.com/dev.zip"
)
OPTIONAL_FILES = ("dev.sql", "dev_tables.json", "dev_tied_append.json")


def download(url: str, destination: Path, force: bool) -> None:
    if destination.exists() and not force:
        print(f"Using existing archive: {destination}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists():
        partial.unlink()

    print(f"Downloading {url}")
    with urlopen(url, timeout=60) as response, partial.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        downloaded = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded / total * 100
                print(
                    f"\r{downloaded / 1024 / 1024:.1f} MiB / {total / 1024 / 1024:.1f} MiB ({pct:.1f}%)",
                    end="",
                )
            else:
                print(f"\r{downloaded / 1024 / 1024:.1f} MiB", end="")
    print()
    partial.replace(destination)


def find_required_paths(extracted_root: Path) -> tuple[Path, Path]:
    dev_jsons = [path for path in extracted_root.rglob("dev.json") if "__MACOSX" not in path.parts]
    db_dirs = [
        path
        for path in extracted_root.rglob("dev_databases")
        if path.is_dir() and "__MACOSX" not in path.parts
    ]

    if not dev_jsons:
        raise FileNotFoundError("Archive did not contain dev.json")

    if not db_dirs:
        nested_archives = [
            path
            for path in extracted_root.rglob("dev_databases.zip")
            if path.is_file() and "__MACOSX" not in path.parts
        ]
        if nested_archives:
            nested_archive = min(nested_archives, key=lambda path: len(path.parts))
            nested_extract_root = extracted_root / "_dev_databases_zip"
            print(f"Extracting nested {nested_archive.name}")
            with zipfile.ZipFile(nested_archive) as zip_file:
                zip_file.extractall(nested_extract_root)
            db_dirs = [
                path
                for path in nested_extract_root.rglob("dev_databases")
                if path.is_dir() and "__MACOSX" not in path.parts
            ]

    if not db_dirs:
        raise FileNotFoundError("Archive did not contain dev_databases/ or dev_databases.zip")

    dev_json = min(dev_jsons, key=lambda path: len(path.parts))
    db_dir = min(db_dirs, key=lambda path: len(path.parts))
    return dev_json, db_dir


def copy_tree(source: Path, destination: Path, force: bool) -> None:
    if destination.exists():
        if not force:
            print(f"Keeping existing directory: {destination}")
            return
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


def prepare_from_archive(archive: Path, output_dir: Path, force: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="bird_dev_extract_") as tmp:
        extract_root = Path(tmp)
        print(f"Extracting {archive}")
        with zipfile.ZipFile(archive) as zip_file:
            zip_file.extractall(extract_root)

        dev_json, db_dir = find_required_paths(extract_root)
        output_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dev_json, output_dir / "dev.json")
        copy_tree(db_dir, output_dir / "dev_databases", force=force)

        for filename in OPTIONAL_FILES:
            candidates = list(extract_root.rglob(filename))
            if candidates:
                shutil.copy2(min(candidates, key=lambda path: len(path.parts)), output_dir / filename)


def prepare_bird_dev(
    *,
    output_dir: Path,
    archive: Path,
    url: str = DEFAULT_URL,
    force: bool = False,
    skip_download: bool = False,
) -> None:
    archive = archive.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()

    if not skip_download:
        download(url, archive, force=force)
    elif not archive.exists():
        raise FileNotFoundError(f"Archive not found: {archive}")

    prepare_from_archive(archive, output_dir, force=force)

    sqlite_count = len(list((output_dir / "dev_databases").rglob("*.sqlite")))
    print(f"Prepared BIRD dev data in {output_dir}")
    print(f"Found {sqlite_count} SQLite databases")


def bird_dev_ready(output_dir: Path) -> bool:
    output_dir = output_dir.expanduser().resolve()
    dev_json = output_dir / "dev.json"
    dev_databases = output_dir / "dev_databases"
    return dev_json.exists() and dev_databases.exists() and any(dev_databases.rglob("*.sqlite"))
