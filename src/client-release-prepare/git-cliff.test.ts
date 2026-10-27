import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { downloadGitCliffArchive, GIT_CLIFF_PIN, installGitCliff, selectGitCliffAsset, type GitCliffPin } from "./git-cliff.ts";

const execFile = promisify(callbackExecFile);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let root = "";
let runnerTemp = "";
let marker = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "git-cliff-install-"));
  runnerTemp = join(root, "runner-temp");
  marker = join(root, "executed");
  await mkdir(runnerTemp);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Builds a release-shaped archive whose binary records that it ran.
async function archive(options: { reported?: string; symlinkBinary?: boolean } = {}): Promise<Uint8Array> {
  const source = await mkdtemp(join(root, "source-"));
  const folder = join(source, "git-cliff-9.9.9");
  await mkdir(folder);
  await writeFile(join(folder, "README.md"), "not extracted\n");
  if (options.symlinkBinary) await symlink("/bin/sh", join(folder, "git-cliff"));
  else await writeFile(join(folder, "git-cliff"), `#!/bin/sh\ntouch '${marker}'\necho '${options.reported ?? "git-cliff 9.9.9"}'\n`, { mode: 0o755 });
  const output = join(root, `archive-${Date.now()}-${Math.random()}.tar.gz`);
  await execFile("tar", ["-czf", output, "-C", source, "git-cliff-9.9.9"]);
  return readFile(output);
}

const pinFor = (digest: string): GitCliffPin => ({ version: "9.9.9", assets: { "Linux/X64": { target: "x86_64-unknown-linux-musl", sha256: digest } } });

function serve(...responses: Array<Uint8Array | number | Response | Error>) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    if (typeof next === "number") return new Response("error", { status: next });
    if (next instanceof Response) return next;
    return new Response(next);
  };
  return { calls, fetch };
}

const executed = async (): Promise<boolean> => stat(marker).then(() => true, () => false);

describe("pinned git-cliff release", () => {
  test("pins git-cliff 2.14.2 for exactly the supported runner platforms", () => {
    expect(GIT_CLIFF_PIN.version).toBe("2.14.2");
    expect(Object.keys(GIT_CLIFF_PIN.assets).sort()).toEqual(["Linux/ARM64", "Linux/X64", "macOS/ARM64", "macOS/X64"]);
  });

  test.each([
    ["Linux", "X64", "git-cliff-2.14.2-x86_64-unknown-linux-musl.tar.gz", "fa21e2fc70046fcfd0e43e5e4613873ab799aff3d9dc8559c00d31b270e417d0"],
    ["Linux", "ARM64", "git-cliff-2.14.2-aarch64-unknown-linux-musl.tar.gz", "4be21b21ec9699af4d330b224aeba8a41d41d8f5b351ca2da8a9ea2bdc36380f"],
    ["macOS", "X64", "git-cliff-2.14.2-x86_64-apple-darwin.tar.gz", "4e647d2deb152aca1e987f225cf42b080b991dd98f3bce4027ef95446d982ac3"],
    ["macOS", "ARM64", "git-cliff-2.14.2-aarch64-apple-darwin.tar.gz", "a0be97e237d440d34c5e508ec21d070b2c85cbb8be48a46a56f9a4e8bd247f05"],
  ])("selects the %s %s release asset and digest", (os, arch, name, digest) => {
    expect(selectGitCliffAsset(os, arch)).toEqual({
      name,
      url: `https://github.com/orhun/git-cliff/releases/download/v2.14.2/${name}`,
      sha256: digest,
      member: "git-cliff-2.14.2/git-cliff",
      version: "2.14.2",
    });
  });
});

