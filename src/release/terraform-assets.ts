import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Rejection } from "../lib/request.ts";
import { ensure } from "./ensure.ts";
import { parseStrictJson, type StrictJson } from "./strict-json.ts";
import { openZip } from "./zip-reader.ts";

export const TARGETS = [
  "darwin_amd64", "darwin_arm64", "freebsd_386", "freebsd_amd64",
  "freebsd_arm", "freebsd_arm64", "linux_386", "linux_amd64",
  "linux_arm", "linux_arm64", "windows_386", "windows_amd64", "windows_arm64",
] as const;
const VERSION = String.raw`(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?`;

/** Runs gpg with the given arguments and optional stdin; replaceable so tests never need real keys. */
export type Gpg = (home: string, args: string[], data?: Buffer) => Buffer;

const regular = (path: string) => ensure(lstatSync(path).isFile(), `Terraform asset ${quote(basename(path))} is not a regular file`);
const sorted = (names: Iterable<string>) => [...names].sort();
const quote = (name: string) => `'${name}'`;

class DuplicateKeys extends Rejection {
  constructor() { super("Terraform manifest has duplicate keys"); }
}

function parseManifest(path: string): StrictJson {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    return parseStrictJson(text, () => { throw new DuplicateKeys(); });
  } catch (error) {
    ensure(error instanceof DuplicateKeys, "Terraform manifest is not valid JSON");
    throw error;
  }
}

function exactManifest(metadata: StrictJson): boolean {
  if (!(metadata instanceof Map) || metadata.size !== 2) return false;
  const version = metadata.get("version");
  const inner = metadata.get("metadata");
  if (typeof version !== "object" || version === null || Array.isArray(version) || version instanceof Map || version.number !== "1") return false;
  if (!(inner instanceof Map) || inner.size !== 1) return false;
  const protocols = inner.get("protocol_versions");
  return Array.isArray(protocols) && protocols.length === 1 && protocols[0] === "6.0";
}

export function validate(directory: string, name: string, version: string, signed: boolean) {
  ensure(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64, "invalid Terraform provider name");
  ensure(new RegExp(`^${VERSION}$`, "u").test(version), "invalid Terraform provider version or build metadata");
  const prefix = `terraform-provider-${name}_${version}`;
  const archives = TARGETS.map((target) => `${prefix}_${target}.zip`);
  const manifestName = `${prefix}_manifest.json`;
  const sumsName = `${prefix}_SHA256SUMS`;
  const sourceManifest = "terraform-registry-manifest.json";
  const actual = new Set(readdirSync(directory));
  actual.delete("SHA256SUMS");
  const manifests = [sourceManifest, manifestName].filter((candidate) => actual.has(candidate));
  ensure(manifests.length === 1, "Terraform assets must contain exactly one Registry manifest");
  const selectedManifest = signed ? manifestName : manifests[0]!;
  const expected = new Set([...archives, selectedManifest]);
  const allowed = new Set([...expected, sumsName, `${sumsName}.sig`]);
  if (signed) for (const name of [sumsName, `${sumsName}.sig`]) expected.add(name);
  const missing = sorted([...expected].filter((candidate) => !actual.has(candidate)));
  const unexpected = sorted([...actual].filter((candidate) => !allowed.has(candidate)));
  ensure(missing.length === 0 && unexpected.length === 0,
    `Terraform asset set differs: missing=[${missing.map(quote).join(", ")}], unexpected=[${unexpected.map(quote).join(", ")}]`);
  for (const filename of actual) regular(join(directory, filename));
  const manifest = join(directory, selectedManifest);
  ensure(exactManifest(parseManifest(manifest)), "Terraform manifest must declare exactly version 1 and protocol 6.0");
  archives.forEach((filename, index) => {
    const target = TARGETS[index]!;
    const binary = `terraform-provider-${name}_v${version}${target.startsWith("windows_") ? ".exe" : ""}`;
    const permitted = new Set([binary, "LICENSE", "README.md", "CHANGELOG.md"]);
    const label = quote(filename);
    let entries;
    try {
      entries = openZip(join(directory, filename));
    } catch {
      return ensure(false, `Terraform archive ${label} is invalid`);
    }
    const names = entries.map((entry) => entry.name);
    ensure(names.length === new Set(names).size, `Terraform archive ${label} has duplicate entries`);
    ensure(names.includes(binary), `Terraform archive ${label} is missing its binary`);
    for (const entry of entries) {
      ensure(!entry.name.endsWith("/") && !(entry.externalAttributes & 0x10) && !entry.name.includes("/") && !entry.name.includes("\\"),
        `Terraform archive ${label} has a path or directory entry`);
      ensure(entry.originalName === entry.name && permitted.has(entry.name), `Terraform archive ${label} has an unexpected entry`);
      ensure(!(entry.flags & 1), `Terraform archive ${label} has an encrypted entry`);
      const format = (entry.externalAttributes >>> 16) & 0o170000;
      ensure(format === 0 || format === 0o100000, `Terraform archive ${label} has a non-regular entry`);
      ensure(entry.name !== binary || entry.size > 0, `Terraform archive ${label} has an empty binary`);
      try {
        entry.read();
      } catch {
        ensure(false, `Terraform archive ${label} is invalid`);
      }
    }
  });
  return { archives, manifestName, sumsName, manifest };
}

