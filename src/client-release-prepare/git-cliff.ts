import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callbackExecFile);

export type GitCliffPin = { version: string; assets: Readonly<Record<string, { target: string; sha256: string }>> };
export type GitCliffAsset = { name: string; url: string; sha256: string; member: string; version: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// Update the version and every digest together, following docs/release-pr.md#git-cliff-installation.
export const GIT_CLIFF_PIN: GitCliffPin = {
  version: "2.14.2",
  assets: {
    "Linux/X64": { target: "x86_64-unknown-linux-musl", sha256: "fa21e2fc70046fcfd0e43e5e4613873ab799aff3d9dc8559c00d31b270e417d0" },
    "Linux/ARM64": { target: "aarch64-unknown-linux-musl", sha256: "4be21b21ec9699af4d330b224aeba8a41d41d8f5b351ca2da8a9ea2bdc36380f" },
    "macOS/X64": { target: "x86_64-apple-darwin", sha256: "4e647d2deb152aca1e987f225cf42b080b991dd98f3bce4027ef95446d982ac3" },
    "macOS/ARM64": { target: "aarch64-apple-darwin", sha256: "a0be97e237d440d34c5e508ec21d070b2c85cbb8be48a46a56f9a4e8bd247f05" },
  },
};

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Matches the shared GitHub client's retry schedule in docs/github-api.md.
const RETRY_DELAYS_MS = [250, 1_000];

export function selectGitCliffAsset(os: string, arch: string, pin: GitCliffPin = GIT_CLIFF_PIN): GitCliffAsset {
  const platform = `${os}/${arch}`;
  const entry = pin.assets[platform];
  if (!entry) throw new Error(`git-cliff installation does not support runner platform ${platform}; supported: ${Object.keys(pin.assets).join(", ")}`);
  if (!/^[0-9a-f]{64}$/u.test(entry.sha256)) throw new Error(`pinned git-cliff SHA-256 for ${platform} is missing or malformed`);
  const name = `git-cliff-${pin.version}-${entry.target}.tar.gz`;
  return {
    name,
    url: `https://github.com/orhun/git-cliff/releases/download/v${pin.version}/${name}`,
    sha256: entry.sha256,
    member: `git-cliff-${pin.version}/git-cliff`,
    version: pin.version,
  };
}

export function verifyGitCliffArchive(asset: GitCliffAsset, bytes: Uint8Array): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) throw new Error(`${asset.name} SHA-256 ${actual} does not match the pinned ${asset.sha256}`);
}

export async function downloadGitCliffArchive(asset: GitCliffAsset, fetchImpl: Fetch = fetch, maxBytes = MAX_ARCHIVE_BYTES): Promise<Uint8Array> {
  let cause = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 2]));
    let response: Response;
    try {
      response = await fetchImpl(asset.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!response.ok) {
      cause = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      if ([502, 503, 504].includes(response.status)) continue;
      break;
    }
    return readBounded(asset, response, maxBytes);
  }
  throw new Error(`failed to download ${asset.name}: ${cause}`);
}

async function readBounded(asset: GitCliffAsset, response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error(`failed to download ${asset.name}: empty response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new Error(`failed to download ${asset.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${asset.name} exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

// Verifies the pinned digest before anything is written, extracted or executed.
export async function installGitCliff(input: { os: string; arch: string; tempDir: string; pin?: GitCliffPin; fetch?: Fetch }): Promise<string> {
  const asset = selectGitCliffAsset(input.os, input.arch, input.pin);
  const bytes = await downloadGitCliffArchive(asset, input.fetch);
  verifyGitCliffArchive(asset, bytes);
  const directory = await mkdtemp(join(input.tempDir, "git-cliff-"));
  const archive = join(directory, asset.name);
  await writeFile(archive, bytes, { flag: "wx" });
  await execFile("tar", ["-xzf", archive, "-C", directory, asset.member]);
  const binary = join(directory, asset.member);
  const info = await lstat(binary);
  if (!info.isFile()) throw new Error(`${asset.name} member ${asset.member} is not a regular file`);
  const { stdout } = await execFile(binary, ["--version"]);
  const reported = stdout.trim();
  if (reported !== `git-cliff ${asset.version}`) throw new Error(`installed git-cliff reported ${JSON.stringify(reported)}; expected "git-cliff ${asset.version}"`);
  return binary;
}
