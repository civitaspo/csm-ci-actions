import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseMinimumOs, parseVersionJson, runVersionProbe, validateArtifactManifest, validateFormat, validateInputs, validateVersion, verifyRaw, type RawArtifactManifest } from "./cargo-raw.ts";

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

test("raw verifier runs the configured native JSON probe and writes a manifest bound to the copied binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-manifest-"));
  const originalPath = process.env.PATH;
  const originalRevision = process.env.CSM_CI_SOURCE_REVISION;
  const originalClean = process.env.CSM_CI_SOURCE_CLEAN;
  const revision = "a".repeat(40);
  try {
    const tools = join(root, "tools");
    await mkdir(tools);
    await writeFile(join(root, "app"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'app 1.2.3'; exit 0; fi\nif [ \"$1\" = \"version\" ] && [ \"$2\" = \"--json\" ]; then echo '{\"version\":\"1.2.3\",\"channel\":\"stable\"}'; exit 0; fi\nexit 9\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), "#!/bin/sh\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n", { mode: 0o755 });
    const otoolArgs = join(root, "otool-args");
    await writeFile(join(tools, "otool"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${otoolArgs}"\ncase " $* " in *" -v "*) platform=MACOS ;; *) platform=1 ;; esac\nprintf '%s\\n' 'Load command 0' '      cmd LC_BUILD_VERSION' " platform $platform" '    minos 13.1' '      sdk 15.0'\n`, { mode: 0o755 });
    process.env.PATH = `${tools}:${originalPath ?? ""}`;
    process.env.CSM_CI_SOURCE_REVISION = revision;
    process.env.CSM_CI_SOURCE_CLEAN = "true";
    const assets = join(root, "assets");
    verifyRaw([join(root, "app"), armMac, "app", "1.2.3", assets, revision, JSON.stringify(["version", "--json"])]);
    expect(await readFile(otoolArgs, "utf8")).toBe(`-l\n-v\n${await realpath(join(root, "app"))}\n`);
    const binary = await readFile(join(assets, "app-aarch64-apple-darwin"));
    const manifest = JSON.parse(await readFile(join(assets, "app-aarch64-apple-darwin.artifact.json"), "utf8"));
    expect(manifest).toEqual({
      version: "1.2.3",
      target: "macos-aarch64",
      rust_target: armMac,
      minimum_os: "13.1",
      source_revision: revision,
      dirty: false,
      version_json: { version: "1.2.3", channel: "stable" },
      sha256: createHash("sha256").update(binary).digest("hex"),
    });
    expect(Object.keys(manifest).sort()).toEqual(["dirty", "minimum_os", "rust_target", "sha256", "source_revision", "target", "version", "version_json"].sort());
    process.env.CSM_CI_SOURCE_CLEAN = "false";
    expect(() => verifyRaw([
      join(root, "app"), armMac, "app", "1.2.3", join(root, "rejected-assets"), revision, JSON.stringify(["version", "--json"]),
    ])).toThrow("validated clean release source marker");
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalRevision === undefined) delete process.env.CSM_CI_SOURCE_REVISION; else process.env.CSM_CI_SOURCE_REVISION = originalRevision;
    if (originalClean === undefined) delete process.env.CSM_CI_SOURCE_CLEAN; else process.env.CSM_CI_SOURCE_CLEAN = originalClean;
    await rm(root, { recursive: true, force: true });
  }
});

test("raw verifier records the measured GNU libc floor for a native GNU target", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-gnu-manifest-"));
  const originalPath = process.env.PATH;
  const originalRevision = process.env.CSM_CI_SOURCE_REVISION;
  const originalClean = process.env.CSM_CI_SOURCE_CLEAN;
  const revision = "d".repeat(40);
  try {
    const tools = join(root, "tools");
    await mkdir(tools);
    await writeFile(join(root, "app"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'app 1.2.3'; exit 0; fi\necho '{\"version\":\"1.2.3\"}'\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), "#!/bin/sh\nprintf '%s\\n' 'ELF 64-bit LSB pie executable, x86-64, dynamically linked'\n", { mode: 0o755 });
    await writeFile(join(tools, "readelf"), "#!/bin/sh\ncase \"$1\" in\n-l) echo '[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]' ;;\n-d) echo ' 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]' ;;\n-V) printf '%s\\n' \"Version needs section '.gnu.version_r' contains 1 entry:\" '  0x0010: Name: GLIBC_2.2.5 Flags: none' 'Version symbols section .gnu.version' ;;\nesac\n", { mode: 0o755 });
    await writeFile(join(tools, "getconf"), "#!/bin/sh\necho 'glibc 2.39'\n", { mode: 0o755 });
    process.env.PATH = `${tools}:${originalPath ?? ""}`;
    process.env.CSM_CI_SOURCE_REVISION = revision;
    process.env.CSM_CI_SOURCE_CLEAN = "true";
    const assets = join(root, "assets");
    verifyRaw([join(root, "app"), "x86_64-unknown-linux-gnu", "app", "1.2.3", assets, revision, JSON.stringify(["version", "--json"])]);
    const manifest = JSON.parse(await readFile(join(assets, "app-x86_64-unknown-linux-gnu.artifact.json"), "utf8"));
    expect(manifest).toMatchObject({ target: "linux-x86_64", rust_target: "x86_64-unknown-linux-gnu", minimum_libc: "glibc 2.39", source_revision: revision, dirty: false });
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalRevision === undefined) delete process.env.CSM_CI_SOURCE_REVISION; else process.env.CSM_CI_SOURCE_REVISION = originalRevision;
    if (originalClean === undefined) delete process.env.CSM_CI_SOURCE_CLEAN; else process.env.CSM_CI_SOURCE_CLEAN = originalClean;
    await rm(root, { recursive: true, force: true });
  }
});

