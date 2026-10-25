import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("terraform_collect", os.environ.get("CSM_CI_TERRAFORM_COLLECT_MODULE", str(Path(__file__).with_name("terraform.py"))))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class TerraformCollectTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.client = self.root / "client"
        (self.client / "dist").mkdir(parents=True)
        (self.client / "dist/provider.zip").write_bytes(b"archive")
        (self.client / "dist/checksums").write_bytes(b"untrusted checksums")
        (self.client / "terraform-registry-manifest.json").write_bytes(b"manifest")
        self.manifest = self.client / "dist/artifacts.json"
        self.rows = [{"type": "Archive", "path": "dist/provider.zip"}, {"type": "Checksum", "path": "dist/checksums"}]
        self.manifest.write_text(json.dumps(self.rows))
        self.destination = self.root / "assets"

    def test_collects_only_archives_and_the_root_manifest(self):
        build.collect(self.client, self.destination)
        self.assertEqual(sorted(path.name for path in self.destination.iterdir()), ["provider.zip", "terraform-registry-manifest.json"])
        self.assertEqual((self.destination / "provider.zip").read_bytes(), b"archive")

    def test_rejects_invalid_artifact_rows(self):
        rows = [
            ({}, "manifest is not a list"),
            (["not an object"], "artifact is not an object"),
            ([{"type": "Archive"}], "path is not a string"),
            ([{"type": "Archive", "path": "outside.zip"}], "path is outside dist/"),
            ([{"type": "Archive", "path": "dist/../outside.zip"}], "path is outside dist/"),
            ([{"type": "Archive", "path": "/dist/a.zip"}], "path is outside dist/"),
            ([{"type": "Archive", "path": "dist/a\\b.zip"}], "path is outside dist/"),
            ([{"type": "Checksum", "path": "dist/checksums"}], "no release archives"),
            ([self.rows[0], self.rows[0]], "duplicate GoReleaser asset name"),
        ]
        for content, message in rows:
            with self.subTest(content=content):
                self.manifest.write_text(json.dumps(content))
                with self.assertRaisesRegex(ValueError, message):
                    build.collect(self.client, self.destination)

    def test_rejects_nonregular_files_and_linked_archives(self):
        for name, message in [("dist/artifacts.json", "regular artifacts.json"),
                              ("dist/provider.zip", "regular file inside dist/"),
                              ("terraform-registry-manifest.json", "build output is not a regular file")]:
            with self.subTest(name=name):
                path = self.client / name
                content = path.read_bytes()
                path.unlink()
                (self.root / "outside").write_bytes(content)
                path.symlink_to(self.root / "outside")
                with self.assertRaisesRegex(ValueError, message):
                    build.collect(self.client, self.destination)
                path.unlink()
                path.write_bytes(content)


if __name__ == "__main__":
    unittest.main()
