"""Validate and sign Registry assets in the trusted publisher, without extraction."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import zipfile


TARGETS = (
    "darwin_amd64", "darwin_arm64", "freebsd_386", "freebsd_amd64",
    "freebsd_arm", "freebsd_arm64", "linux_386", "linux_amd64",
    "linux_arm", "linux_arm64", "windows_386", "windows_amd64", "windows_arm64",
)
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular(path):
    require(stat.S_ISREG(path.lstat().st_mode), f"Terraform asset {path.name!r} is not a regular file")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Terraform manifest has duplicate keys")
        result[key] = value
    return result


def validate(directory, name, version, signed):
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) and len(name) <= 64,
            "invalid Terraform provider name")
    require(re.fullmatch(VERSION, version),
            "invalid Terraform provider version or build metadata")
    prefix = f"terraform-provider-{name}_{version}"
    archives = [f"{prefix}_{target}.zip" for target in TARGETS]
    manifest_name = f"{prefix}_manifest.json"
    sums_name = f"{prefix}_SHA256SUMS"
    source_manifest = "terraform-registry-manifest.json"
    actual = {path.name for path in directory.iterdir()} - {"SHA256SUMS"}
    manifests = actual & {source_manifest, manifest_name}
    require(len(manifests) == 1, "Terraform assets must contain exactly one Registry manifest")
    selected_manifest = manifest_name if signed else next(iter(manifests))
    expected = set(archives + [selected_manifest])
    allowed = expected | {sums_name, f"{sums_name}.sig"}
    if signed:
        expected.update([sums_name, f"{sums_name}.sig"])
    require(expected <= actual <= allowed, f"Terraform asset set differs: missing={sorted(expected - actual)}, unexpected={sorted(actual - allowed)}")
    for filename in actual:
        regular(directory / filename)
    manifest = directory / selected_manifest
    try:
        metadata = json.loads(manifest.read_bytes(), object_pairs_hook=unique_object)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("Terraform manifest is not valid JSON") from error
    require(isinstance(metadata, dict) and type(metadata.get("version")) is int and metadata == {
        "version": 1, "metadata": {"protocol_versions": ["6.0"]},
    }, "Terraform manifest must declare exactly version 1 and protocol 6.0")
    for filename, target in zip(archives, TARGETS):
        binary = f"terraform-provider-{name}_v{version}" + (".exe" if target.startswith("windows_") else "")
        allowed = {binary, "LICENSE", "README.md", "CHANGELOG.md"}
        try:
            with zipfile.ZipFile(directory / filename) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                require(len(names) == len(set(names)), f"Terraform archive {filename!r} has duplicate entries")
                require(binary in names, f"Terraform archive {filename!r} is missing its binary")
                for entry in entries:
                    require(not entry.is_dir() and not entry.external_attr & 0x10 and "/" not in entry.filename and "\\" not in entry.filename,
                            f"Terraform archive {filename!r} has a path or directory entry")
                    require(entry.orig_filename == entry.filename and entry.filename in allowed,
                            f"Terraform archive {filename!r} has an unexpected entry")
                    require(not entry.flag_bits & 1, f"Terraform archive {filename!r} has an encrypted entry")
                    mode = entry.external_attr >> 16
                    require(stat.S_IFMT(mode) in (0, stat.S_IFREG), f"Terraform archive {filename!r} has a non-regular entry")
                    require(entry.filename != binary or entry.file_size > 0, f"Terraform archive {filename!r} has an empty binary")
                    with archive.open(entry) as content:
                        while content.read(1024 * 1024):
                            pass
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError) as error:
            raise ValueError(f"Terraform archive {filename!r} is invalid") from error
    return archives, manifest_name, sums_name, manifest


def checksum_content(directory, names):
    lines = []
    for name in sorted(names):
        with (directory / name).open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        lines.append(f"{digest}  {name}\n")
    return "".join(lines).encode()


def write_matching(path, content):
    if path.exists() or path.is_symlink():
        regular(path)
        require(path.read_bytes() == content, f"Terraform asset {path.name!r} does not match its expected content")
    else:
        # A crash must not leave a partially written checksum or signature in assets/.
        with tempfile.NamedTemporaryFile(dir=path.parent.parent) as file:
            file.write(content)
            file.flush()
            os.link(file.name, path)


def gpg(home, arguments, data=None):
    # Do not pass the action's credentials to gpg's environment or diagnostics.
    environment = {key: os.environ[key] for key in ("PATH", "LANG", "SYSTEMROOT") if key in os.environ}
    result = subprocess.run([
        "gpg", "--no-options", "--homedir", str(home), "--batch", "--no-tty",
        "--no-auto-key-retrieve", "--no-auto-check-trustdb", *arguments,
    ], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, check=False)
    require(result.returncode == 0, "Terraform GPG operation failed")
    return result.stdout


def primary_key(home, fingerprint, secret=False):
    listing = gpg(home, ["--with-colons", "--fixed-list-mode", "--fingerprint",
                         "--list-secret-keys" if secret else "--list-keys"]).decode().splitlines()
    primary = []
    pending = None
    for row in listing:
        fields = row.split(":")
        if fields[0] in ("pub", "sec"):
            pending = fields
        elif fields[0] in ("sub", "ssb"):
            pending = None
        elif fields[0] == "fpr" and pending is not None:
            primary.append((fields[9], pending))
            pending = None
    require(len(primary) == 1 and primary[0][0] == fingerprint,
            "Terraform imported key set does not match the configured primary fingerprint")
    fields = primary[0][1]
    require(fields[3] in ("1", "3") and "s" in fields[11] and fields[1] not in ("r", "e", "d"),
            "Terraform signing key must be an active primary RSA signing key")


def verify_signature(home, directory, sums_name, fingerprint, epoch):
    output = gpg(home, ["--status-fd", "1", "--verify", str(directory / f"{sums_name}.sig"),
                       str(directory / sums_name)]).decode().splitlines()
    signatures = [row.removeprefix("[GNUPG:] ").split() for row in output if row.startswith("[GNUPG:] VALIDSIG ")]
    require(len(signatures) == 1 and len(signatures[0]) >= 10 and signatures[0][1] == fingerprint
            and signatures[0][3] == epoch and signatures[0][7] in ("1", "3") and signatures[0][8] == "8",
            "Terraform detached signature does not match the primary fingerprint, source timestamp and SHA256")


def process(mode, directory, name, version, epoch, fingerprint, credentials):
    require(mode in ("prepare", "verify"), "invalid Terraform asset mode")
    require(re.fullmatch(r"[A-F0-9]{40}", fingerprint), "Terraform GPG fingerprint must be 40 uppercase hexadecimal characters")
    require(re.fullmatch(r"[1-9][0-9]{0,10}", epoch), "invalid Terraform source timestamp")
    require(credentials.get("key"), "Terraform GPG key is required")
    if mode == "prepare":
        require(credentials.get("passphrase"), "Terraform GPG passphrase is required")
    signed = mode == "verify"
    archives, manifest_name, sums_name, manifest = validate(directory, name, version, signed)
    with tempfile.TemporaryDirectory(prefix="csm-ci-terraform-gpg-") as temporary:
        home = Path(temporary)
        home.chmod(0o700)
        try:
            gpg(home, ["--import"], credentials["key"].encode())
            primary_key(home, fingerprint)
            if mode == "prepare":
                primary_key(home, fingerprint, secret=True)
            if manifest.name != manifest_name:
                manifest.rename(directory / manifest_name)
            expected_sums = checksum_content(directory, archives + [manifest_name])
            if mode == "prepare":
                write_matching(directory / sums_name, expected_sums)
                signature = home / "signature"
                gpg(home, ["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--faked-system-time", f"{epoch}!",
                           "--digest-algo", "SHA256", "--local-user", f"{fingerprint}!", "--output", str(signature),
                           "--detach-sign", str(directory / sums_name)], credentials["passphrase"].encode())
                write_matching(directory / f"{sums_name}.sig", signature.read_bytes())
            require((directory / sums_name).read_bytes() == expected_sums, "Terraform Registry checksums do not match the assets")
            verify_signature(home, directory, sums_name, fingerprint, epoch)
            public_key = gpg(home, ["--armor", "--export", fingerprint]).decode()
        finally:
            subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return public_key


if __name__ == "__main__":
    try:
        mode, directory, name, version, epoch, fingerprint = sys.argv[1:]
        credentials = json.load(sys.stdin)
        public_key = process(mode, Path(directory).resolve(), name, version, epoch, fingerprint, credentials)
        print(json.dumps({"publicKey": public_key}))
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
