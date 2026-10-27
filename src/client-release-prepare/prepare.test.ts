import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { prepareRelease } from "./prepare.ts";

const execFile = promisify(callbackExecFile);

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-pr-"));
  await writeFile(join(root, "git-cliff"), "#!/bin/sh\nif [ \"$1\" = \"--bumped-version\" ]; then echo v1.2.3; else printf 'generated\\n' > CHANGELOG.md; fi\n", { mode: 0o755 });
  return root;
}

// Runs the action entry with the installer replaced by the workspace's stub binary.
async function cliEntry(root: string): Promise<string> {
  const entry = join(root, ".cli-entry.ts");
  const action = join(process.cwd(), "src/client-release-prepare/action.ts");
  await writeFile(entry, `import { runReleasePrepare } from ${JSON.stringify(action)};\nawait runReleasePrepare(async () => ${JSON.stringify(join(root, "git-cliff"))});\n`);
  return entry;
}

test("prepares root versions while preserving every unrelated byte", async () => {
  const root = await workspace();
  try {
    const packageJson = '{\r\n  "name": "sample",\r\n  "version" : "1.0.0",\r\n  "dependencies": { "other": "2.0.0", "version": "3.0.0" }\r\n}\r\n';
    const cargoToml = "[package]\r\nname = 'sample'\r\nversion = '1.0.0' # root\r\n\r\n[dependencies]\r\nversion = \"2.0.0\"\r\n[[bin]]\r\nname = \"other\"\r\nversion = \"3.0.0\"\r\n";
    const cargoLock = 'version = 4\n\n[[package]]\nname = "sample"\nversion  =  "1.0.0"\n\n[[package]]\nname = "sample"\nversion = "1.0.0"\nsource = "registry+https://example.invalid"\n\n[[package]]\nname = "sample"\nversion = "9.0.0"\n\n[[package]]\nname = "other"\nversion = "2.0.0"\n';
    const pyproject = '[project]\nname = "sample"\nversion = "1.0.0"\n\n[tool.other]\nversion = "2.0.0"\n';
    const dbt = 'name: sample\r\nversion: "1.0.0" # package\r\nvars:\r\n  version: 2.0.0\r\n';
    await writeFile(join(root, "package.json"), packageJson);
    await writeFile(join(root, "Cargo.toml"), cargoToml);
    await writeFile(join(root, "Cargo.lock"), cargoLock);
    await writeFile(join(root, "pyproject.toml"), pyproject);
    await writeFile(join(root, "dbt_project.yml"), dbt);
    expect(await prepareRelease({ workspace: root, gitCliff: join(root, "git-cliff") })).toBe("1.2.3");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(packageJson.replace('"1.0.0"', '"1.2.3"'));
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(cargoToml.replace("'1.0.0'", "'1.2.3'"));
    expect(await readFile(join(root, "Cargo.lock"), "utf8")).toBe(cargoLock.replace('version  =  "1.0.0"', 'version  =  "1.2.3"'));
    expect(await readFile(join(root, "pyproject.toml"), "utf8")).toBe(pyproject.replace('"1.0.0"', '"1.2.3"'));
    expect(await readFile(join(root, "dbt_project.yml"), "utf8")).toBe(dbt.replace('"1.0.0"', '"1.2.3"'));
    expect(await readFile(join(root, ".release-version"), "utf8")).toBe("1.2.3\n");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("generated\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

const versionFileCases: Array<[string, string[] | undefined, string[]]> = [
  ["omitted list updates every default manifest", undefined, ["package.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "dbt_project.yml"]],
  ["empty list updates no manifest", [], []],
  ["explicit list updates exactly the listed files", ["Cargo.toml", "Cargo.lock", "herdr-plugin.toml"], ["Cargo.toml", "Cargo.lock", "herdr-plugin.toml"]],
  ["Cargo.toml alone leaves the lockfile", ["Cargo.toml"], ["Cargo.toml"]],
];
test.each(versionFileCases)("version files: %s", async (_name, versionFiles, updated) => {
  const root = await workspace();
  const originals = {
    "package.json": '{\n  "version": "0.1.0"\n}\n',
    "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"\n',
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "sample"\nversion = "0.1.0"\n',
    "pyproject.toml": '[project]\nversion = "0.1.0"\n',
    "dbt_project.yml": 'version: "0.1.0"\n',
    "herdr-plugin.toml": 'version = "0.1.0"\n',
  };
  try {
    for (const [path, content] of Object.entries(originals)) await writeFile(join(root, path), content);
    await prepareRelease({ workspace: root, version: "2.0.0", gitCliff: join(root, "git-cliff"), ...(versionFiles === undefined ? {} : { versionFiles }) });
    for (const [path, content] of Object.entries(originals)) {
      expect(await readFile(join(root, path), "utf8")).toBe(updated.includes(path) ? content.replace("0.1.0", "2.0.0") : content);
    }
    expect(await readFile(join(root, ".release-version"), "utf8")).toBe("2.0.0\n");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("generated\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an empty version file list leaves unsupported manifests and linked lockfiles untouched", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "Cargo.toml"), "intentionally unsupported manifest\n");
    await writeFile(join(root, "untouched.lock"), "fixed lock\n");
    await symlink("untouched.lock", join(root, "Cargo.lock"));
    await prepareRelease({ workspace: root, version: "2.0.0", versionFiles: [], gitCliff: join(root, "git-cliff") });
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe("intentionally unsupported manifest\n");
    expect(await readFile(join(root, "Cargo.lock"), "utf8")).toBe("fixed lock\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supports a manifest-free Go or build_type none repository", async () => {
  const root = await workspace();
  try { expect(await prepareRelease({ workspace: root, version: "2.0.0", gitCliff: join(root, "git-cliff") })).toBe("2.0.0"); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("passes git-cliff arguments as distinct no-exec arguments", async () => {
  const root = await workspace();
  try {
    const argsPath = join(root, "args");
    const executable = join(root, "git-cliff-capture");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, { mode: 0o755 });
    await prepareRelease({ workspace: root, version: "1.2.3", gitCliff: executable });
    expect(await readFile(argsPath, "utf8")).toBe("--no-exec\n--tag\nv1.2.3\n--output\nCHANGELOG.md\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("infers the version with the no-exec argument list", async () => {
  const root = await workspace();
  try {
    const argsPath = join(root, "args");
    const executable = join(root, "git-cliff-capture");
    await writeFile(executable, `#!/bin/sh\nprintf 'BEGIN\\n' >> '${argsPath}'\nprintf '%s\\n' "$@" >> '${argsPath}'\nprintf 'END\\n' >> '${argsPath}'\nif [ "$1" = "--bumped-version" ]; then echo v1.2.3; else printf 'generated\\n' > CHANGELOG.md; fi\n`, { mode: 0o755 });
    await prepareRelease({ workspace: root, gitCliff: executable });
    expect(await readFile(argsPath, "utf8")).toBe("BEGIN\n--bumped-version\n--no-exec\nEND\nBEGIN\n--no-exec\n--tag\nv1.2.3\n--output\nCHANGELOG.md\nEND\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const line of ["version: 1.0.0", "version: '1.0.0' # package", '"version" : "1.0.0"']) {
  test(`prepares a dbt manifest with ${line}`, async () => {
    const root = await workspace();
    try {
      const text = `name: sample\n${line}\nvars:\n  version: 2.0.0\n`;
      await writeFile(join(root, "dbt_project.yml"), text);
      await prepareRelease({ workspace: root, version: "2.0.0-rc.1+build", gitCliff: join(root, "git-cliff") });
      expect(await readFile(join(root, "dbt_project.yml"), "utf8")).toBe(text.replace("1.0.0", "2.0.0-rc.1+build"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

const dbtRejections = [
  { name: "malformed dbt YAML", text: "version: [", error: "dbt_project.yml must be valid YAML with unique keys" },
  { name: "duplicate dbt root versions", text: "version: 1.0.0\nversion: 2.0.0\n", error: "dbt_project.yml must be valid YAML with unique keys" },
  { name: "dbt YAML root is a sequence", text: "- version: 1.0.0\n", error: "dbt_project.yml must have one string root version" },
  { name: "missing dbt root version", text: "vars:\n  version: 1.0.0\n", error: "dbt_project.yml must have one string root version" },
  { name: "non-scalar dbt version", text: "version: [1.0.0]\n", error: "dbt_project.yml must have one string root version" },
  { name: "non-string dbt version", text: "version: 1\n", error: "dbt_project.yml must have one string root version" },
  { name: "alias dbt version", text: "base: &base 1.0.0\nversion: *base\n", error: "dbt_project.yml must have one string root version" },
  { name: "invalid dbt SemVer", text: "version: nope\n", error: "dbt_project.yml root version is not valid SemVer" },
  { name: "flow-style dbt version", text: "{version: 1.0.0, name: sample}\n", error: "dbt_project.yml root version must occupy its own supported version line" },
  { name: "single-quoted dbt version key", text: "'version': 1.0.0\n", error: "dbt_project.yml root version must occupy its own supported version line" },
  { name: "anchored dbt version", text: "version: &base 1.0.0\n", error: "dbt_project.yml root version must occupy its own supported version line" },
  { name: "tagged dbt version", text: "version: !!str 1.0.0\n", error: "dbt_project.yml root version must occupy its own supported version line" },
  { name: "escaped dbt version", text: 'version: "1.\\u0030.0"\n', error: "dbt_project.yml root version must occupy its own supported version line" },
];
const herdrPlugin = 'id = "plugin"\r\nversion = "0.1.0" # root\r\nplatforms = [\r\n  "macos", # first\r\n  "linux",\r\n]\r\n\r\n[[actions]]\r\nid = "login"\r\nversion = "9.0.0"\r\npattern = "^https://x\\\\.y/[a-z]+"\r\n';
test("prepares only the root herdr-plugin.toml version while preserving every other byte", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "herdr-plugin.toml"), herdrPlugin);
    await prepareRelease({ workspace: root, version: "2.0.0", versionFiles: ["herdr-plugin.toml"], gitCliff: join(root, "git-cliff") });
    expect(await readFile(join(root, "herdr-plugin.toml"), "utf8")).toBe(herdrPlugin.replace('"0.1.0"', '"2.0.0"'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const releaseFiles = { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', ".release-version": "1.0.0\n", "CHANGELOG.md": "existing changelog\n" };
const herdrRejections = [
  { name: "missing herdr root version", text: 'id = "x"\n[[actions]]\nversion = "1.0.0"\n', error: "herdr-plugin.toml must have exactly one version in the root table" },
  { name: "duplicate herdr root version", text: 'version = "1.0.0"\nversion = "1.0.0"\n', error: "herdr-plugin.toml must have exactly one version in the root table" },
  { name: "invalid herdr SemVer", text: 'version = "1.0"\n', error: "herdr-plugin.toml has an invalid version in the root table" },
  { name: "unsupported herdr version value", text: "version = 1\n", error: "herdr-plugin.toml has an unsupported version value in the root table" },
  { name: "herdr multiline string", text: 'version = "1.0.0"\ndescription = """\nx\n"""\n', error: "herdr-plugin.toml multiline TOML strings are not supported" },
  { name: "unterminated herdr string", text: 'version = "1.0.0"\nid = "x\n', error: "herdr-plugin.toml is not valid TOML" },
  { name: "unbalanced herdr array", text: 'version = "1.0.0"\nplatforms = ["macos"\n', error: "herdr-plugin.toml is not valid TOML" },
  { name: "unterminated herdr table header", text: 'version = "1.0.0"\n[[actions]\nid = "x"\n', error: "herdr-plugin.toml is not valid TOML" },
  { name: "herdr statement without a value", text: 'version = "1.0.0"\nid\n', error: "herdr-plugin.toml is not valid TOML" },
];
const invalidFiles = ["package.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "dbt_project.yml", ".release-version", "CHANGELOG.md"];
const rejections: Array<{ name: string; files?: Record<string, string>; version?: string; versionFiles?: string[]; error: string; workspaceKind?: "missing" | "file" | "symlink" }> = [
  { name: "unsupported version file", version: "1.2.3", versionFiles: ["README.md"], files: { "README.md": 'version = "1.0.0"\n' }, error: 'version file "README.md" is not supported' },
  { name: "nested version file path", version: "1.2.3", versionFiles: ["sub/Cargo.toml"], error: 'version file "sub/Cargo.toml" is not supported' },
  { name: "duplicate version file", version: "1.2.3", versionFiles: ["Cargo.toml", "Cargo.toml"], files: releaseFiles, error: 'version file "Cargo.toml" is listed more than once' },
  { name: "Cargo.lock without Cargo.toml", version: "1.2.3", versionFiles: ["Cargo.lock"], files: { "Cargo.lock": '[[package]]\nname="x"\nversion="1.0.0"\n' }, error: 'version file "Cargo.lock" requires "Cargo.toml"' },
  { name: "absent version file", version: "1.2.3", versionFiles: ["Cargo.toml", "herdr-plugin.toml"], files: releaseFiles, error: 'version file "herdr-plugin.toml" does not exist' },
  { name: "listed version file is a symlink", version: "1.2.3", versionFiles: ["herdr-plugin.toml"], files: { "symlink:herdr-plugin.toml": "outside" }, error: "herdr-plugin.toml must be a regular file" },
  { name: "listed manifest lacks a root version", version: "1.2.3", versionFiles: ["package.json"], files: { "package.json": '{\n  "name": "x"\n}\n' }, error: "package.json must have one string root version" },
  ...herdrRejections.map(({ name, text, error }) => ({ name, error, version: "1.2.3", versionFiles: ["Cargo.toml", "herdr-plugin.toml"], files: { ...releaseFiles, "herdr-plugin.toml": text } })),
  { name: "missing workspace", error: "workspace must be a regular directory", workspaceKind: "missing" },
  { name: "workspace is a file", error: "workspace must be a regular directory", workspaceKind: "file" },
  { name: "workspace is a symlink", error: "workspace must be a regular directory", workspaceKind: "symlink" },
  { name: "invalid explicit SemVer", version: "v01.2.3", error: 'version "v01.2.3" is not valid SemVer' },
  { name: "invalid inferred SemVer", error: 'version "nope" is not valid SemVer', files: { "git-cliff": "#!/bin/sh\necho nope\n" } },
  { name: "malformed package JSON", files: { "package.json": "{" }, version: "1.2.3", error: "package.json is not valid JSON" },
  { name: "package JSON root is not an object", files: { "package.json": "[]" }, version: "1.2.3", error: "package.json must be a JSON object" },
  { name: "missing package root version", files: { "package.json": '{"name":"x"}' }, version: "1.2.3", error: "package.json must have one string root version" },
  { name: "non-string package root version", files: { "package.json": '{\n  "version": 1\n}\n' }, version: "1.2.3", error: "package.json must have one string root version" },
  { name: "invalid package root version", files: { "package.json": '{\n  "version": "nope"\n}\n' }, version: "1.2.3", error: "package.json root version is not valid SemVer" },
  { name: "package root version shares a line", files: { "package.json": '{"name":"x", "version":"1.0.0"}' }, version: "1.2.3", error: "package.json root version must occupy its own line" },
  { name: "minified package JSON", files: { "package.json": '{"version":"1.0.0"}' }, version: "1.2.3", error: "package.json root version must occupy its own line" },
  { name: "duplicate package root version", files: { "package.json": '{\n  "version": "1.0.0",\n  "version": "2.0.0"\n}\n' }, version: "1.2.3", error: "package.json must have one string root version" },
  { name: "duplicate identical package root versions", files: { "package.json": '{\n  "version": "1.0.0",\n  "version": "1.0.0"\n}\n' }, version: "1.2.3", error: "package.json must have one string root version" },
  { name: "nested version without root version", files: { "package.json": '{\n  "dependencies": {\n    "version": "1.0.0"\n  }\n}\n' }, version: "1.2.3", error: "package.json must have one string root version" },
  { name: "Cargo package name is ambiguous", files: { "Cargo.toml": '[package]\nname="x"\nname="y"\nversion="1.0.0"\n' }, version: "1.2.3", error: "Cargo.toml must have exactly one package name in [package]" },
  { name: "Cargo package version is missing", files: { "Cargo.toml": '[package]\nname="x"\n' }, version: "1.2.3", error: "Cargo.toml must have exactly one version in [package]" },
  { name: "Cargo package version is unsupported", files: { "Cargo.toml": '[package]\nname="x"\nversion = { workspace = true }\n' }, version: "1.2.3", error: "Cargo.toml has an unsupported version value in [package]" },
  { name: "Cargo package version is invalid", files: { "Cargo.toml": '[package]\nname="x"\nversion="nope"\n' }, version: "1.2.3", error: "Cargo.toml has an invalid version in [package]" },
  { name: "pyproject project version is missing", files: { "pyproject.toml": '[project]\nname="x"\n' }, version: "1.2.3", error: "pyproject.toml must have exactly one version in [project]" },
  { name: "pyproject multiline basic string contains a fake version", files: { "pyproject.toml": '[project]\nname="x"\ndynamic=["version"]\ndescription="""\nversion="1.0.0"\n"""\n' }, version: "1.2.3", error: "pyproject.toml multiline TOML strings are not supported" },
  { name: "Cargo multiline literal string contains a fake version", files: { "Cargo.toml": "[package]\nname=\"x\"\nversion.workspace=true\ndescription='''\nversion=\"1.0.0\"\n'''\n" }, version: "1.2.3", error: "Cargo.toml multiline TOML strings are not supported" },
  { name: "pyproject project version is unsupported", files: { "pyproject.toml": '[project]\nversion = { dynamic = true }\n' }, version: "1.2.3", error: "pyproject.toml has an unsupported version value in [project]" },
  { name: "pyproject project version is invalid", files: { "pyproject.toml": '[project]\nversion="nope"\n' }, version: "1.2.3", error: "pyproject.toml has an invalid version in [project]" },
  { name: "Cargo lock has no root package", files: { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', "Cargo.lock": '[[package]]\nname="other"\nversion="1.0.0"\n' }, version: "1.2.3", error: 'Cargo.lock must have exactly one root package named "x"' },
  { name: "Cargo lock root package is ambiguous", files: { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', "Cargo.lock": '[[package]]\nname="x"\nversion="1.0.0"\n\n[[package]]\nname="x"\nversion="1.0.0"\n' }, version: "1.2.3", error: 'Cargo.lock must have exactly one root package named "x"' },
  { name: "Cargo lock root version is missing", files: { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', "Cargo.lock": '[[package]]\nname="x"\n' }, version: "1.2.3", error: 'Cargo.lock package "x" must have exactly one version' },
  { name: "Cargo lock root version is ambiguous", files: { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', "Cargo.lock": '[[package]]\nname="x"\nversion="1.0.0"\nversion="2.0.0"\n' }, version: "1.2.3", error: 'Cargo.lock package "x" must have exactly one version' },
  { name: "Cargo lock root version is invalid", files: { "Cargo.toml": '[package]\nname="x"\nversion="1.0.0"\n', "Cargo.lock": '[[package]]\nname="x"\nversion="nope"\n' }, version: "1.2.3", error: 'Cargo.lock package "x" has an invalid version' },
  ...dbtRejections.map(({ name, text, error }) => ({ name, error, version: "1.2.3", files: { "dbt_project.yml": text, "pyproject.toml": '[project]\nversion = "1.0.0"\n', ".release-version": "1.0.0\n", "CHANGELOG.md": "existing changelog\n" } })),
  ...invalidFiles.map((path) => ({ name: `${path} is a symlink`, files: { [`symlink:${path}`]: "outside" }, version: "1.2.3", error: `${path} must be a regular file` })),
];

for (const rejection of rejections) {
  test(`rejects ${rejection.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "release-pr-case-"));
    const workspacePath = join(root, "workspace");
    try {
      if (rejection.workspaceKind === "missing") {
        await expect(prepareRelease({ workspace: workspacePath, version: rejection.version ?? "1.2.3", gitCliff: join(root, "git-cliff") })).rejects.toThrow(rejection.error);
        return;
      }
      await mkdir(workspacePath);
      if (rejection.workspaceKind === "file") {
        const file = join(root, "file");
        await writeFile(file, "x");
        await expect(prepareRelease({ workspace: file, version: "1.2.3", gitCliff: join(root, "git-cliff") })).rejects.toThrow(rejection.error);
        return;
      }
      if (rejection.workspaceKind === "symlink") {
        const link = join(root, "link");
        await symlink(workspacePath, link);
        await expect(prepareRelease({ workspace: link, version: "1.2.3", gitCliff: join(root, "git-cliff") })).rejects.toThrow(rejection.error);
        return;
      }
      for (const [path, content] of Object.entries(rejection.files ?? {})) {
        if (path.startsWith("symlink:")) await symlink(content, join(workspacePath, path.slice("symlink:".length)));
        else await writeFile(join(workspacePath, path), content, { mode: path === "git-cliff" ? 0o755 : undefined });
      }
      await expect(prepareRelease({ workspace: workspacePath, gitCliff: join(workspacePath, "git-cliff"), ...(rejection.version ? { version: rejection.version } : {}), ...(rejection.versionFiles ? { versionFiles: rejection.versionFiles } : {}) })).rejects.toThrow(rejection.error);
      for (const [path, content] of Object.entries(rejection.files ?? {})) {
        if (!path.startsWith("symlink:")) expect(await readFile(join(workspacePath, path), "utf8")).toBe(content);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("CLI reports a git-cliff failure as a failed action", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "git-cliff"), "#!/bin/sh\necho deliberate-failure >&2\nexit 23\n", { mode: 0o755 });
    const env = { ...process.env, INPUT_WORKSPACE: root, RUNNER_TEMP: root };
    const result = await execFile(process.execPath, ["run", await cliEntry(root)], { cwd: process.cwd(), env }).then(
      (output) => ({ code: 0, stdout: output.stdout, stderr: output.stderr }),
      (error: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => ({ code: Number(error.code), stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain("deliberate-failure");
    expect(result.stderr + result.stdout).toContain("::error::");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  ["", true, undefined],
  ["[]", false, undefined],
  ['["Cargo.toml"]', true, undefined],
  ['["pyproject.toml"]', false, 'version file "pyproject.toml" does not exist'],
  ["Cargo.toml", false, "version-files must be a JSON array of strings"],
  ['{"files":["Cargo.toml"]}', false, "version-files must be a JSON array of strings"],
  ["[1]", false, "version-files must be a JSON array of strings"],
])("CLI handles version-files=%s", async (value, updated, error) => {
  const root = await workspace();
  const original = '[package]\nname = "sample"\nversion = "0.1.0"\n';
  try {
    await writeFile(join(root, "Cargo.toml"), original);
    const env = { ...process.env, INPUT_WORKSPACE: root, INPUT_VERSION: "2.0.0", "INPUT_VERSION-FILES": value, RUNNER_TEMP: root };
    const result = Bun.spawnSync([process.execPath, "run", await cliEntry(root)], { cwd: process.cwd(), env });
    expect(result.exitCode).toBe(error ? 1 : 0);
    if (error) expect(result.stdout.toString()).toContain(`::error::${error}`);
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(updated ? original.replace("0.1.0", "2.0.0") : original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  ["missing runner temp", { RUNNER_TEMP: "" }, "RUNNER_TEMP is required to install git-cliff"],
  ["Windows runner", { RUNNER_OS: "Windows", RUNNER_ARCH: "X64" }, "git-cliff installation does not support runner platform Windows/X64; supported: Linux/X64, Linux/ARM64, macOS/X64, macOS/ARM64"],
])("the action entry installs git-cliff before preparing and fails closed on a %s", async (_name, runner, message) => {
  const root = await workspace();
  try {
    const env = { ...process.env, INPUT_WORKSPACE: root, INPUT_VERSION: "2.0.0", RUNNER_TEMP: root, ...runner };
    const result = Bun.spawnSync([process.execPath, "run", "src/client-release-prepare/main.ts"], { cwd: process.cwd(), env });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(`::error::${message}`);
    expect(await readdir(root)).toEqual(["git-cliff"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
