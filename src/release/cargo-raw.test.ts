import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { captureVersionJson, parseMinimumMacOs, parseVersionProbeArgs, validateFormat, validateInputs, validateVersion, verifyRaw } from "./cargo-raw.ts";

const armLinux = "aarch64-unknown-linux-musl";
const armMac = "aarch64-apple-darwin";
const linuxFormat = "ELF 64-bit LSB executable, ARM aarch64, statically linked";
const armLinuxGnu = "aarch64-unknown-linux-gnu";
const gnuFormat = "ELF 64-bit LSB pie executable, ARM aarch64, dynamically linked";
const gnuHeaders = "Requesting program interpreter: /lib/ld-linux-aarch64.so.1";
const gnuDynamic = "NEEDED Shared library: [libc.so.6]";
const gnuVersions = "Version needs section '.gnu.version_r' contains 1 entry:\n  0x0010: Name: GLIBC_2.2.5 Flags: none\n  0x0020: Name: GLIBC_2.34 Flags: none\nVersion symbols section '.gnu.version'";

test.each([
  ["unsupported target", () => validateInputs("custom", "app", "1.2.3"), "unsupported cargo-raw target"],
  ...["", "-app", "../app", "app.exe", "app name", "app\n", "a".repeat(65)].map((binary) => ["unsafe binary " + JSON.stringify(binary), () => validateInputs(armMac, binary, "1.2.3"), "binary must be a safe Cargo binary name"] as const),
  ...["", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3+", "1.2.3\n"].map((version) => ["invalid version " + JSON.stringify(version), () => validateInputs(armMac, "app", version), "cargo-raw version must be valid SemVer"] as const),
  ["wrong architecture", () => validateFormat(armMac, "Mach-O 64-bit executable x86_64"), "wrong executable format or architecture"],
  ["wrong format", () => validateFormat(armMac, "ELF 64-bit executable arm64"), "wrong executable format or architecture"],
  ["not executable", () => validateFormat(armMac, "Mach-O 64-bit object arm64"), "wrong executable format or architecture"],
  ["dynamic interpreter", () => validateFormat(armLinux, linuxFormat, "INTERP", ""), "Linux binary must be statically linked"],
  ["shared dependency", () => validateFormat(armLinux, linuxFormat, "", "NEEDED libc.so"), "Linux binary must be statically linked"],
  ["GNU binary with wrong loader", () => validateFormat(armLinuxGnu, gnuFormat, "Requesting program interpreter: /lib64/ld-linux-x86-64.so.2", gnuDynamic, gnuVersions), "must use the target glibc dynamic loader"],
  ["GNU binary without libc", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, "NEEDED libother.so", gnuVersions), "must link against glibc"],
  ["GNU binary without symbol requirements", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, "Version symbols section"), "must declare its glibc symbol requirements"],
  ["GNU binary requiring newer glibc", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuVersions.replace("2.34", "2.40")), "above the supported GLIBC_2.39 baseline"],
  ["GNU binary with an unknown ABI marker", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuVersions.replace("2.34", "ABI_DT_RELR")), "invalid glibc requirement"],
  ...["app 2.0.0", "other 1.2.3", "app 1.2.3+", "app 1.2.3+bad+meta", "app 1.2.3\nextra"].map((reported) => ["wrong reported version " + JSON.stringify(reported), () => validateVersion("app", "1.2.3", reported), "reports an unexpected version"] as const),
  ["double build metadata", () => validateVersion("app", "1.2.3+fixed", "app 1.2.3+fixed+extra"), "reports an unexpected version"],
] satisfies ReadonlyArray<readonly [string, () => void, string]>)("raw verifier rejects %s with its error", (_, check, message) => {
  expect(check).toThrow(message);
});

test.each([
  [armMac, "Mach-O 64-bit executable arm64"],
  ["x86_64-apple-darwin", "Mach-O 64-bit x86_64 executable"],
  [armLinux, linuxFormat],
  ["x86_64-unknown-linux-musl", "ELF 64-bit LSB pie executable, x86-64, static-pie linked"],
])("raw verifier accepts the native format for %s", (target, description) => {
  expect(() => validateInputs(target, "app", "1.2.3-rc.1+build.2")).not.toThrow();
  expect(() => validateFormat(target, description)).not.toThrow();
});

