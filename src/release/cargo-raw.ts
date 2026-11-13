import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
export const ArtifactManifestSchema = z.union([
  z.strictObject({
    version: z.string(), target: z.string(), rust_target: z.string(), minimum_os: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,2}$/u),
    source_revision: z.string().regex(/^[a-f0-9]{40}$/u), dirty: z.literal(false),
    version_json: z.record(z.string(), z.unknown()), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    version: z.string(), target: z.string(), rust_target: z.string(), minimum_libc: z.string().regex(/^glibc [0-9]+\.[0-9]+$/u),
    source_revision: z.string().regex(/^[a-f0-9]{40}$/u), dirty: z.literal(false),
    version_json: z.record(z.string(), z.unknown()), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]).superRefine((manifest, ctx) => {
  const target = manifest.rust_target;
  const supported = target.endsWith("apple-darwin") || target.endsWith("linux-gnu");
  if (!supported || normalizedTarget(target) !== manifest.target) {
    ctx.addIssue({ code: "custom", path: ["target"], message: "artifact target does not match its Rust target" });
  }
  if (("minimum_os" in manifest) !== target.endsWith("apple-darwin")) {
    ctx.addIssue({ code: "custom", path: ["minimum_os"], message: "artifact runtime floor does not match its Rust target" });
  }
});
const SEMVER = String.raw`(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const MAX_GLIBC = [2, 39, 0] as const;
const MAX_PROBE_BYTES = 1024 * 1024;

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

export function runVersionProbe(binary: string, args: string[], timeout = 30_000): Record<string, unknown> {
  const result = spawnSync(binary, args, { encoding: "buffer", killSignal: "SIGKILL", maxBuffer: MAX_PROBE_BYTES, timeout, stdio: ["ignore", "pipe", "ignore"] });
  const errorCode = result.error && "code" in result.error && typeof result.error.code === "string" ? result.error.code : undefined;
  ensure(!result.error, errorCode === "ETIMEDOUT"
    ? "cargo-raw version probe exceeded its 30-second timeout"
    : errorCode === "ENOBUFS" ? "cargo-raw version probe stdout exceeded 1 MiB" : "cargo-raw version probe could not run");
  ensure(result.status === 0, "cargo-raw version probe exited unsuccessfully");
  const stdout = result.stdout;
  ensure(stdout.length <= MAX_PROBE_BYTES, "cargo-raw version probe stdout exceeded 1 MiB");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
  catch { throw new Error("cargo-raw version probe stdout is not valid UTF-8"); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("cargo-raw version probe stdout is not valid JSON"); }
  ensure(isObject(value), "cargo-raw version probe JSON must be an object");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTarget(target: string): string | undefined {
  const [arch, platform] = target.split("-");
  const normalizedArch = arch === "aarch64" ? "aarch64" : arch === "x86_64" ? "x86_64" : undefined;
  const normalizedPlatform = platform === "apple" ? "macos" : platform === "unknown" ? "linux" : undefined;
  if (!normalizedArch || !normalizedPlatform) return undefined;
  return `${normalizedPlatform}-${normalizedArch}`;
}

export function minimumOs(loadCommands: string): string {
  const value = /cmd LC_BUILD_VERSION(?:(?!\n\s*Load command)[\s\S]){0,160}?\bminos\s+([0-9]+(?:\.[0-9]+){1,2})\b/u.exec(loadCommands)?.[1]
    ?? /cmd LC_VERSION_MIN_MACOSX(?:(?!\n\s*Load command)[\s\S]){0,160}?\bversion\s+([0-9]+(?:\.[0-9]+){1,2})\b/u.exec(loadCommands)?.[1];
  ensure(value !== undefined, "cargo-raw Apple binary has no macOS deployment target load command");
  return value;
}

function runtimeFloor(target: string, binaryPath: string): { minimum_os: string } | { minimum_libc: string } {
  if (target.endsWith("apple-darwin")) return { minimum_os: minimumOs(command("otool", "-l", binaryPath)) };
  const value = command("getconf", "GNU_LIBC_VERSION");
  ensure(/^glibc [0-9]+\.[0-9]+$/u.test(value), "cargo-raw GNU runner returned an invalid GNU_LIBC_VERSION");
  return { minimum_libc: value };
}

const command = (...args: [string, ...string[]]) => execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();
const readelf = (...args: string[]) => execFileSync("readelf", args, {
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
}).trim();

export function verifyRaw(args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (args.length === 4 && args[0] === "--validate") {
    validateInputs(args[1]!, args[2]!, args[3]!);
    return undefined;
  }
  ensure(args.length === 5 || args.length === 6, "usage: release-build raw BINARY_PATH TARGET BINARY VERSION OUTPUT_DIRECTORY [VERSION_PROBE_ARGS_JSON]");
  const source = args[0]!;
  const target = args[1]!;
  const binary = args[2]!;
  const version = args[3]!;
  const destination = args[4]!;
  let probeArgs: string[] | undefined;
  if (args[5] !== undefined && args[5] !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(args[5]); }
    catch { throw new Error("cargo-raw version_probe_args must be valid JSON"); }
    ensure(Array.isArray(parsed) && parsed.length > 0 && parsed.every((arg) => typeof arg === "string"), "cargo-raw version_probe_args must be a nonempty string array");
    ensure(!target.endsWith("linux-musl"), "version_probe_args is unsupported for cargo-raw Linux musl targets");
    probeArgs = parsed;
  }
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
  const headers = linux ? readelf("-l", path) : "";
  const dynamic = linux ? readelf("-d", path) : "";
  const versions = target.endsWith("linux-gnu") ? readelf("-V", path) : "";
  validateFormat(target, description, headers, dynamic, versions);
  const reported = command(path, "--version");
  validateVersion(binary, version, reported);
  const versionJson = probeArgs ? runVersionProbe(path, probeArgs) : undefined;
  mkdirSync(destination, { recursive: true });
  const output = join(destination, `${binary}-${target}`);
  copyFileSync(path, output);
  chmodSync(output, 0o755);
  if (versionJson) {
    const normalized = normalizedTarget(target);
    ensure(normalized !== undefined, "unsupported cargo-raw artifact target");
    ensure(/^[a-f0-9]{40}$/u.test(env.CSM_CI_SOURCE_REVISION ?? "") && env.CSM_CI_SOURCE_CLEAN === "true",
      "cargo-raw metadata requires a trusted clean source revision");
    const manifest = {
      version,
      target: normalized,
      rust_target: target,
      ...runtimeFloor(target, output),
      source_revision: env.CSM_CI_SOURCE_REVISION,
      dirty: false,
      version_json: versionJson,
      sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    };
    writeFileSync(join(destination, `${binary}-${target}.artifact.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  }
  return `verified ${target}: ${description}; ${reported}`;
}
