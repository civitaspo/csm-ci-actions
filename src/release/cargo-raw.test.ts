import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ArtifactManifestSchema, minimumOs, runVersionProbe, validateFormat, validateInputs, validateVersion, verifyRaw } from "./cargo-raw.ts";

const armLinux = "aarch64-unknown-linux-musl";
const armMac = "aarch64-apple-darwin";
const linuxFormat = "ELF 64-bit LSB executable, ARM aarch64, statically linked";
const armLinuxGnu = "aarch64-unknown-linux-gnu";
const gnuFormat = "ELF 64-bit LSB pie executable, ARM aarch64, dynamically linked";
const gnuHeaders = "[Requesting program interpreter: /lib/ld-linux-aarch64.so.1]";
const gnuDynamic = " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]";
const gnuVersions = "Version needs section '.gnu.version_r' contains 1 entry:\n  0x0010: Name: GLIBC_2.2.5 Flags: none\n  0x0020: Name: GLIBC_2.34 Flags: none\nVersion symbols section '.gnu.version'";
const gnuRelrOnlyVersions = "Version needs section '.gnu.version_r' contains 1 entry:\n  0x0010: Name: GLIBC_ABI_DT_RELR Flags: none\nVersion symbols section '.gnu.version'";
const gnuRelrAndNewerVersions = "Version needs section '.gnu.version_r' contains 2 entries:\n  0x0010: Name: GLIBC_ABI_DT_RELR Flags: none\n  0x0020: Name: GLIBC_2.40 Flags: none\nVersion symbols section '.gnu.version'";

test.each([
  ["unsupported target", () => validateInputs("custom", "app", "1.2.3"), "unsupported cargo-raw target"],
  ...["", "-app", "../app", "app.exe", "app name", "app\n", "a".repeat(65)].map((binary) => ["unsafe binary " + JSON.stringify(binary), () => validateInputs(armMac, binary, "1.2.3"), "binary must be a safe Cargo binary name"] as const),
  ...["", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3+", "1.2.3\n"].map((version) => ["invalid version " + JSON.stringify(version), () => validateInputs(armMac, "app", version), "cargo-raw version must be valid SemVer"] as const),
  ["wrong architecture", () => validateFormat(armMac, "Mach-O 64-bit executable x86_64"), "wrong executable format or architecture"],
  ["wrong format", () => validateFormat(armMac, "ELF 64-bit executable arm64"), "wrong executable format or architecture"],
  ["not executable", () => validateFormat(armMac, "Mach-O 64-bit object arm64"), "wrong executable format or architecture"],
  ["dynamic interpreter", () => validateFormat(armLinux, linuxFormat, "INTERP", ""), "Linux binary must be statically linked"],
  ["shared dependency", () => validateFormat(armLinux, linuxFormat, "", "NEEDED libc.so"), "Linux binary must be statically linked"],
  ["GNU binary with wrong loader", () => validateFormat(armLinuxGnu, gnuFormat, "[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]", gnuDynamic, gnuVersions), "must use the target glibc dynamic loader"],
  ["GNU binary with loader at an arbitrary path", () => validateFormat(armLinuxGnu, gnuFormat, "[Requesting program interpreter: /tmp/ld-linux-aarch64.so.1]", gnuDynamic, gnuVersions), "must use the target glibc dynamic loader"],
  ["GNU binary without libc", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, "NEEDED libother.so", gnuVersions), "must link against glibc"],
  ["GNU binary with libc only in RUNPATH", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, " 0x0000000000000001 (NEEDED) Shared library: [libother.so]\n 0x000000000000001d (RUNPATH) Library runpath: [libc.so.6]", gnuVersions), "must link against glibc"],
  ["GNU binary with loader text outside interpreter entry", () => validateFormat(armLinuxGnu, gnuFormat, "[Requesting program interpreter: /lib/ld-linux-aarch64.so.1x]\nGNU loader ld-linux-aarch64.so.1", gnuDynamic, gnuVersions), "must use the target glibc dynamic loader"],
  ["GNU binary without symbol requirements", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, "Version symbols section"), "must declare its glibc symbol requirements"],
  ["GNU binary requiring newer glibc", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuVersions.replace("2.34", "2.40")), "above the supported GLIBC_2.39 baseline"],
  ["GNU binary with an unknown ABI marker", () => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuVersions.replace("2.34", "ABI_UNKNOWN")), "invalid glibc requirement"],
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
  ["x86_64-unknown-linux-gnu", "ELF 64-bit LSB pie executable, x86-64, dynamically linked", "[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]", gnuDynamic, gnuVersions],
] as const)("raw verifier accepts GNU ELF within the supported glibc baseline for %s", (target, description, headers, dynamic, versions) => {
  expect(() => validateInputs(target, "app", "1.2.3")).not.toThrow();
  expect(() => validateFormat(target, description, headers, dynamic, versions)).not.toThrow();
});

