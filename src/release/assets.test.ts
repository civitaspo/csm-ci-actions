import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { prepareAssets } from "./assets.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "csm-ci-release-assets-"));
  directories.push(directory);
  return directory;
}

describe("prepareAssets", () => {
  test("represents no build assets with an uploadable one-byte checksum list", async () => {
    const directory = await tempDirectory();
    const assets = await prepareAssets(directory);
    expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe("\n");
    expect(assets.map(({ name }) => name)).toEqual(["SHA256SUMS"]);
    await expect(prepareAssets(directory)).resolves.toEqual(assets);
  });

  test("writes deterministic checksums and includes their digest in the manifest", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "z.bin"), "z");
    await writeFile(join(directory, "a.bin"), "a");
    const assets = await prepareAssets(directory);
    expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.bin\n" +
      "594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06  z.bin\n",
    );
    expect(assets.map(({ name }) => name)).toEqual(["a.bin", "z.bin", "SHA256SUMS"]);
    expect(assets.at(-1)?.sha256).toBe("8c8b55091a572713efad52dc5663e69889d6d1da823831487a69b42088cc44d4");
    await expect(prepareAssets(directory)).resolves.toEqual(assets);
  });

  test.each([
    ["unsafe name", "bad?name", "is not a safe filename"],
    ["mismatched existing checksum", "SHA256SUMS", "does not match the build outputs"],
  ])("rejects %s", async (name, assetName, message) => {
    const directory = await tempDirectory();
    await writeFile(join(directory, assetName), "x");
    await expect(prepareAssets(directory)).rejects.toThrow(message);
  });

  test("rejects a symlink in the build outputs", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "source"), "x");
    await symlink(join(directory, "source"), join(directory, "link"));
    await expect(prepareAssets(directory)).rejects.toThrow("not a regular file");
  });

  test.each(["link", "directory"])("rejects a non-file checksum entry (%s)", async (kind) => {
    const directory = await tempDirectory();
    if (kind === "link") await symlink("missing-target", join(directory, "SHA256SUMS"));
    else await mkdir(join(directory, "SHA256SUMS"));
    await expect(prepareAssets(directory)).rejects.toThrow('asset "SHA256SUMS" is not a regular file');
  });
});
