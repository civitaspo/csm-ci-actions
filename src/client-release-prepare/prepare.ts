import { execFile as callbackExecFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { parseSemVer } from "../release/semver.ts";
import { DEFAULT_VERSION_FILES, versionFilesError } from "../release/version-files.ts";

const execFile = promisify(callbackExecFile);
const VERSION_LINE = /^\s*"?version"?\s*[=:]/u;

export async function prepareRelease(input: { workspace: string; version?: string; gitCliff: string; versionFiles?: readonly string[] }): Promise<string> {
  const workspaceInfo = await lstat(input.workspace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!workspaceInfo?.isDirectory()) throw new Error("workspace must be a regular directory");

  let version = input.version;
  if (version === undefined) {
    const result = await execFile(input.gitCliff, ["--bumped-version", "--no-exec"], { cwd: input.workspace });
    version = result.stdout.trim();
    if (version.startsWith("v")) version = version.slice(1);
  }
  if (!parseSemVer(version)) throw new Error(`version ${JSON.stringify(version)} is not valid SemVer`);

  for (const path of [".release-version", "CHANGELOG.md"]) await assertWritableFile(input.workspace, path);

  // An omitted list updates the default files that exist; an explicit list must name existing supported files.
  const explicit = input.versionFiles !== undefined;
  const invalid = explicit ? versionFilesError(input.versionFiles ?? []) : undefined;
  if (invalid) throw new Error(invalid);
  const originals = new Map<string, string>();
  for (const path of input.versionFiles ?? DEFAULT_VERSION_FILES) {
    const content = await readOptional(input.workspace, path);
    if (content !== undefined) originals.set(path, content);
    else if (explicit) throw new Error(`version file ${JSON.stringify(path)} does not exist`);
  }

  const changes = new Map<string, string>();
  const packageJson = originals.get("package.json");
  if (packageJson !== undefined) changes.set("package.json", replaceJsonVersion(packageJson, version));
  const cargo = originals.get("Cargo.toml");
  let cargoPackage: { name: string; version: string } | undefined;
  if (cargo !== undefined) {
    const prepared = replaceTomlVersion(cargo, "package", version, "Cargo.toml");
    changes.set("Cargo.toml", prepared.text);
    cargoPackage = { name: readCargoPackageName(cargo), version: prepared.currentVersion };
  }
  const lock = originals.get("Cargo.lock");
  if (lock !== undefined && cargoPackage !== undefined) changes.set("Cargo.lock", replaceCargoLockVersion(lock, cargoPackage.name, cargoPackage.version, version));
  const pyproject = originals.get("pyproject.toml");
  if (pyproject !== undefined) changes.set("pyproject.toml", replaceTomlVersion(pyproject, "project", version, "pyproject.toml").text);
  const dbt = originals.get("dbt_project.yml");
  if (dbt !== undefined) changes.set("dbt_project.yml", replaceDbtVersion(dbt, version));
  const herdr = originals.get("herdr-plugin.toml");
  if (herdr !== undefined) changes.set("herdr-plugin.toml", replaceHerdrPluginVersion(herdr, version));

  for (const [path, text] of changes) await writeFile(join(input.workspace, path), text);
  await writeFile(join(input.workspace, ".release-version"), `${version}\n`);
  await execFile(input.gitCliff, ["--no-exec", "--tag", `v${version}`, "--output", "CHANGELOG.md"], { cwd: input.workspace });
  return version;
}

async function readOptional(root: string, path: string): Promise<string | undefined> {
  const absolute = join(root, path);
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (!info.isFile()) throw new Error(`${path} must be a regular file`);
  return readFile(absolute, "utf8");
}

async function assertWritableFile(root: string, path: string): Promise<void> {
  const info = await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info && !info.isFile()) throw new Error(`${path} must be a regular file`);
}

