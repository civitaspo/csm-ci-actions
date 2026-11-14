import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ensure } from "./ensure.ts";
import { VersionProbeArgs } from "../lib/config.ts";

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
const MAX_PROBE_OUTPUT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const METADATA_TARGETS = {
  "aarch64-apple-darwin": { target: "macos-aarch64", floor: "minimum_os" },
  "x86_64-apple-darwin": { target: "macos-x86_64", floor: "minimum_os" },
  "aarch64-unknown-linux-gnu": { target: "linux-aarch64", floor: "minimum_libc" },
  "x86_64-unknown-linux-gnu": { target: "linux-x86_64", floor: "minimum_libc" },
} as const;
const SEMVER_PATTERN = new RegExp(`^${SEMVER}$`, "u");
const VersionJson = z.record(z.string(), z.unknown());
const RawVerifierInput = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);
const RawValidationInput = z.tuple([z.string(), z.string(), z.string()]);
const RawArtifactManifestSchema = z.union([
  z.strictObject({
    version: z.string().regex(SEMVER_PATTERN),
    target: z.enum(["macos-aarch64", "macos-x86_64"]),
    rust_target: z.enum(["aarch64-apple-darwin", "x86_64-apple-darwin"]),
    minimum_os: z.string().regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/u),
    source_revision: z.string().regex(/^[0-9a-f]{40}$/u),
    dirty: z.literal(false),
    version_json: VersionJson,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    version: z.string().regex(SEMVER_PATTERN),
    target: z.enum(["linux-aarch64", "linux-x86_64"]),
    rust_target: z.enum(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]),
    minimum_libc: z.string().regex(/^glibc (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u),
    source_revision: z.string().regex(/^[0-9a-f]{40}$/u),
    dirty: z.literal(false),
    version_json: VersionJson,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);
export type RawArtifactManifest = z.infer<typeof RawArtifactManifestSchema>;

function metadataTarget(target: string): (typeof METADATA_TARGETS)[keyof typeof METADATA_TARGETS] {
  const value = Object.entries(METADATA_TARGETS).find(([rustTarget]) => rustTarget === target)?.[1];
  ensure(value !== undefined, "version_probe_args supports Apple and Linux GNU targets only");
  return value;
}

export function parseMinimumOs(loadCommands: string): string {
  const commands = loadCommands.split(/(?=^Load command \d+\s*$)/mu);
  for (const command of commands) {
    if (/^\s*cmd LC_BUILD_VERSION\s*$/mu.test(command) && /^\s*platform MACOS\s*$/mu.test(command)) {
      const minimum = /^\s*minos (\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(command)?.[1];
      if (minimum) return minimum;
    }
    if (/^\s*cmd LC_VERSION_MIN_MACOSX\s*$/mu.test(command)) {
      const minimum = /^\s*version (\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(command)?.[1];
      if (minimum) return minimum;
    }
  }
  throw new Error("cargo-raw could not read the macOS deployment target from the executable");
}

export function parseVersionJson(output: Buffer): Record<string, unknown> {
  ensure(output.byteLength <= MAX_PROBE_OUTPUT, "cargo-raw version probe output exceeds 1 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error("cargo-raw version probe output is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("cargo-raw version probe output is not valid JSON");
  }
  const parsed = VersionJson.safeParse(value);
  ensure(parsed.success, "cargo-raw version probe output must be a JSON object");
  return parsed.data;
}

export function validateArtifactManifest(value: unknown, expected: {
  target: string; version: string; sourceRevision: string; binarySha256: string;
}): RawArtifactManifest {
  const parsed = RawArtifactManifestSchema.safeParse(value);
  ensure(parsed.success, "cargo-raw artifact manifest has an invalid shape");
  const manifest = parsed.data;
  const target = metadataTarget(expected.target);
  ensure(manifest.rust_target === expected.target && manifest.target === target.target,
    "cargo-raw artifact manifest target does not match the configured target");
  ensure(manifest.version === expected.version, "cargo-raw artifact manifest version does not match the release plan");
  ensure(manifest.source_revision === expected.sourceRevision && manifest.dirty === false,
    "cargo-raw artifact manifest source does not match the clean release commit");
  ensure(manifest.sha256 === expected.binarySha256, "cargo-raw artifact manifest digest does not match its binary");
  ensure(target.floor === "minimum_os" ? "minimum_os" in manifest : "minimum_libc" in manifest,
    "cargo-raw artifact manifest runtime floor does not match its target");
  return manifest;
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
  const loader = target.startsWith("aarch64-") ? "/lib/ld-linux-aarch64.so.1" : "/lib64/ld-linux-x86-64.so.2";
  const interpreter = /^\s*\[Requesting program interpreter:\s*([^\]]+)\]\s*$/mu.exec(headers)?.[1]?.trim();
  ensure(interpreter === loader,
    "cargo-raw GNU Linux binary must use the target glibc dynamic loader");
  const hasLibcDependency = dynamic.split("\n").some((line) =>
    /^\s*0x[0-9a-f]+\s+\(NEEDED\)\s+Shared library:\s+\[libc\.so\.6\]\s*$/iu.test(line));
  ensure(hasLibcDependency,
    "cargo-raw GNU Linux binary must link against glibc");
  const needed = /Version needs section[\s\S]*?(?=Version (?:definition|symbols?) section|$)/u.exec(versions)?.[0] ?? "";
  const requirements = [...needed.matchAll(/Name: GLIBC_([A-Za-z0-9_.-]+)/gu)].map((match) => match[1]!);
  ensure(requirements.length > 0, "cargo-raw GNU Linux binary must declare its glibc symbol requirements");
  const parsed = requirements.map((requirement) => requirement === "ABI_DT_RELR" ? [2, 36, 0] as const : glibcVersionNumber(requirement));
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

const command = (...args: [string, ...string[]]) => execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();
const readelf = (...args: string[]) => execFileSync("readelf", args, {
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
}).trim();

export function verifyRaw(args: string[]): string | undefined {
  if (args.length === 4 && args[0] === "--validate") {
    const [target, binary, version] = RawValidationInput.parse(args.slice(1));
    validateInputs(target, binary, version);
    return undefined;
  }
  ensure(args.length === 5 || args.length === 7, "usage: release-build raw BINARY_PATH TARGET BINARY VERSION OUTPUT_DIRECTORY [SOURCE_REVISION VERSION_PROBE_ARGS_JSON]");
  const [source, target, binary, version, destination] = RawVerifierInput.parse(args.slice(0, 5));
  validateInputs(target, binary, version);
  let sourceRevision: string | undefined;
  let probeArgs: string[] | undefined;
  if (args.length === 7) {
    sourceRevision = z.string().parse(args.at(5));
    ensure(/^[0-9a-f]{40}$/u.test(sourceRevision), "cargo-raw metadata requires a trusted 40-character source revision");
    const parsedArgs: unknown = JSON.parse(z.string().parse(args.at(6)));
    ensure(Array.isArray(parsedArgs), "cargo-raw version probe arguments must be a JSON array");
    if (parsedArgs.length > 0) probeArgs = VersionProbeArgs.parse(parsedArgs);
  }
  if (probeArgs) metadataTarget(target);
  const path = realpathSync(resolve(source));
  let executable = false;
  try {
    accessSync(path, constants.X_OK);
    executable = true;
  } catch { /* reported below */ }
  ensure(!lstatSync(source).isSymbolicLink() && statSync(path).isFile() && executable, "cargo-raw binary must be a regular executable file");
  const description = command("file", "-b", path);
  const linux = target.includes("linux-");
  const headers = linux ? readelf("-l", path) : "";
  const dynamic = linux ? readelf("-d", path) : "";
  const versions = target.endsWith("linux-gnu") ? readelf("-V", path) : "";
  validateFormat(target, description, headers, dynamic, versions);
  const reported = command(path, "--version");
  validateVersion(binary, version, reported);
  mkdirSync(destination, { recursive: true });
  const output = join(destination, `${binary}-${target}`);
  copyFileSync(path, output);
  chmodSync(output, 0o755);
  if (probeArgs && sourceRevision) {
    ensure(process.env.CSM_CI_SOURCE_REVISION === sourceRevision && process.env.CSM_CI_SOURCE_CLEAN === "true",
      "cargo-raw metadata requires the validated clean release source marker");
    const versionJson = parseVersionJson(runVersionProbe(path, probeArgs));
    const targetMetadata = metadataTarget(target);
    const floor = targetMetadata.floor === "minimum_os"
      ? { minimum_os: parseMinimumOs(command("otool", "-l", "-v", path)) }
      : { minimum_libc: measureMinimumLibc() };
    const manifest = RawArtifactManifestSchema.parse({
      version,
      target: targetMetadata.target,
      rust_target: target,
      ...floor,
      source_revision: sourceRevision,
      dirty: false,
      version_json: versionJson,
      sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    });
    writeFileSync(`${output}.artifact.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  }
  return `verified ${target}: ${description}; ${reported}`;
}

export function runVersionProbe(path: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Buffer {
  let output: Buffer;
  try {
    output = execFileSync(path, args, { encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_PROBE_OUTPUT + 1 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("cargo-raw version probe output exceeds 1 MiB");
    }
    throw new Error("cargo-raw version probe failed or exceeded its 30-second limit");
  }
  ensure(output.byteLength <= MAX_PROBE_OUTPUT, "cargo-raw version probe output exceeds 1 MiB");
  return output;
}

function measureMinimumLibc(): string {
  const version = command("getconf", "GNU_LIBC_VERSION");
  ensure(/^glibc \d+\.\d+$/u.test(version), "cargo-raw could not measure the GNU libc runtime floor");
  return version;
}
