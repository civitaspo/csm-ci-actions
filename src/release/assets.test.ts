import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { prepareAssets } from "./assets.ts";
import { CARGO_RAW_TARGETS, type Release } from "../lib/config.ts";

const directories: string[] = [];
const rawRelease = { build_type: "cargo-raw", binary: "app", targets: [...CARGO_RAW_TARGETS] } satisfies Release;

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
  test("creates individual raw checksums and attestation subjects for all six targets", async () => {
    const directory = await tempDirectory();
    for (const target of CARGO_RAW_TARGETS) await writeFile(join(directory, `app-${target}`), "a");
    const assets = await prepareAssets(directory, rawRelease);
    expect(assets.map(({ name }) => name)).toEqual([...CARGO_RAW_TARGETS.flatMap((target) => [`app-${target}`, `app-${target}.sha256`])].sort().concat("SHA256SUMS"));
    for (const target of CARGO_RAW_TARGETS) {
      expect(await readFile(join(directory, `app-${target}.sha256`), "utf8")).toBe(`ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  app-${target}\n`);
    }
    expect((await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")).toHaveLength(12);
    await expect(prepareAssets(directory, rawRelease)).resolves.toEqual(assets);
  });

  test("validates opted-in manifests against every declared binary and produces the complete attested asset set", async () => {
    const directory = await tempDirectory();
    const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"] as const;
    const release = { build_type: "cargo-raw", binary: "app", targets: [...targets], version_probe_args: ["version", "--json"] } satisfies Release;
    const version = "1.2.3";
    const sourceRevision = "a".repeat(40);
    const platformTargets: Record<typeof targets[number], { target: string; floor: Record<string, string> }> = {
      "aarch64-apple-darwin": { target: "macos-aarch64", floor: { minimum_os: "13.0" } },
      "x86_64-apple-darwin": { target: "macos-x86_64", floor: { minimum_os: "13.0" } },
      "aarch64-unknown-linux-gnu": { target: "linux-aarch64", floor: { minimum_libc: "glibc 2.39" } },
      "x86_64-unknown-linux-gnu": { target: "linux-x86_64", floor: { minimum_libc: "glibc 2.39" } },
    };
    for (const target of targets) {
      const name = `app-${target}`;
      const content = `binary-${target}`;
      const sha256 = createHash("sha256").update(content).digest("hex");
      await writeFile(join(directory, name), content);
      await writeFile(join(directory, `${name}.artifact.json`), `${JSON.stringify({
        version, target: platformTargets[target].target, rust_target: target, ...platformTargets[target].floor,
        source_revision: sourceRevision, dirty: false, version_json: { version }, sha256,
      })}\n`);
    }
    const assets = await prepareAssets(directory, release, { version, sourceRevision });
    expect(assets.map(({ name }) => name)).toEqual([
      ...targets.flatMap((target) => [`app-${target}`, `app-${target}.artifact.json`, `app-${target}.sha256`]),
      "SHA256SUMS",
    ].sort((a, b) => a.localeCompare(b, "en")));
    expect((await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")).toHaveLength(12);
  });

  test.each(["missing artifact manifest", "wrong source revision", "wrong binary digest", "extra manifest field"])("rejects opted-in cargo-raw %s", async (failure) => {
    const directory = await tempDirectory();
    const target = "x86_64-apple-darwin";
    const name = `app-${target}`;
    const content = "binary";
    const sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(join(directory, name), content);
    if (failure !== "missing artifact manifest") {
      const manifest = {
        version: "1.2.3", target: "macos-x86_64", rust_target: target, minimum_os: "13.0",
        source_revision: failure === "wrong source revision" ? "b".repeat(40) : "a".repeat(40),
        dirty: false, version_json: { version: "1.2.3" }, sha256: failure === "wrong binary digest" ? "c".repeat(64) : sha256,
        ...(failure === "extra manifest field" ? { extra: true } : {}),
      };
      await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify(manifest));
    }
    const release = { build_type: "cargo-raw", binary: "app", targets: [target], version_probe_args: ["version", "--json"] } satisfies Release;
    const message = failure === "missing artifact manifest" ? /missing cargo-raw artifact manifest/
      : failure === "wrong source revision" ? /source does not match/
        : failure === "wrong binary digest" ? /digest does not match/
          : /invalid shape/;
    await expect(prepareAssets(directory, release, { version: "1.2.3", sourceRevision: "a".repeat(40) })).rejects.toThrow(message);
  });

  test.each([
    ["missing binary", {}, 'missing cargo-raw binary "app-x86_64-unknown-linux-musl"'],
    ["unexpected file", { other: "x" }, 'unexpected cargo-raw asset "other"'],
    ["incorrect sidecar", { "app-x86_64-unknown-linux-musl": "a", "app-x86_64-unknown-linux-musl.sha256": "wrong\n" }, 'cargo-raw checksum "app-x86_64-unknown-linux-musl.sha256" does not match its binary'],
  ])("rejects cargo-raw %s with its error", async (_, files, message) => {
    const directory = await tempDirectory();
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    await expect(prepareAssets(directory, { build_type: "cargo-raw", binary: "app", targets: ["x86_64-unknown-linux-musl"] })).rejects.toThrow(message);
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