function replaceJsonVersion(text: string, version: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("package.json is not valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json must be a JSON object");
  const currentVersion: unknown = Reflect.get(parsed, "version");
  if (!Object.hasOwn(parsed, "version") || typeof currentVersion !== "string") throw new Error("package.json must have one string root version");
  const candidates = rootJsonStringProperties(text, "version");
  if (candidates.length !== 1) throw new Error("package.json must have one string root version");
  const candidate = candidates[0];
  if (!candidate) throw new Error("package.json must have one string root version");
  const lineStart = text.lastIndexOf("\n", candidate.keyStart - 1) + 1;
  const lineEndIndex = text.indexOf("\n", candidate.valueEnd);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  if (!/^\s*"version"\s*:\s*"[^"\r\n]*"\s*,?\s*$/u.test(line)) {
    throw new Error("package.json root version must occupy its own line");
  }
  if (candidate.value !== currentVersion) throw new Error("package.json must have one string root version");
  if (!parseSemVer(candidate.value)) throw new Error("package.json root version is not valid SemVer");
  return text.slice(0, candidate.valueStart) + version + text.slice(candidate.valueEnd);
}

function replaceDbtVersion(text: string, version: string): string {
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new Error("dbt_project.yml must be valid YAML with unique keys");
  const current = isMap(document.contents) ? document.get("version", true) : undefined;
  if (!isScalar(current) || typeof current.value !== "string" || !current.range) {
    throw new Error("dbt_project.yml must have one string root version");
  }
  if (!parseSemVer(current.value)) throw new Error("dbt_project.yml root version is not valid SemVer");
  const start = text.lastIndexOf("\n", current.range[0] - 1) + 1;
  const newline = text.indexOf("\n", current.range[0]);
  const end = newline < 0 ? text.length : newline;
  const line = text.slice(start, end);
  const match = /^([ \t]*"?version"?[ \t]*:[ \t]*)(["']?)([^"' \t\r\n#]+)\2([ \t]*(?:#.*)?\r?)$/u.exec(line);
  if (!match || match[3] !== current.value) throw new Error("dbt_project.yml root version must occupy its own supported version line");
  return text.slice(0, start) + `${match[1]}${match[2]}${version}${match[2]}${match[4]}` + text.slice(end);
}

type JsonStringProperty = { keyStart: number; valueStart: number; valueEnd: number; value: string };

function rootJsonStringProperties(text: string, wantedKey: string): JsonStringProperty[] {
  const found: JsonStringProperty[] = [];
  let depth = 0;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '"') {
      const end = jsonStringEnd(text, index);
      if (depth === 1) {
        const key = JSON.parse(text.slice(index, end)) as string;
        let colon = end;
        while (/\s/u.test(text[colon] ?? "")) colon++;
        if (text[colon] === ":" && key === wantedKey) {
          let valueStart = colon + 1;
          while (/\s/u.test(text[valueStart] ?? "")) valueStart++;
          if (text[valueStart] === '"') {
            const valueEnd = jsonStringEnd(text, valueStart);
            found.push({ keyStart: index, valueStart: valueStart + 1, valueEnd: valueEnd - 1, value: JSON.parse(text.slice(valueStart, valueEnd)) as string });
          } else found.push({ keyStart: index, valueStart, valueEnd: valueStart, value: "" });
        }
      }
      index = end;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") depth--;
    index++;
  }
  return found;
}

function jsonStringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
  }
  throw new Error("package.json is not valid JSON");
}

