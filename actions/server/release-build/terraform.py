"""Collect only regular GoReleaser archives and the root Registry manifest."""

import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys


def collect(client, destination):
    manifest = client / "dist/artifacts.json"
    if not stat.S_ISREG(manifest.lstat().st_mode):
        raise ValueError("GoReleaser did not produce a regular artifacts.json manifest")
    artifacts = json.loads(manifest.read_bytes())
    if not isinstance(artifacts, list):
        raise ValueError("GoReleaser artifacts manifest is not a list")
    files = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ValueError("GoReleaser artifact is not an object")
        if artifact.get("type") != "Archive":
            continue
        relative = artifact.get("path")
        if not isinstance(relative, str):
            raise ValueError("GoReleaser archive path is not a string")
        path = PurePosixPath(relative)
        if path.is_absolute() or not path.parts or path.parts[0] != "dist" or ".." in path.parts or "\\" in relative:
            raise ValueError("GoReleaser archive path is outside dist/")
        source = client / path
        if not source.resolve().is_relative_to((client / "dist").resolve()) or not stat.S_ISREG(source.lstat().st_mode):
            raise ValueError("GoReleaser archive is not a regular file inside dist/")
        files.append(source)
    if not files:
        raise ValueError("GoReleaser produced no release archives")
    files.append(client / "terraform-registry-manifest.json")
    names = [path.name for path in files]
    if len(names) != len(set(names)):
        raise ValueError("duplicate GoReleaser asset name")
    for path in files:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError("Terraform build output is not a regular file")
    destination.mkdir(parents=True, exist_ok=True)
    for path in files:
        with path.open("rb") as source, (destination / path.name).open("xb") as target:
            shutil.copyfileobj(source, target)


if __name__ == "__main__":
    try:
        collect(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except (ValueError, OSError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