test.each([
  [armLinuxGnu, gnuFormat, gnuHeaders],
  ["x86_64-unknown-linux-gnu", "ELF 64-bit LSB pie executable, x86-64, dynamically linked", "[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]"],
] as const)("raw verifier accepts GLIBC_ABI_DT_RELR for %s", (target, description, headers) => {
  expect(() => validateFormat(target, description, headers, gnuDynamic, gnuRelrOnlyVersions)).not.toThrow();
});

test("raw verifier rejects a newer numeric requirement alongside GLIBC_ABI_DT_RELR", () => {
  expect(() => validateFormat(armLinuxGnu, gnuFormat, gnuHeaders, gnuDynamic, gnuRelrAndNewerVersions))
    .toThrow("above the supported GLIBC_2.39 baseline");
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

test.each([
  ["invalid JSON", "not-json", "must be valid JSON", armLinuxGnu],
  ["empty argument list", "[]", "nonempty string array", armLinuxGnu],
  ["non-string argument", '["version",3]', "nonempty string array", armLinuxGnu],
  ["musl target", '["version","--json"]', "unsupported for cargo-raw Linux musl targets", "x86_64-unknown-linux-musl"],
] as const)("verifyRaw rejects %s version probe arguments", (_, encoded, message, target) => {
  expect(() => verifyRaw(["", target, "app", "1.2.3", "", encoded])).toThrow(message);
});

test("version probe invokes the executable with direct argv and retains an opaque object", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-"));
  try {
    const executable = join(root, "probe");
    await writeFile(executable, '#!/bin/sh\nprintf \'{"args":["%s","%s"]}\' "$1" "$2"\n', { mode: 0o755 });
    expect(runVersionProbe(executable, ["argument with spaces", "$(not-a-shell)"])).toEqual({ args: ["argument with spaces", "$(not-a-shell)"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

const probeRejections: Array<[string, string, string]> = [
  ["nonzero exit", "#!/bin/sh\nexit 7\n", "exited unsuccessfully"],
  ["invalid UTF-8", "#!/bin/sh\nprintf '\\377'\n", "not valid UTF-8"],
  ["invalid JSON", "#!/bin/sh\nprintf 'nope'\n", "not valid JSON"],
  ...["null", "[]", "1", "\"value\""].map((value): [string, string, string] => ["non-object JSON " + value, `#!/bin/sh\nprintf '%s' '${value}'\n`, "must be an object"]),
];
test.each(probeRejections)("version probe rejects %s", async (_, script, error) => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-reject-"));
  try {
    const executable = join(root, "probe");
    await writeFile(executable, script, { mode: 0o755 });
    expect(() => runVersionProbe(executable, [])).toThrow(error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("version probe rejects a timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-timeout-"));
  try {
    const executable = join(root, "probe");
    await writeFile(executable, "#!/bin/bash\ntrap '' TERM\nend=$((SECONDS + 1))\nwhile (( SECONDS < end )); do :; done\n", { mode: 0o755 });
    const started = performance.now();
    expect(() => runVersionProbe(executable, [], 20)).toThrow("30-second timeout");
    expect(performance.now() - started).toBeLessThan(500);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([1_048_576, 1_048_577])("version probe handles stdout length %i", async (length) => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-size-"));
  try {
    const executable = join(root, "probe");
    const padding = length - 8;
    await writeFile(executable, `#!/bin/sh\nprintf '{"x":"'\nhead -c ${padding} /dev/zero | tr '\\000' x\nprintf '"}'\n`, { mode: 0o755 });
    if (length === 1_048_576) expect(runVersionProbe(executable, [])).toEqual({ x: "x".repeat(padding) });
    else expect(() => runVersionProbe(executable, [])).toThrow("stdout exceeded 1 MiB");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  ["LC_BUILD_VERSION", "Load command 2\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 13.0\n      sdk 17.0\n"],
  ["LC_VERSION_MIN_MACOSX", "Load command 2\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.15.0\n      sdk 11.3\n"],
])("reads bare deployment target from %s", (_, output) => {
  expect(minimumOs(output)).toBe(output.includes("LC_BUILD_VERSION") ? "13.0" : "10.15.0");
});

test("requires a measured Apple deployment target", () => {
  expect(() => minimumOs("no minimum-version load command")).toThrow("no macOS deployment target load command");
});

test.each([
  [armMac, "Mach-O 64-bit executable arm64", "macos-aarch64", "minimum_os"],
  ["x86_64-unknown-linux-gnu", "ELF 64-bit LSB pie executable, x86-64, dynamically linked", "linux-x86_64", "minimum_libc"],
] as const)("verifyRaw emits opted-in manifest with measured %s floor", async (target, description, normalized, floorKey) => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-manifest-"));
  const tools = join(root, "bin");
  const output = join(root, "assets");
  const executable = join(root, "app");
  const previousPath = process.env.PATH;
  try {
    await mkdir(tools, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'app 1.2.3\\n'; else printf '{\"opaque\":true}'; fi\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), `#!/bin/sh\nprintf '%s\\n' '${description}'\n`, { mode: 0o755 });
    if (target.endsWith("apple-darwin")) {
      await writeFile(join(tools, "otool"), "#!/bin/sh\nprintf '%s\\n' 'Load command 2' 'cmd LC_BUILD_VERSION' 'cmdsize 32' 'platform 1' 'minos 13.0' 'sdk 17.0'\n", { mode: 0o755 });
    } else {
      await writeFile(join(tools, "readelf"), "#!/bin/sh\ncase \"$1\" in -l) printf '%s\\n' '[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]' ;; -d) printf '%s\\n' ' 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]' ;; -V) printf '%s\\n' \"Version needs section contains Name: GLIBC_2.34 Flags: none\" 'Version symbols section' ;; esac\n", { mode: 0o755 });
      await writeFile(join(tools, "getconf"), "#!/bin/sh\nprintf '%s\\n' 'glibc 2.39'\n", { mode: 0o755 });
    }
    process.env.PATH = `${tools}:${previousPath ?? ""}`;
    const revision = "a".repeat(40);
    verifyRaw([executable, target, "app", "1.2.3", output, JSON.stringify(["version", "--json"])], {
      CSM_CI_SOURCE_REVISION: revision,
      CSM_CI_SOURCE_CLEAN: "true",
    });
    const binary = await readFile(join(output, `app-${target}`));
    const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(join(output, `app-${target}.artifact.json`), "utf8")));
    expect(Object.keys(manifest).sort()).toEqual(["dirty", "minimum_libc", "minimum_os", "rust_target", "sha256", "source_revision", "target", "version", "version_json"].filter((key) => key !== (floorKey === "minimum_os" ? "minimum_libc" : "minimum_os")).sort());
    expect(manifest).toMatchObject({
      version: "1.2.3", target: normalized, rust_target: target, [floorKey]: floorKey === "minimum_os" ? "13.0" : "glibc 2.39",
      source_revision: revision, dirty: false, version_json: { opaque: true },
      sha256: createHash("sha256").update(binary).digest("hex"),
    });
    expect((await readdir(output)).sort()).toEqual([`app-${target}`, `app-${target}.artifact.json`].sort());
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyRaw keeps the legacy asset set and still requires the SemVer --version result", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-plain-"));
  const tools = join(root, "bin");
  const output = join(root, "assets");
  const executable = join(root, "app");
  const previousPath = process.env.PATH;
  try {
    await mkdir(tools, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nprintf 'app 1.2.3\\n'\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), "#!/bin/sh\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n", { mode: 0o755 });
    process.env.PATH = `${tools}:${previousPath ?? ""}`;
    verifyRaw([executable, armMac, "app", "1.2.3", output]);
    expect(await readdir(output)).toEqual([`app-${armMac}`]);
    const badOutput = join(root, "bad-assets");
    await writeFile(executable, "#!/bin/sh\nprintf 'app 2.0.0\\n'\n", { mode: 0o755 });
    expect(() => verifyRaw([executable, armMac, "app", "1.2.3", badOutput, JSON.stringify(["version", "--json"])], {
      CSM_CI_SOURCE_REVISION: "a".repeat(40), CSM_CI_SOURCE_CLEAN: "true",
    })).toThrow("reports an unexpected version");
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