test.each([
  [armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuVersions],
  ["x86_64-unknown-linux-gnu", "ELF 64-bit LSB pie executable, x86-64, dynamically linked", "Requesting program interpreter: /lib64/ld-linux-x86-64.so.2", gnuDynamic, gnuVersions],
] as const)("raw verifier accepts GNU ELF within the supported glibc baseline for %s", (target, description, headers, dynamic, versions) => {
  expect(() => validateInputs(target, "app", "1.2.3")).not.toThrow();
  expect(() => validateFormat(target, description, headers, dynamic, versions)).not.toThrow();
});

test.each(["app 1.2.3", "app 1.2.3+abc.123"])("raw verifier accepts %s", (reported) => {
  expect(() => validateVersion("app", "1.2.3", reported)).not.toThrow();
});

test("version probe args must be a bounded JSON string array", () => {
  expect(parseVersionProbeArgs("[]")).toBeUndefined();
  expect(parseVersionProbeArgs('["version","--json"]')).toEqual(["version", "--json"]);
  for (const value of ["{", "null", "[1]", '[""]', '["bad\\u0000arg"]', JSON.stringify(Array(33).fill("x")), JSON.stringify(["x".repeat(257)])]) {
    expect(() => parseVersionProbeArgs(value), value).toThrow();
  }
});

test("version probe runs the exact executable with a bounded environment and accepts only a JSON object", () => {
  const valid = captureVersionJson(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({name:"app",version:"1.2.3"}))']);
  expect(valid).toEqual({ name: "app", version: "1.2.3" });
  for (const code of [
    'process.stdout.write("not json")',
    'process.stdout.write("[]")',
    'process.exit(3)',
  ]) {
    expect(() => captureVersionJson(process.execPath, ["-e", code])).toThrow();
  }
  expect(() => captureVersionJson(process.execPath, ["-e", 'process.stdout.write("x".repeat(1024 * 1024))'], { maxBuffer: 128, timeoutMs: 1000 })).toThrow("exceeded its output limit");
  expect(() => captureVersionJson(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 100 })).toThrow("timed out");
});

test.each([
  ["LC_BUILD_VERSION", "minos 11.0", "11.0"],
  ["LC_VERSION_MIN_MACOSX", "version 10.15\nsdk 14.0", "10.15"],
  ["LC_BUILD_VERSION", "minos 13.0", "13.0"],
])("records the Mach-O %s deployment floor", (loadCommand, floor, expected) => {
  const field = floor;
  expect(parseMinimumMacOs(`Load command 1\n      cmd ${loadCommand}\n      ${field}\n`)).toBe(expected);
});

test("rejects Mach-O binaries without a recognized deployment target", () => {
  expect(() => parseMinimumMacOs("Load command 1\n cmd LC_NOTE\n offset 10\n")).toThrow("does not declare a minimum operating system");
});

test("raw verifier rejects argument count, a nonexecutable file and a linked executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-reject-"));
  try {
    await writeFile(join(root, "app"), "not executable\n", { mode: 0o644 });
    await writeFile(join(root, "executable"), "#!/bin/sh\necho app 1.2.3\n", { mode: 0o755 });
    await symlink(join(root, "executable"), join(root, "link"));
    for (const [args, error] of [
      [[], "usage: release-build raw"],
      [["--validate", armMac, "app", "invalid"], "cargo-raw version must be valid SemVer"],
      [[root, armMac, "app", "1.2.3", root], "must be a regular executable file"],
      [[join(root, "app"), armMac, "app", "1.2.3", root], "must be a regular executable file"],
      [[join(root, "link"), armMac, "app", "1.2.3", root], "must be a regular executable file"],
    ] satisfies Array<[string[], string]>) {
      expect(() => verifyRaw(args), JSON.stringify(args)).toThrow(error);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