test("release-build CLI parses metadata probe arguments and produces its manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-cli-manifest-"));
  try {
    const tools = join(root, "tools");
    await mkdir(tools);
    await writeFile(join(root, "app"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'app 1.2.3'; exit 0; fi\nif [ \"$1\" = \"version\" ] && [ \"$2\" = \"--json\" ]; then echo '{\"version\":\"1.2.3\"}'; exit 0; fi\nexit 9\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), "#!/bin/sh\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n", { mode: 0o755 });
    await writeFile(join(tools, "otool"), "#!/bin/sh\nprintf '%s\\n' 'Load command 0' '      cmd LC_BUILD_VERSION' ' platform MACOS' ' minos 13.2'\n", { mode: 0o755 });
    const revision = "e".repeat(40);
    const assets = join(root, "assets");
    const cli = new URL("../release-build/main.ts", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "raw", join(root, "app"), armMac, "app", "1.2.3", assets, revision, JSON.stringify(["version", "--json"])], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ""}`, CSM_CI_SOURCE_REVISION: revision, CSM_CI_SOURCE_CLEAN: "true" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`verified ${armMac}`);
    const manifest = JSON.parse(await readFile(join(assets, `app-${armMac}.artifact.json`), "utf8"));
    expect(manifest).toMatchObject({
      target: "macos-aarch64",
      rust_target: armMac,
      minimum_os: "13.2",
      source_revision: revision,
      dirty: false,
      version_json: { version: "1.2.3" },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release-build CLI keeps the legacy cargo-raw asset path when metadata is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-cli-legacy-"));
  try {
    const tools = join(root, "tools");
    await mkdir(tools);
    await writeFile(join(root, "app"), "#!/bin/sh\necho 'app 1.2.3'\n", { mode: 0o755 });
    await writeFile(join(tools, "file"), "#!/bin/sh\nprintf '%s\\n' 'Mach-O 64-bit executable arm64'\n", { mode: 0o755 });
    const assets = join(root, "assets");
    const cli = new URL("../release-build/main.ts", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "raw", join(root, "app"), armMac, "app", "1.2.3", assets], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(assets)).toEqual([`app-${armMac}`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("raw metadata parsers reject malformed platform floors, JSON, and manifest bindings", () => {
  expect(parseMinimumOs("Load command 0\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 14.2\n")).toBe("14.2");
  expect(parseMinimumOs("Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 10.15\n")).toBe("10.15");
  expect(() => parseMinimumOs("Load command 0\n cmd LC_BUILD_VERSION\n platform IOS\n minos 14.0\n")).toThrow("could not read the macOS deployment target");
  expect(parseVersionJson(Buffer.from('{"ok":true}'))).toEqual({ ok: true });
  for (const output of [Buffer.from("[1]"), Buffer.from("not json"), Buffer.from([0xff])]) {
    expect(() => parseVersionJson(output)).toThrow();
  }
  expect(() => parseVersionJson(Buffer.alloc(1024 * 1024 + 1, 0x61))).toThrow("exceeds 1 MiB");
  const manifest = {
    version: "1.2.3", target: "macos-aarch64", rust_target: armMac, minimum_os: "13.0",
    source_revision: "a".repeat(40), dirty: false, version_json: { version: "1.2.3" }, sha256: "b".repeat(64),
  } satisfies RawArtifactManifest;
  expect(validateArtifactManifest(manifest, { target: armMac, version: "1.2.3", sourceRevision: "a".repeat(40), binarySha256: "b".repeat(64) })).toEqual(manifest);
  expect(() => validateArtifactManifest({ ...manifest, extra: true }, { target: armMac, version: "1.2.3", sourceRevision: "a".repeat(40), binarySha256: "b".repeat(64) })).toThrow("invalid shape");
  expect(() => validateArtifactManifest(manifest, { target: armMac, version: "1.2.3", sourceRevision: "c".repeat(40), binarySha256: "b".repeat(64) })).toThrow("source does not match");
});

test("raw version probe rejects failed commands and output beyond its bounded capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-"));
  try {
    const failed = join(root, "failed");
    const oversized = join(root, "oversized");
    await writeFile(failed, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    await writeFile(oversized, "#!/bin/sh\nhead -c 1048577 /dev/zero\n", { mode: 0o755 });
    expect(() => runVersionProbe(failed, ["version", "--json"])).toThrow("probe failed");
    expect(() => runVersionProbe(oversized, ["version", "--json"])).toThrow("exceeds 1 MiB");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("raw version probe kills a direct child that ignores SIGTERM when its timeout expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "cargo-raw-probe-timeout-"));
  try {
    const pidFile = join(root, "pid");
    const stubborn = join(root, "stubborn");
    await writeFile(stubborn, `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' "$$" > "${pidFile}"\nwhile :; do :; done\n`, { mode: 0o755 });
    const startedAt = Date.now();
    expect(() => runVersionProbe(stubborn, [], 500)).toThrow("probe failed");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const childPid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
