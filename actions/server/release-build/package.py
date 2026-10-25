#!/usr/bin/env python3
"""Create a stable gzip-compressed tar archive from staged Cargo binaries."""

from __future__ import annotations

import gzip
import os
from pathlib import Path
import sys
import tarfile
import tempfile


def package(source: Path, destination: Path) -> None:
    paths = list(source.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Cargo output contains a symbolic link")
    files = sorted((path for path in paths if path.is_file()), key=lambda path: path.relative_to(source).as_posix())
    if not files:
        raise ValueError("Cargo produced no executable binaries to package")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=f".{destination.name}.", delete=False) as raw:
            temporary = Path(raw.name)
            with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for path in files:
                        relative = path.relative_to(source).as_posix()
                        info = tarfile.TarInfo(name=relative)
                        info.size = path.stat().st_size
                        info.mode = 0o755
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        info.mtime = 0
                        with path.open("rb") as binary:
                            archive.addfile(info, binary)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: package.py SOURCE_DIRECTORY DESTINATION")
    try:
        package(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
