import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { prepareAssets } from "./assets.ts";
import { CARGO_RAW_TARGETS, type Release } from "../lib/config.ts";

const directories: string[] = [];
const rawRelease = { build_type: "cargo-raw", binary: "app", targets: [...CARGO_RAW_TARGETS] } satisfies Release;
const metadataTargets = CARGO_RAW_TARGETS.filter((target) => !target.endsWith("linux-musl"));
const revision = "a".repeat(40);

function artifactManifest(target: string, binary: Uint8Array): Record<string, unknown> {
  const macos = target.endsWith("apple-darwin");
  const arch = target.startsWith("aarch64-") ? "aarch64" : "x86_64";
  return {
    version: "1.2.3",
    target: `${macos ? "macos" : "linux"}-${arch}`,
    rust_target: target,
    ...(macos ? { minimum_os: "13.0" } : { minimum_libc: "glibc 2.39" }),
    source_revision: revision,
    dirty: false,
    version_json: { opaque: { value: true } },
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
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

  test("validates opted-in metadata and includes the exact three assets per target", async () => {
    const directory = await tempDirectory();
    const release = { build_type: "cargo-raw", binary: "app", targets: metadataTargets, version_probe_args: ["version", "--json"], version: "1.2.3", source_revision: revision } satisfies Release & { version: string; source_revision: string };
    for (const target of metadataTargets) {
      const name = `app-${target}`;
      const bytes = Buffer.from(target);
      await writeFile(join(directory, name), bytes);
      await writeFile(join(directory, `${name}.artifact.json`), `${JSON.stringify(artifactManifest(target, bytes), null, 2)}\n`);
    }
    const assets = await prepareAssets(directory, release);
    expect(assets.map(({ name }) => name)).toEqual(metadataTargets.flatMap((target) => {
      const binary = `app-${target}`;
      return [binary, `${binary}.artifact.json`, `${binary}.sha256`];
    }).sort().concat("SHA256SUMS"));
    expect((await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")).toHaveLength(12);
    await expect(prepareAssets(directory, release)).resolves.toEqual(assets);
  });

  test.each([
    ["missing sidecar", (manifest: Record<string, unknown>) => manifest, "missing cargo-raw artifact manifest"],
    ["extra manifest key", (manifest: Record<string, unknown>) => ({ ...manifest, extra: true }), "artifact manifest"],
    ["wrong planned version", (manifest: Record<string, unknown>) => ({ ...manifest, version: "9.9.9" }), "does not match the release plan"],
    ["wrong normalized target", (manifest: Record<string, unknown>) => ({ ...manifest, target: "linux-aarch64" }), "artifact manifest"],
    ["wrong Rust triple", (manifest: Record<string, unknown>) => ({ ...manifest, rust_target: "aarch64-unknown-linux-gnu" }), "artifact manifest"],
    ["wrong source revision", (manifest: Record<string, unknown>) => ({ ...manifest, source_revision: "b".repeat(40) }), "does not match the release plan"],
    ["dirty source", (manifest: Record<string, unknown>) => ({ ...manifest, dirty: true }), "artifact manifest"],
    ["binary digest mismatch", (manifest: Record<string, unknown>) => ({ ...manifest, sha256: "0".repeat(64) }), "does not match the release plan"],
    ["missing required field", (manifest: Record<string, unknown>) => { const result = { ...manifest }; delete result.version_json; return result; }, "artifact manifest"],
    ["invalid libc floor", (manifest: Record<string, unknown>) => ({ ...manifest, minimum_libc: "glibc 2.39.0" }), "artifact manifest"],
    ["both floor keys", (manifest: Record<string, unknown>) => ({ ...manifest, minimum_os: "13.0" }), "artifact manifest"],
  ] as const)("rejects opted-in metadata with %s", async (label, mutate, message) => {
    const directory = await tempDirectory();
    const target = "x86_64-unknown-linux-gnu";
    const name = `app-${target}`;
    const bytes = Buffer.from("binary");
    await writeFile(join(directory, name), bytes);
    if (label !== "missing sidecar") {
      await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify(mutate(artifactManifest(target, bytes))));
    }
    const release = { build_type: "cargo-raw", binary: "app", targets: [target], version_probe_args: ["version", "--json"], version: "1.2.3", source_revision: revision } satisfies Release & { version: string; source_revision: string };
    await expect(prepareAssets(directory, release)).rejects.toThrow(message);
  });

  test.each([
    ["GNU", "x86_64-unknown-linux-gnu", (manifest: Record<string, unknown>) => {
      const { minimum_libc: _, ...rest } = manifest;
      return { ...rest, minimum_os: "13.0" };
    }],
    ["Apple", "aarch64-apple-darwin", (manifest: Record<string, unknown>) => {
      const { minimum_os: _, ...rest } = manifest;
      return { ...rest, minimum_libc: "glibc 2.39" };
    }],
  ] as const)("rejects a single runtime floor that does not match the %s target", async (_, target, mutate) => {
    const directory = await tempDirectory();
    const name = `app-${target}`;
    const bytes = Buffer.from("binary");
    await writeFile(join(directory, name), bytes);
    await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify(mutate(artifactManifest(target, bytes))));
    const release = { build_type: "cargo-raw", binary: "app", targets: [target], version_probe_args: ["version", "--json"], version: "1.2.3", source_revision: revision } satisfies Release & { version: string; source_revision: string };
    await expect(prepareAssets(directory, release)).rejects.toThrow("artifact manifest");
  });

  test("rejects extra keys in Apple artifact manifests", async () => {
    const directory = await tempDirectory();
    const target = "aarch64-apple-darwin";
    const name = `app-${target}`;
    const bytes = Buffer.from("binary");
    await writeFile(join(directory, name), bytes);
    await writeFile(join(directory, `${name}.artifact.json`), JSON.stringify({ ...artifactManifest(target, bytes), extra: true }));
    const release = { build_type: "cargo-raw", binary: "app", targets: [target], version_probe_args: ["version", "--json"], version: "1.2.3", source_revision: revision } satisfies Release & { version: string; source_revision: string };
    await expect(prepareAssets(directory, release)).rejects.toThrow("artifact manifest");
  });

  test("rejects an artifact manifest that is not valid UTF-8", async () => {
    const directory = await tempDirectory();
    const target = "x86_64-unknown-linux-gnu";
    const name = `app-${target}`;
    const binary = Buffer.from("binary");
    await writeFile(join(directory, name), binary);
    const valid = Buffer.from(JSON.stringify({ ...artifactManifest(target, binary), version_json: { opaque: "valid" } }));
    const marker = Buffer.from('"valid"');
    const markerIndex = valid.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([
      valid.subarray(0, markerIndex),
      Buffer.from([0x22, 0xff, 0x22]),
      valid.subarray(markerIndex + marker.length),
    ]);
    await writeFile(join(directory, `${name}.artifact.json`), malformed);
    const release = { build_type: "cargo-raw", binary: "app", targets: [target], version_probe_args: ["version", "--json"], version: "1.2.3", source_revision: revision } satisfies Release & { version: string; source_revision: string };
    await expect(prepareAssets(directory, release)).rejects.toThrow("is not valid UTF-8");
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
