import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

const command = (...args: [string, ...string[]]) => execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();

export function verifyRaw(args: string[]): string | undefined {
  if (args.length === 4 && args[0] === "--validate") {
    validateInputs(args[1]!, args[2]!, args[3]!);
    return undefined;
  }
  ensure(args.length === 5, "usage: release-build raw BINARY_PATH TARGET BINARY VERSION OUTPUT_DIRECTORY");
  const [source, target, binary, version, destination] = args as [string, string, string, string, string];
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
  mkdirSync(destination, { recursive: true });
  const output = join(destination, `${binary}-${target}`);
  copyFileSync(path, output);
  chmodSync(output, 0o755);
  return `verified ${target}: ${description}; ${reported}`;
}