export function checksumContent(directory: string, names: string[]): Buffer {
  const lines = sorted(names).map((name) => `${createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")}  ${name}\n`);
  return Buffer.from(lines.join(""));
}

export function writeMatching(path: string, content: Buffer): void {
  let exists = true;
  try { lstatSync(path); } catch { exists = false; }
  if (exists) {
    regular(path);
    ensure(readFileSync(path).equals(content), `Terraform asset ${quote(basename(path))} does not match its expected content`);
    return;
  }
  // A crash must not leave a partially written checksum or signature in assets/.
  const temporary = join(dirname(dirname(path)), `.${basename(path)}.${process.pid}.${Date.now().toString(36)}`);
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(file, content);
    fsyncSync(file);
    linkSync(temporary, path);
  } finally {
    closeSync(file);
    unlinkSync(temporary);
  }
}

export const gpg: Gpg = (home, args, data) => {
  // Do not pass the action's credentials to gpg's environment or diagnostics.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "SYSTEMROOT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync("gpg", ["--no-options", "--homedir", home, "--batch", "--no-tty",
    "--no-auto-key-retrieve", "--no-auto-check-trustdb", ...args], { input: data ?? Buffer.alloc(0), env, stdio: ["pipe", "pipe", "pipe"] });
  ensure(result.status === 0, "Terraform GPG operation failed");
  return result.stdout;
};

export function primaryKey(home: string, fingerprint: string, secret = false, run: Gpg = gpg): void {
  const listing = run(home, ["--with-colons", "--fixed-list-mode", "--fingerprint", secret ? "--list-secret-keys" : "--list-keys"]).toString().split(/\r?\n/u);
  const primary: [string, string[]][] = [];
  let pending: string[] | undefined;
  for (const row of listing) {
    const fields = row.split(":");
    if (fields[0] === "pub" || fields[0] === "sec") pending = fields;
    else if (fields[0] === "sub" || fields[0] === "ssb") pending = undefined;
    else if (fields[0] === "fpr" && pending !== undefined) {
      primary.push([fields[9] ?? "", pending]);
      pending = undefined;
    }
  }
  ensure(primary.length === 1 && primary[0]![0] === fingerprint, "Terraform imported key set does not match the configured primary fingerprint");
  const fields = primary[0]![1];
  ensure(["1", "3"].includes(fields[3] ?? "") && (fields[11] ?? "").includes("s") && !["r", "e", "d"].includes(fields[1] ?? ""),
    "Terraform signing key must be an active primary RSA signing key");
}

export function verifySignature(home: string, directory: string, sumsName: string, fingerprint: string, epoch: string, run: Gpg = gpg): void {
  const output = run(home, ["--status-fd", "1", "--verify", join(directory, `${sumsName}.sig`), join(directory, sumsName)]).toString().split(/\r?\n/u);
  const prefix = "[GNUPG:] ";
  const signatures = output.filter((row) => row.startsWith(`${prefix}VALIDSIG `)).map((row) => row.slice(prefix.length).split(/\s+/u).filter(Boolean));
  const [signature] = signatures;
  ensure(signatures.length === 1 && signature !== undefined && signature.length >= 10 && signature[1] === fingerprint
    && signature[3] === epoch && ["1", "3"].includes(signature[7]!) && signature[8] === "8",
  "Terraform detached signature does not match the primary fingerprint, source timestamp and SHA256");
}

export type Credentials = { key?: string; passphrase?: string };

export function processAssets(mode: string, directory: string, name: string, version: string, epoch: string, fingerprint: string,
  credentials: Credentials, run: Gpg = gpg): string {
  ensure(mode === "prepare" || mode === "verify", "invalid Terraform asset mode");
  ensure(/^[A-F0-9]{40}$/u.test(fingerprint), "Terraform GPG fingerprint must be 40 uppercase hexadecimal characters");
  ensure(/^[1-9][0-9]{0,10}$/u.test(epoch), "invalid Terraform source timestamp");
  ensure(credentials.key, "Terraform GPG key is required");
  if (mode === "prepare") ensure(credentials.passphrase, "Terraform GPG passphrase is required");
  const { archives, manifestName, sumsName, manifest } = validate(directory, name, version, mode === "verify");
  const home = mkdtempSync(join(tmpdir(), "csm-ci-terraform-gpg-"));
  try {
    run(home, ["--import"], Buffer.from(credentials.key));
    primaryKey(home, fingerprint, false, run);
    if (mode === "prepare") primaryKey(home, fingerprint, true, run);
    if (basename(manifest) !== manifestName) renameSync(manifest, join(directory, manifestName));
    const expectedSums = checksumContent(directory, [...archives, manifestName]);
    if (mode === "prepare") {
      writeMatching(join(directory, sumsName), expectedSums);
      const signature = join(home, "signature");
      run(home, ["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--faked-system-time", `${epoch}!`,
        "--digest-algo", "SHA256", "--local-user", `${fingerprint}!`, "--output", signature,
        "--detach-sign", join(directory, sumsName)], Buffer.from(credentials.passphrase!));
      writeMatching(join(directory, `${sumsName}.sig`), readFileSync(signature));
    }
    ensure(readFileSync(join(directory, sumsName)).equals(expectedSums), "Terraform Registry checksums do not match the assets");
    verifySignature(home, directory, sumsName, fingerprint, epoch, run);
    return run(home, ["--armor", "--export", fingerprint]).toString();
  } finally {
    spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
  }
}
