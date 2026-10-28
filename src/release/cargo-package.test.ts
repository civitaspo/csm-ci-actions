import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { packageCargo } from "./cargo-package.ts";
import { releaseBuild } from "./release-build.ts";
import { describe, expect, test } from "bun:test";


const rejectionCases = [
  {
    name: "an empty staging directory",
    args: (root: string) => [join(root, "empty"), join(root, "empty.tar.gz")],
    setup: (root: string) => mkdir(join(root, "empty")),
    message: "Cargo produced no executable binaries to package",
  },
  {
    name: "a symbolic link in staging",
    args: (root: string) => [join(root, "staging"), join(root, "linked.tar.gz")],
    setup: async (root: string) => {
      await mkdir(join(root, "staging"));
      await writeFile(join(root, "outside"), "outside binary\n");
      await symlink(join(root, "outside"), join(root, "staging", "linked"));
    },
    message: "Cargo output contains a symbolic link",
  },
  {
    name: "an invalid argument count",
    args: () => [],
    setup: () => Promise.resolve(),
    message: "usage: release-build package SOURCE_DIRECTORY DESTINATION",
  },
];

describe("Cargo release packaging", () => {
  test.each(rejectionCases)("rejects $name with its documented error", async ({ args, setup, message }) => {
    const root = await mkdtemp(join(tmpdir(), "cargo-release-package-reject-"));
    try {
      await setup(root);
      expect(() => releaseBuild(["package", ...args(root)]), message).toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("identical binaries produce byte-identical archives despite input mtimes and creation order", async () => {

    const root = await mkdtemp(join(tmpdir(), "cargo-release-package-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      await mkdir(first);
      await mkdir(second);
      await writeFile(join(first, "zeta"), "zeta binary\n");
      await writeFile(join(first, "alpha"), "alpha binary\n");
      await writeFile(join(second, "alpha"), "alpha binary\n");
      await writeFile(join(second, "zeta"), "zeta binary\n");
      await utimes(join(first, "zeta"), 1_600_000_000, 1_600_000_000);
      await utimes(join(first, "alpha"), 1_600_000_010, 1_600_000_010);
      await utimes(join(second, "alpha"), 1_700_000_000, 1_700_000_000);
      await utimes(join(second, "zeta"), 1_700_000_010, 1_700_000_010);

      const firstArchive = join(root, "first.tar.gz");
      const secondArchive = join(root, "second.tar.gz");
      for (const [source, destination] of [[first, firstArchive], [second, secondArchive]] as const) {
        packageCargo(source, destination);
      }

      const firstBytes = await readFile(firstArchive);
      const secondBytes = await readFile(secondArchive);
      expect(firstBytes).toEqual(secondBytes);
      expect(firstBytes.readUInt32LE(4)).toBe(0);
      expect(firstBytes[3]! & 0x08).toBe(0);

      const tar = gunzipSync(firstBytes);
      const entries = [];
      let offset = 0;
      while (entries.length < 2) {
        const header = tar.subarray(offset, offset + 512);
        const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
        entries.push({
          name: header.subarray(0, 100).toString("utf8").replace(/\0.*$/, ""),
          mode: parseInt(header.subarray(100, 108).toString("ascii").replace(/\0.*$/, "").trim(), 8),
          uid: parseInt(header.subarray(108, 116).toString("ascii").replace(/\0.*$/, "").trim(), 8),
          gid: parseInt(header.subarray(116, 124).toString("ascii").replace(/\0.*$/, "").trim(), 8),
          mtime: parseInt(header.subarray(136, 148).toString("ascii").replace(/\0.*$/, "").trim(), 8),
        });
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      expect(entries).toEqual([
        { name: "alpha", mode: 0o755, uid: 0, gid: 0, mtime: 0 },
        { name: "zeta", mode: 0o755, uid: 0, gid: 0, mtime: 0 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Cargo release archive format", () => {
  test("names beyond the ustar limit survive extraction by tar", async () => {
    const root = await mkdtemp(join(tmpdir(), "cargo-release-package-long-"));
    try {
      const longName = "b".repeat(120);
      await mkdir(join(root, "staging"));
      await writeFile(join(root, "staging", longName), "binary\n");
      await writeFile(join(root, "staging", "short"), "short\n");
      packageCargo(join(root, "staging"), join(root, "out", "archive.tar.gz"));
      const result = Bun.spawnSync(["tar", "-tzf", join(root, "out", "archive.tar.gz")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().split("\n").filter(Boolean)).toEqual([longName, "short"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
