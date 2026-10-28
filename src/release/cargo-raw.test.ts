import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { validateFormat, validateInputs, validateVersion, verifyRaw } from "./cargo-raw.ts";

const armLinux = "aarch64-unknown-linux-musl";
const armMac = "aarch64-apple-darwin";
const linuxFormat = "ELF 64-bit LSB executable, ARM aarch64, statically linked";

test.each([
  ["unsupported target", () => validateInputs("custom", "app", "1.2.3"), "unsupported cargo-raw target"],
  ...["", "-app", "../app", "app.exe", "app name", "app\n", "a".repeat(65)].map((binary) => ["unsafe binary " + JSON.stringify(binary), () => validateInputs(armMac, binary, "1.2.3"), "binary must be a safe Cargo binary name"] as const),
  ...["", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3+", "1.2.3\n"].map((version) => ["invalid version " + JSON.stringify(version), () => validateInputs(armMac, "app", version), "cargo-raw version must be valid SemVer"] as const),
  ["wrong architecture", () => validateFormat(armMac, "Mach-O 64-bit executable x86_64"), "wrong executable format or architecture"],
  ["wrong format", () => validateFormat(armMac, "ELF 64-bit executable arm64"), "wrong executable format or architecture"],
  ["not executable", () => validateFormat(armMac, "Mach-O 64-bit object arm64"), "wrong executable format or architecture"],
  ["dynamic interpreter", () => validateFormat(armLinux, linuxFormat, "INTERP", ""), "Linux binary must be statically linked"],
  ["shared dependency", () => validateFormat(armLinux, linuxFormat, "", "NEEDED libc.so"), "Linux binary must be statically linked"],
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

test.each(["app 1.2.3", "app 1.2.3+abc.123"])("raw verifier accepts %s", (reported) => {
  expect(() => validateVersion("app", "1.2.3", reported)).not.toThrow();
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