describe("git-cliff installation", () => {
  test("installs only the verified binary after checking its reported version", async () => {
    const bytes = await archive();
    const server = serve(bytes);
    const binary = await installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch });
    expect(server.calls).toEqual(["https://github.com/orhun/git-cliff/releases/download/v9.9.9/git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz"]);
    expect(binary.startsWith(join(runnerTemp, "git-cliff-"))).toBe(true);
    expect(binary.endsWith(join("git-cliff-9.9.9", "git-cliff"))).toBe(true);
    expect(await readdir(join(binary, ".."))).toEqual(["git-cliff"]);
    expect(await executed()).toBe(true);
  });

  test("retries a transient server error and then installs", async () => {
    const bytes = await archive();
    const server = serve(503, new Error("socket hang up"), bytes);
    await installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch });
    expect(server.calls).toHaveLength(3);
  });

  // Every case fails before writing, extracting or executing anything.
  test.each<[string, (bytes: Uint8Array) => { os?: string; arch?: string; pin?: GitCliffPin; responses: Array<Uint8Array | number | Response | Error> }, string]>([
    ["unsupported OS", (bytes) => ({ os: "Windows", pin: pinFor(sha256(bytes)), responses: [bytes] }), "git-cliff installation does not support runner platform Windows/X64; supported: Linux/X64"],
    ["unsupported architecture", (bytes) => ({ arch: "X86", pin: pinFor(sha256(bytes)), responses: [bytes] }), "git-cliff installation does not support runner platform Linux/X86; supported: Linux/X64"],
    ["missing platform", (bytes) => ({ os: "", arch: "", pin: pinFor(sha256(bytes)), responses: [bytes] }), "git-cliff installation does not support runner platform /; supported: Linux/X64"],
    ["unsupported platform in the real pin", (bytes) => ({ os: "Windows", arch: "X64", responses: [bytes] }), "git-cliff installation does not support runner platform Windows/X64; supported: Linux/X64, Linux/ARM64, macOS/X64, macOS/ARM64"],
    ["missing digest", (bytes) => ({ pin: pinFor(""), responses: [bytes] }), "pinned git-cliff SHA-256 for Linux/X64 is missing or malformed"],
    ["uppercase digest", (bytes) => ({ pin: pinFor(sha256(bytes).toUpperCase()), responses: [bytes] }), "pinned git-cliff SHA-256 for Linux/X64 is missing or malformed"],
    ["short digest", (bytes) => ({ pin: pinFor(sha256(bytes).slice(1)), responses: [bytes] }), "pinned git-cliff SHA-256 for Linux/X64 is missing or malformed"],
    ["prefixed digest", (bytes) => ({ pin: pinFor(`sha256:${sha256(bytes)}`), responses: [bytes] }), "pinned git-cliff SHA-256 for Linux/X64 is missing or malformed"],
    ["wrong digest", (bytes) => ({ pin: pinFor("0".repeat(64)), responses: [bytes] }), `does not match the pinned ${"0".repeat(64)}`],
    ["changed archive", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [Buffer.concat([bytes, Buffer.from([0])])] }), `does not match the pinned `],
    ["network error", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [new Error("network down")] }), "failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: network down"],
    ["missing asset", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [404] }), "failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: HTTP 404"],
    ["persistent server error", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [502] }), "failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: HTTP 502"],
    ["missing body", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [new Response(null)] }), "failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: empty response body"],
    ["interrupted body", (bytes) => ({ pin: pinFor(sha256(bytes)), responses: [new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection reset")); } }))] }), "failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: connection reset"],
  ])("rejects %s without extracting or executing", async (_name, scenario, message) => {
    const bytes = await archive();
    const { os = "Linux", arch = "X64", pin, responses } = scenario(bytes);
    const server = serve(...responses);
    const install = installGitCliff({ os, arch, tempDir: runnerTemp, ...(pin ? { pin } : {}), fetch: server.fetch });
    await expect(install).rejects.toThrow(message);
    expect(await readdir(runnerTemp)).toEqual([]);
    expect(await executed()).toBe(false);
  });

  test("reports both digests on a mismatch", async () => {
    const bytes = await archive();
    const changed = Buffer.concat([bytes, Buffer.from([0])]);
    const server = serve(changed);
    await expect(installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch }))
      .rejects.toThrow(`git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz SHA-256 ${sha256(changed)} does not match the pinned ${sha256(bytes)}`);
  });

  test.each([404, 429, 500])("does not retry HTTP %d", async (status) => {
    const bytes = await archive();
    const server = serve(status, bytes);
    await expect(installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch }))
      .rejects.toThrow(`failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: HTTP ${status}`);
    expect(server.calls).toHaveLength(1);
  });

  test("waits before each retry", async () => {
    const bytes = await archive();
    const server = serve(503, 504, bytes);
    const started = performance.now();
    await installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch });
    expect(server.calls).toHaveLength(3);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_200);
  });

  test("stops after three download attempts", async () => {
    const bytes = await archive();
    const server = serve(new Error("one"), 504, new Error("three"), bytes);
    await expect(installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: server.fetch }))
      .rejects.toThrow("failed to download git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz: three");
    expect(server.calls).toHaveLength(3);
  });

  test("rejects an archive larger than the bound", async () => {
    const asset = selectGitCliffAsset("Linux", "X64", pinFor("0".repeat(64)));
    const server = serve(new Uint8Array(11));
    await expect(downloadGitCliffArchive(asset, server.fetch, 10)).rejects.toThrow("git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz exceeds 10 bytes");
    expect(await downloadGitCliffArchive(asset, serve(new Uint8Array(10)).fetch, 10)).toHaveLength(10);
  });

  test("rejects a verified archive whose binary is not a regular file", async () => {
    const bytes = await archive({ symlinkBinary: true });
    await expect(installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: serve(bytes).fetch }))
      .rejects.toThrow("git-cliff-9.9.9-x86_64-unknown-linux-musl.tar.gz member git-cliff-9.9.9/git-cliff is not a regular file");
  });

  test("rejects a verified binary that reports another version", async () => {
    const bytes = await archive({ reported: "git-cliff 9.9.8" });
    await expect(installGitCliff({ os: "Linux", arch: "X64", tempDir: runnerTemp, pin: pinFor(sha256(bytes)), fetch: serve(bytes).fetch }))
      .rejects.toThrow('installed git-cliff reported "git-cliff 9.9.8"; expected "git-cliff 9.9.9"');
  });
});