// An empty section selects the root table, before the first table header.
function replaceTomlVersion(text: string, section: string, version: string, path: string): { text: string; currentVersion: string } {
  if (text.includes('"""') || text.includes("'''")) throw new Error(`${path} multiline TOML strings are not supported`);
  const lines = text.split(/(?<=\n)/u);
  const table = section === "" ? "the root table" : `[${section}]`;
  let active = section === "";
  let found = 0;
  let currentVersion = "";
  const output = lines.map((line) => {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?(?:\r?\n)?$/u.exec(line);
    if (header) active = header[1] === `[${section}]`;
    if (!active || !VERSION_LINE.test(line)) return line;
    found++;
    const match = /^(\s*"?version"?\s*=\s*)(['"])([^'"\r\n]*)(['"])(\s*(?:#.*)?(?:\r?\n)?)$/u.exec(line);
    if (!match || match[2] !== match[4]) throw new Error(`${path} has an unsupported version value in ${table}`);
    if (!parseSemVer(match[3] ?? "")) throw new Error(`${path} has an invalid version in ${table}`);
    currentVersion = match[3] ?? "";
    return `${match[1]}${match[2]}${version}${match[4]}${match[5]}`;
  }).join("");
  if (found !== 1) throw new Error(`${path} must have exactly one version in ${table}`);
  return { text: output, currentVersion };
}

function replaceHerdrPluginVersion(text: string, version: string): string {
  const prepared = replaceTomlVersion(text, "", version, "herdr-plugin.toml").text;
  assertTomlStatements(text, "herdr-plugin.toml");
  return prepared;
}

// Conservative TOML shape check: every top-level statement is a table header or a key/value pair.
function assertTomlStatements(text: string, path: string): void {
  const malformed = () => new Error(`${path} is not valid TOML`);
  const statements: string[] = [];
  const closers: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") {
      let end = index + 1;
      for (; end < text.length && text[end] !== char; end++) {
        if (text[end] === "\n") throw malformed();
        if (char === '"' && text[end] === "\\") end++;
      }
      if (end >= text.length) throw malformed();
      current += "S";
      index = end;
      continue;
    }
    if (char === "#") {
      while (index + 1 < text.length && text[index + 1] !== "\n") index++;
      continue;
    }
    if (char === "[" || char === "{") closers.push(char === "[" ? "]" : "}");
    else if ((char === "]" || char === "}") && closers.pop() !== char) throw malformed();
    if (char === "\n" && closers.length === 0) {
      statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (closers.length > 0) throw malformed();
  statements.push(current.trim());
  const key = String.raw`(?:[A-Za-z0-9_-]+|S)(?:\s*\.\s*(?:[A-Za-z0-9_-]+|S))*`;
  const statement = new RegExp(String.raw`^(?:\[\s*${key}\s*\]|\[\[\s*${key}\s*\]\]|${key}\s*=\s*\S.*)$`, "su");
  for (const line of statements) if (line !== "" && !statement.test(line)) throw malformed();
}

function readCargoPackageName(text: string): string {
  let active = false;
  let name: string | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?(?:\r?\n)?$/u.exec(line);
    if (header) active = header[1] === "[package]";
    if (!active) continue;
    const nameMatch = /^\s*name\s*=\s*(["'])([^"'\r\n]+)\1\s*(?:#.*)?(?:\r?\n)?$/u.exec(line);
    if (nameMatch) {
      if (name !== undefined) throw new Error("Cargo.toml must have exactly one package name in [package]");
      name = nameMatch[2];
    }
  }
  if (name === undefined) throw new Error("Cargo.toml must have exactly one package name in [package]");
  return name;
}

function replaceCargoLockVersion(text: string, name: string, currentVersion: string, version: string): string {
  const blocks = text.split(/(?=^\s*\[\[package\]\]\s*$)/mu);
  let found = 0;
  const output = blocks.map((block) => {
    const names = [...block.matchAll(/^\s*name\s*=\s*"([^"\r\n]+)"\s*$/gmu)];
    if (names.length !== 1 || names[0]?.[1] !== name) return block;
    if (/^\s*source\s*=/mu.test(block)) return block;
    const versions = [...block.matchAll(/^([ \t]*version[ \t]*=[ \t]*)(["'])([^"'\r\n]*)(["'])([ \t]*\r?\n?)/gmu)];
    if (versions.length !== 1) throw new Error(`Cargo.lock package ${JSON.stringify(name)} must have exactly one version`);
    const match = versions[0];
    if (!match || match[2] !== match[4]) throw new Error(`Cargo.lock package ${JSON.stringify(name)} has an invalid version`);
    if (!parseSemVer(match[3] ?? "")) throw new Error(`Cargo.lock package ${JSON.stringify(name)} has an invalid version`);
    if (match[3] !== currentVersion) return block;
    found++;
    return block.slice(0, match.index) + `${match[1]}${match[2]}${version}${match[4]}${match[5]}` + block.slice(match.index + match[0].length);
  });
  if (found !== 1) throw new Error(`Cargo.lock must have exactly one root package named ${JSON.stringify(name)}`);
  return output.join("");
}
