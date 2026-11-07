import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { prepareAssets } from "./assets.ts";
import { CARGO_RAW_TARGETS, type Release } from "../lib/config.ts";

const directories: string[] = [];
const SOURCE_REVISION = "a".repeat(40);
const rawRelease = { build_type: "cargo-raw", binary: "app", targets: [...CARGO_RAW_TARGETS], version: "1.2.3", sourceRevision: SOURCE_REVISION } satisfies Release & { version: string; sourceRevision: string };

function artifact(target: string, binary = "a", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const normalized: Record<string, string> = {
    "aarch64-apple-darwin": "macos-aarch64",
    "x86_64-apple-darwin": "macos-x86_64",
    "aarch64-unknown-linux-gnu": "linux-aarch64",
    "x86_64-unknown-linux-gnu": "linux-x86_64",
    "aarch64-unknown-linux-musl": "linux-musl-aarch64",
    "x86_64-unknown-linux-musl": "linux-musl-x86_64",
  };
  return {
    version: "1.2.3",
    target: normalized[target],
    rust_target: target,
    ...(target.endsWith("-apple-darwin") ? { minimum_os: "11.0" } : {}),
    ...(target.endsWith("linux-gnu") ? { minimum_libc: "glibc 2.39" } : {}),
    source_revision: SOURCE_REVISION,
    dirty: false,
    sha256: createHash("sha256").update(binary).digest("hex"),
    version_json: { name: "app", version: "1.2.3", target },
    ...overrides,
  };
}

async function writeRawTarget(directory: string, target: string, options: { binary?: string; artifact?: Record<string, unknown> } = {}): Promise<void> {
  const name = `app-${target}`;
  const binary = options.binary ?? "a";
  await writeFile(join(directory, name), binary);
  await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify(options.artifact ?? artifact(target, binary)));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "csm-ci-release-assets-"));
  directories.push(directory);
  return directory;
}

describe("prepareAssets", () => {
  test("revalidates Terraform's exact asset contract before generating aggregate checksums", async () => {
    const directory = await tempDirectory();
    await expect(prepareAssets(directory, {
      build_type: "terraform-provider", provider_name: "test", version: "1.2.3",
      sourceDateEpoch: "1800000000", fingerprint: "A".repeat(40), publicKey: "fixture public key",
    })).rejects.toThrow("Terraform assets must contain exactly one Registry manifest");
    await expect(readFile(join(directory, "SHA256SUMS"))).rejects.toThrow();
  });
  test("validates raw metadata and attests manifests with all six targets", async () => {
    const directory = await tempDirectory();
    for (const target of CARGO_RAW_TARGETS) await writeRawTarget(directory, target);
    const assets = await prepareAssets(directory, rawRelease);
    expect(assets.map(({ name }) => name)).toEqual([...CARGO_RAW_TARGETS.flatMap((target) => [`app-${target}`, `app-${target}.artifact.json`, `app-${target}.sha256`])].sort().concat("SHA256SUMS"));
    for (const target of CARGO_RAW_TARGETS) {
      expect(await readFile(join(directory, `app-${target}.sha256`), "utf8")).toBe(`ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  app-${target}\n`);
    }
    expect((await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")).toHaveLength(18);
    await expect(prepareAssets(directory, rawRelease)).resolves.toEqual(assets);
  });

  test.each([
    ["missing binary", {}, 'missing cargo-raw binary "app-x86_64-unknown-linux-musl"'],
    ["unexpected file", { other: "x" }, 'unexpected cargo-raw asset "other"'],
  ])("rejects cargo-raw %s with its error", async (_, files, message) => {
    const directory = await tempDirectory();
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    await expect(prepareAssets(directory, { build_type: "cargo-raw", binary: "app", targets: ["x86_64-unknown-linux-musl"], version: "1.2.3", sourceRevision: SOURCE_REVISION })).rejects.toThrow(message);
  });

  test("rejects missing, inconsistent, dirty or unexpected raw artifact metadata", async () => {
    const cases: Array<[string, string | undefined, Record<string, unknown> | undefined, string]> = [
      ["missing artifact", undefined, undefined, 'missing cargo-raw artifact "app-x86_64-unknown-linux-musl.artifact.json"'],
      ["bad JSON", "{", undefined, 'cargo-raw artifact "app-x86_64-unknown-linux-musl.artifact.json" is not valid JSON'],
      ["dirty build", undefined, artifact("x86_64-unknown-linux-musl", "a", { dirty: true }), "dirty source build"],
      ["wrong revision", undefined, artifact("x86_64-unknown-linux-musl", "a", { source_revision: "b".repeat(40) }), "source revision does not match"],
      ["wrong digest", undefined, artifact("x86_64-unknown-linux-musl", "a", { sha256: "b".repeat(64) }), "digest does not match"],
      ["wrong runtime floor", undefined, artifact("x86_64-unknown-linux-gnu", "a", { minimum_libc: "glibc 2.38" }), "glibc 2.39 or newer"],
      ["unknown metadata field", undefined, artifact("x86_64-unknown-linux-musl", "a", { unexpected: true }), "Unrecognized key"],
    ];
    for (const [label, json, metadata, message] of cases) {
      const directory = await tempDirectory();
      const name = "app-x86_64-unknown-linux-musl";
      await writeFile(join(directory, name), "a");
      if (json !== undefined) await writeFile(join(directory, `${name}.artifact.json`), json);
      if (metadata !== undefined) await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify(metadata));
      await expect(prepareAssets(directory, { build_type: "cargo-raw", binary: "app", targets: ["x86_64-unknown-linux-musl"], version: "1.2.3", sourceRevision: SOURCE_REVISION }), label).rejects.toThrow(message);
    }
  });

  test("rejects a mismatched supplied binary checksum after metadata validation", async () => {
    const directory = await tempDirectory();
    await writeRawTarget(directory, "x86_64-unknown-linux-musl");
    await writeFile(join(directory, "app-x86_64-unknown-linux-musl.sha256"), "wrong\n");
    await expect(prepareAssets(directory, { build_type: "cargo-raw", binary: "app", targets: ["x86_64-unknown-linux-musl"], version: "1.2.3", sourceRevision: SOURCE_REVISION }))
      .rejects.toThrow('cargo-raw checksum "app-x86_64-unknown-linux-musl.sha256" does not match its binary');
  });

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
