import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const script = join(import.meta.dir, "raw.py");
const python = Bun.which("python3") ?? Bun.which("python");
const importer = "import importlib.util,json,sys; spec=importlib.util.spec_from_file_location('raw',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); getattr(module,sys.argv[2])(*json.loads(sys.argv[3]))";
const armLinux = "aarch64-unknown-linux-musl";
const armMac = "aarch64-apple-darwin";
const linuxFormat = "ELF 64-bit LSB executable, ARM aarch64, statically linked";

function call(name: string, args: string[]) {
  if (!python) throw new Error("Python 3 is required for raw Cargo verification");
  return Bun.spawnSync([python, "-B", "-c", importer, script, name, JSON.stringify(args)]);
}

test.each([
  ["unsupported target", "validate_inputs", ["custom", "app", "1.2.3"], "unsupported cargo-raw target"],
  ...["", "-app", "../app", "app.exe", "app name", "app\n", "a".repeat(65)].map((binary) => ["unsafe binary " + JSON.stringify(binary), "validate_inputs", [armMac, binary, "1.2.3"], "binary must be a safe Cargo binary name"] as const),
  ...["", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3+", "1.2.3\n"].map((version) => ["invalid version " + JSON.stringify(version), "validate_inputs", [armMac, "app", version], "cargo-raw version must be valid SemVer"] as const),
  ["wrong architecture", "validate_format", [armMac, "Mach-O 64-bit executable x86_64"], "wrong executable format or architecture"],
  ["wrong format", "validate_format", [armMac, "ELF 64-bit executable arm64"], "wrong executable format or architecture"],
  ["not executable", "validate_format", [armMac, "Mach-O 64-bit object arm64"], "wrong executable format or architecture"],
  ["dynamic interpreter", "validate_format", [armLinux, linuxFormat, "INTERP", ""], "Linux binary must be statically linked"],
  ["shared dependency", "validate_format", [armLinux, linuxFormat, "", "NEEDED libc.so"], "Linux binary must be statically linked"],
  ...["app 2.0.0", "other 1.2.3", "app 1.2.3+", "app 1.2.3+bad+meta", "app 1.2.3\nextra"].map((reported) => ["wrong reported version " + JSON.stringify(reported), "validate_version", ["app", "1.2.3", reported], "reports an unexpected version"] as const),
  ["double build metadata", "validate_version", ["app", "1.2.3+fixed", "app 1.2.3+fixed+extra"], "reports an unexpected version"],
] satisfies ReadonlyArray<readonly [string, string, string[], string]>)("raw verifier rejects %s with its error", (_, name, args, message) => {
  const result = call(name, args);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(message);
});

test.each([
  [armMac, "Mach-O 64-bit executable arm64"],
  ["x86_64-apple-darwin", "Mach-O 64-bit x86_64 executable"],
  [armLinux, linuxFormat],
  ["x86_64-unknown-linux-musl", "ELF 64-bit LSB pie executable, x86-64, static-pie linked"],
])("raw verifier accepts the native format for %s", (target, description) => {
  expect(call("validate_inputs", [target, "app", "1.2.3-rc.1+build.2"]).exitCode).toBe(0);
  expect(call("validate_format", [target, description]).exitCode).toBe(0);
});

test.each(["app 1.2.3", "app 1.2.3+abc.123"])("raw verifier accepts %s", (reported) => {
  expect(call("validate_version", ["app", "1.2.3", reported]).exitCode).toBe(0);
});

test("raw verifier rejects argument count, a nonexecutable file and a linked executable", async () => {
  if (!python) throw new Error("Python 3 is required for raw Cargo verification");
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-reject-"));
  try {
    await writeFile(join(root, "app"), "not executable\n", { mode: 0o644 });
    await writeFile(join(root, "executable"), "#!/bin/sh\necho app 1.2.3\n", { mode: 0o755 });
    await symlink(join(root, "executable"), join(root, "link"));
    for (const [args, error] of [
      [[], "usage: raw.py"],
      [["--validate", armMac, "app", "invalid"], "cargo-raw version must be valid SemVer"],
      [[root, armMac, "app", "1.2.3", root], "must be a regular executable file"],
      [[join(root, "app"), armMac, "app", "1.2.3", root], "must be a regular executable file"],
      [[join(root, "link"), armMac, "app", "1.2.3", root], "must be a regular executable file"],
    ] satisfies Array<[string[], string]>) {
      const result = Bun.spawnSync([python, script, ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(error);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
