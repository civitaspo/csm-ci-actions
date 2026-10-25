import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


TARGETS = {
    "aarch64-apple-darwin": ("Mach-O 64-bit", "arm64"),
    "x86_64-apple-darwin": ("Mach-O 64-bit", "x86_64"),
    "aarch64-unknown-linux-musl": ("ELF 64-bit LSB", "ARM aarch64"),
    "x86_64-unknown-linux-musl": ("ELF 64-bit LSB", "x86-64"),
}
SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"


def validate_inputs(target, binary, version):
    if target not in TARGETS:
        raise ValueError("unsupported cargo-raw target")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", binary):
        raise ValueError("binary must be a safe Cargo binary name of at most 64 characters")
    if not re.fullmatch(SEMVER, version):
        raise ValueError("cargo-raw version must be valid SemVer")


def validate_format(target, description, headers="", dynamic=""):
    kind, architecture = TARGETS[target]
    if kind not in description or architecture not in description or "executable" not in description:
        raise ValueError("cargo-raw binary has the wrong executable format or architecture")
    if target.endswith("linux-musl") and ("INTERP" in headers or "NEEDED" in dynamic):
        raise ValueError("cargo-raw Linux binary must be statically linked")


def validate_version(binary, version, reported):
    metadata = r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?" if "+" not in version else ""
    if not re.fullmatch(re.escape(f"{binary} {version}") + metadata, reported):
        raise ValueError("cargo-raw binary reports an unexpected version")


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def main(args):
    if len(args) == 4 and args[0] == "--validate":
        validate_inputs(*args[1:])
        return
    if len(args) != 5:
        raise ValueError("usage: raw.py BINARY_PATH TARGET BINARY VERSION OUTPUT_DIRECTORY")
    source, target, binary, version, destination = args
    validate_inputs(target, binary, version)
    path = Path(source).resolve(strict=True)
    if Path(source).is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("cargo-raw binary must be a regular executable file")
    description = command("file", "-b", str(path))
    headers = command("readelf", "-l", str(path)) if target.endswith("linux-musl") else ""
    dynamic = command("readelf", "-d", str(path)) if target.endswith("linux-musl") else ""
    validate_format(target, description, headers, dynamic)
    reported = command(str(path), "--version")
    validate_version(binary, version, reported)
    output = Path(destination)
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, output / f"{binary}-{target}")
    (output / f"{binary}-{target}").chmod(0o755)
    print(f"verified {target}: {description}; {reported}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
