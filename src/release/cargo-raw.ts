import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ensure } from "./ensure.ts";

export const RAW_TARGETS: Record<string, readonly [string, string]> = {
  "aarch64-apple-darwin": ["Mach-O 64-bit", "arm64"],
  "aarch64-unknown-linux-gnu": ["ELF 64-bit LSB", "ARM aarch64"],
  "x86_64-apple-darwin": ["Mach-O 64-bit", "x86_64"],
  "x86_64-unknown-linux-gnu": ["ELF 64-bit LSB", "x86-64"],
  "aarch64-unknown-linux-musl": ["ELF 64-bit LSB", "ARM aarch64"],
  "x86_64-unknown-linux-musl": ["ELF 64-bit LSB", "x86-64"],
};
const SEMVER = String.raw`(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const MAX_GLIBC = [2, 39, 0] as const;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;

const NORMALIZED_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "macos-aarch64",
  "x86_64-apple-darwin": "macos-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "aarch64-unknown-linux-musl": "linux-musl-aarch64",
  "x86_64-unknown-linux-musl": "linux-musl-x86_64",
};

export const RawArtifactSchema = z.strictObject({
  version: z.string().regex(new RegExp(`^${SEMVER}$`, "u")),
  target: z.enum(["macos-aarch64", "macos-x86_64", "linux-aarch64", "linux-x86_64", "linux-musl-aarch64", "linux-musl-x86_64"]),
  rust_target: z.enum(Object.keys(RAW_TARGETS) as [string, ...string[]]),
  minimum_os: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u).optional(),
  minimum_libc: z.string().regex(/^glibc \d+\.\d+(?:\.\d+)?$/u).optional(),
  source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  dirty: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version_json: z.record(z.string(), z.unknown()).optional(),
}).superRefine((artifact, ctx) => {
  const expectedTarget = NORMALIZED_TARGETS[artifact.rust_target];
  if (artifact.target !== expectedTarget) ctx.addIssue({ code: "custom", path: ["target"], message: "does not match rust_target" });
  const needsOs = artifact.rust_target.endsWith("-apple-darwin");
  const needsGlibc = artifact.rust_target.endsWith("linux-gnu");
  if (needsOs !== (artifact.minimum_os !== undefined)) ctx.addIssue({ code: "custom", path: ["minimum_os"], message: "must be present exactly for macOS targets" });
  if (needsGlibc !== (artifact.minimum_libc !== undefined)) ctx.addIssue({ code: "custom", path: ["minimum_libc"], message: "must be present exactly for Linux GNU targets" });
  if (needsGlibc && artifact.minimum_libc !== undefined) {
    const version = /^glibc (.+)$/u.exec(artifact.minimum_libc)?.[1];
    const parsed = version === undefined ? undefined : parseRuntimeVersion(version);
    if (parsed === undefined || compareVersions(parsed, MAX_GLIBC) < 0) {
      ctx.addIssue({ code: "custom", path: ["minimum_libc"], message: "must report glibc 2.39 or newer" });
    }
  }
});
export type RawArtifact = z.infer<typeof RawArtifactSchema>;

export function validateRawArtifact(value: unknown, expected: { version: string; sourceRevision: string; rustTarget: string; sha256: string }): RawArtifact {
  const artifact = RawArtifactSchema.parse(value);
  ensure(artifact.version === expected.version, "cargo-raw artifact version does not match the release plan");
  ensure(artifact.source_revision === expected.sourceRevision, "cargo-raw artifact source revision does not match the release plan");
  ensure(artifact.rust_target === expected.rustTarget, "cargo-raw artifact Rust target does not match the release plan");
  ensure(artifact.sha256 === expected.sha256, "cargo-raw artifact digest does not match the binary");
  ensure(artifact.dirty === false, "cargo-raw artifact reports a dirty source build");
  return artifact;
}

export type VersionProbeArgs = string[] | undefined;

export function parseVersionProbeArgs(value: string): VersionProbeArgs {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("cargo-raw version probe arguments must be a JSON array of strings"); }
  ensure(Array.isArray(parsed) && parsed.length <= 32 && parsed.every((arg) =>
    typeof arg === "string" && arg.length > 0 && arg.length <= 256 && !arg.includes("\0")),
  "cargo-raw version probe arguments must be a JSON array of at most 32 nonempty strings of at most 256 characters");
  return parsed.length === 0 ? undefined : parsed as string[];
}

export function captureVersionJson(
  executable: string,
  args: string[],
  limits: { timeoutMs?: number; maxBuffer?: number } = {},
): Record<string, unknown> {
  const result = spawnSync(executable, args, {
    cwd: dirname(executable),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
    maxBuffer: limits.maxBuffer ?? VERSION_PROBE_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: limits.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS,
  });
  const timedOut = result.error instanceof Error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  ensure(!result.error, timedOut
    ? "cargo-raw version probe timed out"
    : "cargo-raw version probe could not be started or exceeded its output limit");
  ensure(result.status === 0, "cargo-raw version probe exited unsuccessfully");
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error("cargo-raw version probe must write one valid JSON object to stdout"); }
  ensure(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "cargo-raw version probe must write one valid JSON object to stdout");
  return parsed as Record<string, unknown>;
}

function glibcVersionNumber(version: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/u.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function validateGlibcRequirements(target: string, headers: string, dynamic: string, versions: string): void {
  const loader = target.startsWith("aarch64-") ? "ld-linux-aarch64.so.1" : "ld-linux-x86-64.so.2";
  ensure(headers.includes("Requesting program interpreter:") && headers.includes(loader),
    "cargo-raw GNU Linux binary must use the target glibc dynamic loader");
  ensure(dynamic.includes("NEEDED") && dynamic.includes("libc.so.6"),
    "cargo-raw GNU Linux binary must link against glibc");
  const needed = /Version needs section[\s\S]*?(?=Version (?:definition|symbols?) section|$)/u.exec(versions)?.[0] ?? "";
  const requirements = [...needed.matchAll(/Name: GLIBC_([A-Za-z0-9_.-]+)/gu)].map((match) => match[1]!);
  ensure(requirements.length > 0, "cargo-raw GNU Linux binary must declare its glibc symbol requirements");
  const parsed = requirements.map(glibcVersionNumber);
  ensure(parsed.every((version) => version !== undefined), "cargo-raw GNU Linux binary has an invalid glibc requirement");
  const maximum = parsed.reduce<readonly [number, number, number]>((current, version) =>
    compareVersions(version!, current) > 0 ? version! : current, [0, 0, 0]);
  ensure(compareVersions(maximum, MAX_GLIBC) <= 0,
    `cargo-raw GNU Linux binary requires GLIBC_${maximum[0]}.${maximum[1]}${maximum[2] === 0 ? "" : `.${maximum[2]}`}, above the supported GLIBC_2.39 baseline`);
}

export function validateInputs(target: string, binary: string, version: string): void {
  ensure(Object.hasOwn(RAW_TARGETS, target), "unsupported cargo-raw target");
  ensure(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(binary), "binary must be a safe Cargo binary name of at most 64 characters");
  ensure(new RegExp(`^${SEMVER}$`, "u").test(version), "cargo-raw version must be valid SemVer");
}

export function validateFormat(target: string, description: string, headers = "", dynamic = "", versions = ""): void {
  const [kind, architecture] = RAW_TARGETS[target] ?? ["", ""];
  ensure(description.includes(kind) && description.includes(architecture) && description.includes("executable"),
    "cargo-raw binary has the wrong executable format or architecture");
  ensure(!target.endsWith("linux-musl") || !(headers.includes("INTERP") || dynamic.includes("NEEDED")),
    "cargo-raw Linux binary must be statically linked");
  if (target.endsWith("linux-gnu")) validateGlibcRequirements(target, headers, dynamic, versions);
}

export function validateVersion(binary: string, version: string, reported: string): void {
  const metadata = version.includes("+") ? "" : String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
  ensure(new RegExp(`^${escape(`${binary} ${version}`)}${metadata}$`, "u").test(reported), "cargo-raw binary reports an unexpected version");
}

function parseRuntimeVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/u.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function parseMinimumMacOs(otoolOutput: string): string {
  const versions = otoolOutput.split(/(?=^Load command \d+\s*$)/mu).flatMap((section) => {
    const commandName = /^\s*cmd\s+(LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\s*$/mu.exec(section)?.[1];
    if (commandName === "LC_BUILD_VERSION") return [/^\s*minos\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/mu.exec(section)?.[1]];
    if (commandName === "LC_VERSION_MIN_MACOSX") return [/^\s*version\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/mu.exec(section)?.[1]];
    return [];
  }).filter((version): version is string => version !== undefined);
  ensure(versions.length > 0, "cargo-raw macOS binary does not declare a minimum operating system version");
  const parsed = versions.map(parseRuntimeVersion);
  ensure(parsed.every((version) => version !== undefined), "cargo-raw macOS binary has an invalid minimum operating system version");
  const maximum = parsed.reduce<readonly [number, number, number]>((current, version) =>
    compareVersions(version!, current) > 0 ? version! : current, [0, 0, 0]);
  return maximum[2] === 0 ? `${maximum[0]}.${maximum[1]}` : `${maximum[0]}.${maximum[1]}.${maximum[2]}`;
}

function runtimeFloor(target: string, executable: string): { minimum_os?: string; minimum_libc?: string } {
  if (target.endsWith("-apple-darwin")) return { minimum_os: parseMinimumMacOs(command("otool", "-l", executable)) };
  if (target.endsWith("linux-gnu")) {
    const version = /^glibc\s+(\d+\.\d+(?:\.\d+)?)$/u.exec(command("getconf", "GNU_LIBC_VERSION"))?.[1];
    ensure(version !== undefined, "cargo-raw Linux GNU runner did not report its glibc version");
    const parsed = parseRuntimeVersion(version);
    ensure(parsed !== undefined && compareVersions(parsed, MAX_GLIBC) >= 0,
      "cargo-raw Linux GNU runner must provide glibc 2.39 or newer");
    return { minimum_libc: `glibc ${version}` };
  }
  return {};
}

const command = (...args: [string, ...string[]]) => execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();

export function verifyRaw(args: string[], sourceMetadata?: { sourceRevision: string; sourceClean: boolean }): string | undefined {
  if ((args.length === 4 || args.length === 5) && args[0] === "--validate") {
    validateInputs(args[1]!, args[2]!, args[3]!);
    if (args[4] !== undefined) parseVersionProbeArgs(args[4]);
    return undefined;
  }
  ensure(args.length === 5 || args.length === 6, "usage: release-build raw BINARY_PATH TARGET BINARY VERSION OUTPUT_DIRECTORY [VERSION_PROBE_ARGS_JSON]");
  const [source, target, binary, version, destination] = args as [string, string, string, string, string];
  const versionProbeArgs = args[5] === undefined ? undefined : parseVersionProbeArgs(args[5]);
  validateInputs(target, binary, version);
  const path = realpathSync(resolve(source));
  let executable = false;
  try {
    accessSync(path, constants.X_OK);
    executable = true;
  } catch { /* reported below */ }
  ensure(!lstatSync(source).isSymbolicLink() && statSync(path).isFile() && executable, "cargo-raw binary must be a regular executable file");
  const description = command("file", "-b", path);
  const linux = target.includes("linux-");
  const headers = linux ? command("readelf", "-l", path) : "";
  const dynamic = linux ? command("readelf", "-d", path) : "";
  const versions = target.endsWith("linux-gnu") ? command("readelf", "-V", path) : "";
  validateFormat(target, description, headers, dynamic, versions);
  const reported = command(path, "--version");
  validateVersion(binary, version, reported);
  ensure(sourceMetadata !== undefined && /^[a-f0-9]{40}$/u.test(sourceMetadata.sourceRevision) && sourceMetadata.sourceClean,
    "cargo-raw requires a clean source snapshot with a trusted 40-character source revision");
  mkdirSync(destination, { recursive: true });
  const output = join(destination, `${binary}-${target}`);
  copyFileSync(path, output);
  chmodSync(output, 0o755);
  const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
  const artifact = {
    version,
    target: NORMALIZED_TARGETS[target]!,
    rust_target: target,
    ...runtimeFloor(target, path),
    source_revision: sourceMetadata.sourceRevision,
    dirty: !sourceMetadata.sourceClean,
    sha256: digest,
    ...(versionProbeArgs === undefined ? {} : { version_json: captureVersionJson(path, versionProbeArgs) }),
  };
  writeFileSync(join(destination, `${binary}-${target}.artifact.json`), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  return `verified ${target}: ${description}; ${reported}`;
}
