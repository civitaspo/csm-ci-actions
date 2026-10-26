"""Real ZIP and manifest tests; GPG protocol tests never create private keys."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("terraform_assets", os.environ.get("CSM_CI_TERRAFORM_ASSET_MODULE", str(Path(__file__).with_name("terraform.py"))))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)

FINGERPRINT = "A" * 40
EPOCH = "1800000000"
VERSION = "1.2.3"
PREFIX = "terraform-provider-test_1.2.3"
MANIFEST = b'{"version":1,"metadata":{"protocol_versions":["6.0"]}}\n'


class TerraformAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        for target in assets.TARGETS:
            self.archive(target)
        (self.directory / "terraform-registry-manifest.json").write_bytes(MANIFEST)

    def archive(self, target="darwin_amd64", additions=(), missing=False, empty=False):
        filename = f"{PREFIX}_{target}.zip"
        binary = f"terraform-provider-test_v{VERSION}" + (".exe" if target.startswith("windows_") else "")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.directory / filename, "w", zipfile.ZIP_DEFLATED) as archive:
                if not missing:
                    info = zipfile.ZipInfo(binary)
                    info.external_attr = (stat.S_IFREG | 0o755) << 16
                    archive.writestr(info, b"" if empty else b"provider binary")
                for name, content, mode in additions:
                    info = zipfile.ZipInfo(name)
                    info.external_attr = mode << 16
                    archive.writestr(info, content)
        return self.directory / filename

    def validate(self, signed=False):
        return assets.validate(self.directory, "test", VERSION, signed)

    def test_preserves_all_thirteen_archive_contracts_and_manifest_bytes(self):
        for target in assets.TARGETS:
            self.archive(target, [(name, b"document", stat.S_IFREG | 0o644) for name in ("README.md", "LICENSE", "CHANGELOG.md")])
        archives, manifest, sums, source = self.validate()
        self.assertEqual(len(archives), 13)
        self.assertEqual(source.read_bytes(), MANIFEST)
        self.assertEqual(manifest, f"{PREFIX}_manifest.json")
        self.assertEqual(sums, f"{PREFIX}_SHA256SUMS")

    def test_archive_rejections(self):
        rows = [
            ("missing binary", [], True, False, "is missing its binary"),
            ("empty binary", [], False, True, "has an empty binary"),
            ("unexpected entry", [("extra", b"x", stat.S_IFREG)], False, False, "has an unexpected entry"),
            ("path", [("../README.md", b"x", stat.S_IFREG)], False, False, "has a path or directory entry"),
            ("backslash", [("a\\README.md", b"x", stat.S_IFREG)], False, False, "has a path or directory entry"),
            ("directory", [("folder/", b"", stat.S_IFDIR)], False, False, "has a path or directory entry"),
            ("symlink", [("README.md", b"target", stat.S_IFLNK)], False, False, "has a non-regular entry"),
            ("device", [("README.md", b"x", stat.S_IFCHR)], False, False, "has a non-regular entry"),
            ("duplicate", [("terraform-provider-test_v1.2.3", b"x", stat.S_IFREG)], False, False, "has duplicate entries"),
            ("NUL", [("README.md\0ignored", b"x", stat.S_IFREG)], False, False, "has an unexpected entry"),
        ]
        for name, additions, missing, empty, message in rows:
            with self.subTest(name=name):
                path = self.archive(additions=additions, missing=missing, empty=empty)
                if name == "NUL":
                    # zipfile's writer truncates NUL, so inject it in both real headers.
                    path.write_bytes(path.read_bytes().replace(b"README.md", b"READ\0E.md"))
                with self.assertRaisesRegex(ValueError, message):
                    self.validate()

    def test_encrypted_and_corrupt_zip_rejections(self):
        for kind, message in [("encrypted", "has an encrypted entry"), ("corrupt", "is invalid"), ("DOS directory", "has a path or directory entry")]:
            with self.subTest(kind=kind):
                path = self.archive()
                content = bytearray(path.read_bytes())
                if kind == "encrypted":
                    central = content.index(b"PK\x01\x02")
                    struct.pack_into("<H", content, central + 8, 1)
                elif kind == "corrupt":
                    content[0:4] = b"FAIL"
                else:
                    central = content.index(b"PK\x01\x02")
                    content[central + 38] |= 0x10
                path.write_bytes(content)
                with self.assertRaisesRegex(ValueError, message):
                    self.validate()

    def test_manifest_rejections(self):
        for content, message in [
            (b"not json", "not valid JSON"),
            (b'{"version":1,"version":1,"metadata":{"protocol_versions":["6.0"]}}', "duplicate keys"),
            (b'{"version":true,"metadata":{"protocol_versions":["6.0"]}}', "exactly version 1 and protocol 6.0"),
            (b'{"version":1.0,"metadata":{"protocol_versions":["6.0"]}}', "exactly version 1 and protocol 6.0"),
            (b'{"version":1,"metadata":{"protocol_versions":["5.0"]}}', "exactly version 1 and protocol 6.0"),
            (b'{"version":1,"metadata":{"protocol_versions":["6.0"]},"extra":1}', "exactly version 1 and protocol 6.0"),
            (b"[]", "exactly version 1 and protocol 6.0"),
        ]:
            with self.subTest(content=content):
                (self.directory / "terraform-registry-manifest.json").write_bytes(content)
                with self.assertRaisesRegex(ValueError, message):
                    self.validate()

    def test_asset_set_and_file_type_rejections(self):
        archive = self.directory / f"{PREFIX}_darwin_amd64.zip"
        for kind, message in [("missing", "asset set differs"), ("unexpected", "asset set differs"),
                              ("directory", "not a regular file"), ("symlink", "not a regular file")]:
            with self.subTest(kind=kind):
                self.archive()
                if kind == "unexpected":
                    (self.directory / "build.sig").write_bytes(b"untrusted")
                else:
                    archive.unlink()
                    if kind == "directory":
                        archive.mkdir()
                    elif kind == "symlink":
                        archive.symlink_to(self.directory / "terraform-registry-manifest.json")
                with self.assertRaisesRegex(ValueError, message):
                    self.validate()
                if archive.is_dir():
                    archive.rmdir()
                elif archive.is_symlink():
                    archive.unlink()
                (self.directory / "build.sig").unlink(missing_ok=True)

    def test_requires_exactly_one_manifest(self):
        source = self.directory / "terraform-registry-manifest.json"
        source.unlink()
        with self.assertRaisesRegex(ValueError, "exactly one Registry manifest"):
            self.validate()
        source.write_bytes(MANIFEST)
        (self.directory / f"{PREFIX}_manifest.json").write_bytes(MANIFEST)
        with self.assertRaisesRegex(ValueError, "exactly one Registry manifest"):
            self.validate()

    def test_provider_name_and_version_rejections(self):
        for name, version, message in [("../test", VERSION, "invalid Terraform provider name"),
                                       ("a" * 65, VERSION, "invalid Terraform provider name"),
                                       ("test", "1.2.3+build", "invalid Terraform provider version"),
                                       ("test", "1.2.3-01", "invalid Terraform provider version"),
                                       ("test", "1.2.3-", "invalid Terraform provider version")]:
            with self.subTest(name=name, version=version), self.assertRaisesRegex(ValueError, message):
                assets.validate(self.directory, name, version, False)

    def test_missing_credentials_and_invalid_public_metadata(self):
        for fingerprint, epoch, credentials, message in [
            ("lowercase", EPOCH, {"key": "fixture", "passphrase": "fixture"}, "40 uppercase"),
            (FINGERPRINT, "-1", {"key": "fixture", "passphrase": "fixture"}, "invalid Terraform source timestamp"),
            (FINGERPRINT, EPOCH, {}, "GPG key is required"),
            (FINGERPRINT, EPOCH, {"key": "fixture"}, "GPG passphrase is required"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                assets.process("prepare", self.directory, "test", VERSION, epoch, fingerprint, credentials)
        with self.assertRaisesRegex(ValueError, "invalid Terraform asset mode"):
            assets.process("unknown", self.directory, "test", VERSION, EPOCH, FINGERPRINT, {"key": "fixture"})

    def test_does_not_overwrite_existing_registry_content(self):
        path = self.directory / "existing"
        path.write_bytes(b"original")
        with self.assertRaisesRegex(ValueError, "does not match its expected content"):
            assets.write_matching(path, b"different")
        self.assertEqual(path.read_bytes(), b"original")

    def test_gpg_failure_does_not_disclose_credentials(self):
        result = subprocess.CompletedProcess([], 1, b"", b"secret fixture text")
        with patch.object(assets.subprocess, "run", return_value=result) as run, self.assertRaisesRegex(ValueError, "^Terraform GPG operation failed$"):
            assets.gpg(self.directory, ["--import"], b"secret fixture text")
        call = run.call_args
        self.assertNotIn("secret fixture text", call.args[0])
        self.assertEqual(call.kwargs["input"], b"secret fixture text")

    def test_primary_key_rejections(self):
        for listing, message in [
            ("", "key set does not match"),
            (f"pub:u:2048:1:id:::::::sc:\nfpr:::::::::{'B' * 40}:\n", "key set does not match"),
            ((f"pub:u:2048:1:id:::::::sc:\nfpr:::::::::{FINGERPRINT}:\n") * 2, "key set does not match"),
            (f"pub:u:255:22:id:::::::sc:\nfpr:::::::::{FINGERPRINT}:\n", "primary RSA signing key"),
            (f"pub:u:2048:1:id:::::::cS:\nfpr:::::::::{FINGERPRINT}:\n", "primary RSA signing key"),
            (f"pub:r:2048:1:id:::::::sc:\nfpr:::::::::{FINGERPRINT}:\n", "primary RSA signing key"),
        ]:
            with self.subTest(listing=listing), patch.object(assets, "gpg", return_value=listing.encode()), self.assertRaisesRegex(ValueError, message):
                assets.primary_key(self.directory, FINGERPRINT)

    def test_signature_rejections(self):
        valid = f"[GNUPG:] VALIDSIG {FINGERPRINT} 2027-01-15 {EPOCH} 0 4 0 1 8 00 {FINGERPRINT}\n"
        for output in ("", valid * 2, valid.replace(FINGERPRINT, "B" * 40), valid.replace(EPOCH, "1800000001"), valid.replace(" 1 8 00", " 1 10 00")):
            with self.subTest(output=output), patch.object(assets, "gpg", return_value=output.encode()), self.assertRaisesRegex(ValueError, "detached signature does not match"):
                assets.verify_signature(self.directory, self.directory, "sums", FINGERPRINT, EPOCH)

    def test_signing_protocol_is_repeatable_and_cleans_its_home(self):
        calls = []
        homes = []
        fail_signing = [True]

        def fake_gpg(home, arguments, data=None):
            homes.append(home)
            calls.append((arguments, data))
            if "--list-keys" in arguments or "--list-secret-keys" in arguments:
                kind = "sec" if "--list-secret-keys" in arguments else "pub"
                return f"{kind}:u:2048:1:id:::::::sc:\nfpr:::::::::{FINGERPRINT}:\n".encode()
            if "--detach-sign" in arguments:
                if fail_signing and fail_signing.pop():
                    raise ValueError("Terraform GPG operation failed")
                Path(arguments[arguments.index("--output") + 1]).write_bytes(b"deterministic signature")
            if "--verify" in arguments:
                return f"[GNUPG:] VALIDSIG {FINGERPRINT} 2027-01-15 {EPOCH} 0 4 0 1 8 00 {FINGERPRINT}\n".encode()
            return b"public key" if "--export" in arguments else b""

        credentials = {"key": "secret fixture text", "passphrase": "passphrase fixture text"}
        original_archives = {path.name: path.read_bytes() for path in self.directory.glob("*.zip")}
        with patch.object(assets, "gpg", side_effect=fake_gpg):
            with self.assertRaisesRegex(ValueError, "GPG operation failed"):
                assets.process("prepare", self.directory, "test", VERSION, EPOCH, FINGERPRINT, credentials)
            self.assertFalse((self.directory / "terraform-registry-manifest.json").exists())
            self.assertFalse((self.directory / f"{PREFIX}_SHA256SUMS.sig").exists())
            for _ in range(2):
                self.assertEqual(assets.process("prepare", self.directory, "test", VERSION, EPOCH, FINGERPRINT, credentials), "public key")
            for suffix in ("_SHA256SUMS", "_SHA256SUMS.sig"):
                (self.directory / f"{PREFIX}{suffix}").unlink()
            self.assertEqual(assets.process("prepare", self.directory, "test", VERSION, EPOCH, FINGERPRINT, credentials), "public key")
            assets.process("verify", self.directory, "test", VERSION, EPOCH, FINGERPRINT, {"key": "public key"})
        self.assertEqual(original_archives, {path.name: path.read_bytes() for path in self.directory.glob("*.zip")})
        self.assertTrue(all(not home.exists() for home in homes))
        self.assertTrue(all("secret fixture text" not in args and "passphrase fixture text" not in args for args, _ in calls))
        sign_args, sign_input = next((args, data) for args, data in calls if "--detach-sign" in args)
        self.assertEqual(sign_input, b"passphrase fixture text")
        self.assertIn(f"{FINGERPRINT}!", sign_args)
        self.assertIn(f"{EPOCH}!", sign_args)
        self.assertIn("SHA256", sign_args)
        self.assertEqual((self.directory / f"{PREFIX}_manifest.json").read_bytes(), MANIFEST)
        self.assertEqual(len((self.directory / f"{PREFIX}_SHA256SUMS").read_text().splitlines()), 14)
        self.assertEqual(len(list(self.directory.iterdir())), 16)
        (self.directory / f"{PREFIX}_SHA256SUMS").write_bytes(b"wrong")
        with patch.object(assets, "gpg", side_effect=fake_gpg), self.assertRaisesRegex(ValueError, "Registry checksums do not match"):
            assets.process("verify", self.directory, "test", VERSION, EPOCH, FINGERPRINT, {"key": "public key"})

    def test_cleanup_on_gpg_failure(self):
        homes = []
        def fail(home, arguments, data=None):
            homes.append(home)
            raise ValueError("Terraform GPG operation failed")
        with patch.object(assets, "gpg", side_effect=fail), self.assertRaisesRegex(ValueError, "GPG operation failed"):
            assets.process("prepare", self.directory, "test", VERSION, EPOCH, FINGERPRINT, {"key": "fixture", "passphrase": "fixture"})
        self.assertTrue(homes and all(not home.exists() for home in homes))


if __name__ == "__main__":
    unittest.main()
