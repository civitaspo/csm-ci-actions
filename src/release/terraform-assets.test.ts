import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TARGETS, checksumContent, gpg, primaryKey, processAssets, validate, verifySignature, writeMatching, type Gpg } from "./terraform-assets.ts";

const FINGERPRINT = "A".repeat(40);
const EPOCH = "1800000000";
const VERSION = "1.2.3";
const PREFIX = "terraform-provider-test_1.2.3";
const MANIFEST = Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0"]}}\n');
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;

type Member = { name: string; content: Buffer | string; mode: number };

function zip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, content, mode } of members) {
    const raw = Buffer.from(name, "utf8");
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(raw.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    local.copy(central, 16, 14, 30);
    central.writeUInt16LE(raw.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, raw, packed);
    centrals.push(central, raw);
    offset += local.length + raw.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let temporary: string;
let directory: string;

function archive(target = "darwin_amd64", additions: Member[] = [], { missing = false, empty = false } = {}): string {
  const binary = `terraform-provider-test_v${VERSION}` + (target.startsWith("windows_") ? ".exe" : "");
  const members: Member[] = missing ? [] : [{ name: binary, content: empty ? "" : "provider binary", mode: S_IFREG | 0o755 }];
  const path = join(directory, `${PREFIX}_${target}.zip`);
  writeFileSync(path, zip([...members, ...additions]));
  return path;
}
const doc = (name: string, mode = S_IFREG | 0o644): Member => ({ name, content: "document", mode });
const check = (signed = false) => validate(directory, "test", VERSION, signed);

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "terraform-assets-"));
  directory = join(temporary, "assets");
  mkdirSync(directory);
  for (const target of TARGETS) archive(target);
  writeFileSync(join(directory, "terraform-registry-manifest.json"), MANIFEST);
});
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

describe("Terraform Registry asset validation", () => {
  test("preserves all thirteen archive contracts and the manifest bytes", () => {
    for (const target of TARGETS) archive(target, ["README.md", "LICENSE", "CHANGELOG.md"].map((name) => doc(name)));
    const { archives, manifestName, sumsName, manifest } = check();
    expect(archives).toHaveLength(13);
    expect(readFileSync(manifest)).toEqual(MANIFEST);
    expect(manifestName).toBe(`${PREFIX}_manifest.json`);
    expect(sumsName).toBe(`${PREFIX}_SHA256SUMS`);
  });

  test.each<[string, Member[], { missing?: boolean; empty?: boolean }, string]>([
    ["missing binary", [], { missing: true }, "is missing its binary"],
    ["empty binary", [], { empty: true }, "has an empty binary"],
    ["unexpected entry", [{ name: "extra", content: "x", mode: S_IFREG }], {}, "has an unexpected entry"],
    ["path", [{ name: "../README.md", content: "x", mode: S_IFREG }], {}, "has a path or directory entry"],
    ["backslash", [{ name: "a\\README.md", content: "x", mode: S_IFREG }], {}, "has a path or directory entry"],
    ["directory", [{ name: "folder/", content: "", mode: S_IFDIR }], {}, "has a path or directory entry"],
    ["symlink", [{ name: "README.md", content: "target", mode: S_IFLNK }], {}, "has a non-regular entry"],
    ["device", [{ name: "README.md", content: "x", mode: S_IFCHR }], {}, "has a non-regular entry"],
    ["duplicate", [{ name: "terraform-provider-test_v1.2.3", content: "x", mode: S_IFREG }], {}, "has duplicate entries"],
    ["NUL", [{ name: "README.md\0ignored", content: "x", mode: S_IFREG }], {}, "has an unexpected entry"],
  ])("rejects an archive with %s", (_, additions, options, message) => {
    archive("darwin_amd64", additions, options);
    expect(() => check()).toThrow(message);
  });

  test.each([
    ["encrypted", (content: Buffer) => { content.writeUInt16LE(1, content.indexOf("PK\x01\x02") + 8); }, "has an encrypted entry"],
    ["corrupt", (content: Buffer) => { content.write("FAIL", 0); }, "is invalid"],
    ["corrupt checksum", (content: Buffer) => { content[content.indexOf("PK\x01\x02") + 16]! ^= 0xff; }, "is invalid"],
    ["DOS directory", (content: Buffer) => { content[content.indexOf("PK\x01\x02") + 38]! |= 0x10; }, "has a path or directory entry"],
    ["no central directory", (content: Buffer) => { content.fill(0, content.length - 22, content.length - 18); }, "is invalid"],
  ])("rejects a %s ZIP", (_, mutate, message) => {
    const path = archive();
    const content = readFileSync(path);
    mutate(content);
    writeFileSync(path, content);
    expect(() => check()).toThrow(message);
  });

  test.each<[string, Buffer, string]>([
    ["not json", Buffer.from("not json"), "not valid JSON"],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "not valid JSON"],
    ["trailing data", Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0"]}} x'), "not valid JSON"],
    ["duplicate keys", Buffer.from('{"version":1,"version":1,"metadata":{"protocol_versions":["6.0"]}}'), "duplicate keys"],
    ["nested duplicate keys", Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0"],"protocol_versions":["6.0"]}}'), "duplicate keys"],
    ["boolean version", Buffer.from('{"version":true,"metadata":{"protocol_versions":["6.0"]}}'), "exactly version 1 and protocol 6.0"],
    ["float version", Buffer.from('{"version":1.0,"metadata":{"protocol_versions":["6.0"]}}'), "exactly version 1 and protocol 6.0"],
    ["wrong protocol", Buffer.from('{"version":1,"metadata":{"protocol_versions":["5.0"]}}'), "exactly version 1 and protocol 6.0"],
    ["extra protocol", Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0","5.0"]}}'), "exactly version 1 and protocol 6.0"],
    ["extra metadata key", Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0"],"x":1}}'), "exactly version 1 and protocol 6.0"],
    ["extra key", Buffer.from('{"version":1,"metadata":{"protocol_versions":["6.0"]},"extra":1}'), "exactly version 1 and protocol 6.0"],
    ["array", Buffer.from("[]"), "exactly version 1 and protocol 6.0"],
  ])("rejects a manifest with %s", (_, content, message) => {
    writeFileSync(join(directory, "terraform-registry-manifest.json"), content);
    expect(() => check()).toThrow(message);
  });

  test("accepts a manifest with insignificant whitespace and escapes", () => {
    writeFileSync(join(directory, "terraform-registry-manifest.json"), '\n{ "vers\\u0069on" : 1 , "metadata" : { "protocol_versions" : [ "6.0" ] } }\n');
    expect(() => check()).not.toThrow();
  });

  test.each(["missing", "unexpected", "directory", "symlink"])("rejects asset set problem: %s", (kind) => {
    const target = join(directory, `${PREFIX}_darwin_amd64.zip`);
    if (kind === "unexpected") writeFileSync(join(directory, "build.sig"), "untrusted");
    else {
      unlinkSync(target);
      if (kind === "directory") mkdirSync(target);
      if (kind === "symlink") symlinkSync(join(directory, "terraform-registry-manifest.json"), target);
    }
    expect(() => check()).toThrow(kind === "missing" || kind === "unexpected" ? "asset set differs" : "not a regular file");
  });

  test("requires exactly one manifest", () => {
    const source = join(directory, "terraform-registry-manifest.json");
    unlinkSync(source);
    expect(() => check()).toThrow("exactly one Registry manifest");
    writeFileSync(source, MANIFEST);
    writeFileSync(join(directory, `${PREFIX}_manifest.json`), MANIFEST);
    expect(() => check()).toThrow("exactly one Registry manifest");
  });

  test.each([
    ["../test", VERSION, "invalid Terraform provider name"],
    ["a".repeat(65), VERSION, "invalid Terraform provider name"],
    ["test\n", VERSION, "invalid Terraform provider name"],
    ["test", "1.2.3+build", "invalid Terraform provider version"],
    ["test", "1.2.3-01", "invalid Terraform provider version"],
    ["test", "1.2.3-", "invalid Terraform provider version"],
    ["test", "1.2.3\n", "invalid Terraform provider version"],
  ])("rejects provider %j version %j", (name, version, message) => {
    expect(() => validate(directory, name, version, false)).toThrow(message);
  });
});

describe("Terraform signing protocol", () => {
  const sec = (key = FINGERPRINT, flags = "sc", state = "u", algorithm = "1") => `pub:${state}:2048:${algorithm}:id:::::::${flags}:\nfpr:::::::::${key}:\n`;

  test.each<[string, string, string, string]>([
    ["verify", "lowercase", EPOCH, "40 uppercase"],
    ["prepare", FINGERPRINT, "-1", "invalid Terraform source timestamp"],
    ["prepare", FINGERPRINT, "01", "invalid Terraform source timestamp"],
    ["prepare", FINGERPRINT.slice(1), EPOCH, "40 uppercase"],
    ["unknown", FINGERPRINT, EPOCH, "invalid Terraform asset mode"],
  ])("rejects mode %s fingerprint %j epoch %j before any gpg call", (mode, fingerprint, epoch, message) => {
    expect(() => processAssets(mode, directory, "test", VERSION, epoch, fingerprint, { key: "fixture", passphrase: "fixture" }, () => { throw new Error("gpg ran"); })).toThrow(message);
  });

  test.each<[{ key?: string; passphrase?: string }, string]>([
    [{}, "GPG key is required"],
    [{ key: "fixture" }, "GPG passphrase is required"],
  ])("rejects credentials %j", (credentials, message) => {
    expect(() => processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, credentials)).toThrow(message);
  });

  test("does not overwrite existing Registry content", () => {
    const path = join(directory, "existing");
    writeFileSync(path, "original");
    expect(() => writeMatching(path, Buffer.from("different"))).toThrow("does not match its expected content");
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(() => writeMatching(path, Buffer.from("original"))).not.toThrow();
  });

  test("refuses to write through a symbolic link", () => {
    const path = join(directory, "linked");
    symlinkSync(join(temporary, "elsewhere"), path);
    expect(() => writeMatching(path, Buffer.from("x"))).toThrow("not a regular file");
  });

  test("a failing gpg does not disclose credentials", () => {
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gpg"), "#!/bin/sh\necho secret fixture text >&2\nexit 1\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(() => gpg(directory, ["--import"], Buffer.from("secret fixture text"))).toThrow(/^Terraform GPG operation failed$/u);
    } finally {
      process.env.PATH = path;
    }
  });

  test.each<[string, string, string]>([
    ["no key", "", "key set does not match"],
    ["other fingerprint", sec("B".repeat(40)), "key set does not match"],
    ["two keys", sec() + sec(), "key set does not match"],
    ["subkey fingerprint", "pub:u:2048:1:id:::::::sc:\nsub:u:2048:1:id:::::::s:\nfpr:::::::::" + FINGERPRINT + ":\n", "key set does not match"],
    ["non-RSA algorithm", sec(FINGERPRINT, "sc", "u", "22"), "primary RSA signing key"],
    ["no signing capability", sec(FINGERPRINT, "cS"), "primary RSA signing key"],
    ["revoked", sec(FINGERPRINT, "sc", "r"), "primary RSA signing key"],
    ["expired", sec(FINGERPRINT, "sc", "e"), "primary RSA signing key"],
    ["disabled", sec(FINGERPRINT, "sc", "d"), "primary RSA signing key"],
  ])("rejects a key listing with %s", (_, listing, message) => {
    expect(() => primaryKey(directory, FINGERPRINT, false, () => Buffer.from(listing))).toThrow(message);
  });

  test("accepts RSA algorithm 3 and a signing-only primary key", () => {
    expect(() => primaryKey(directory, FINGERPRINT, false, () => Buffer.from(sec(FINGERPRINT, "sc", "u", "3")))).not.toThrow();
  });

  const valid = `[GNUPG:] VALIDSIG ${FINGERPRINT} 2027-01-15 ${EPOCH} 0 4 0 1 8 00 ${FINGERPRINT}\n`;
  test.each<[string, string]>([
    ["no signature", ""],
    ["two signatures", valid + valid],
    ["other fingerprint", valid.replace(FINGERPRINT, "B".repeat(40))],
    ["other timestamp", valid.replace(EPOCH, "1800000001")],
    ["other digest", valid.replace(" 1 8 00", " 1 10 00")],
    ["other public key algorithm", valid.replace(" 1 8 00", " 17 8 00")],
    ["too few fields", `[GNUPG:] VALIDSIG ${FINGERPRINT} 2027-01-15 ${EPOCH}\n`],
  ])("rejects a signature report with %s", (_, output) => {
    expect(() => verifySignature(directory, directory, "sums", FINGERPRINT, EPOCH, () => Buffer.from(output))).toThrow("detached signature does not match");
  });

  function fakeGpg(calls: { args: string[]; data?: Buffer | undefined }[], homes: string[], failSigning = { once: false }): Gpg {
    return (home, args, data) => {
      homes.push(home);
      calls.push({ args, data });
      if (args.includes("--list-keys") || args.includes("--list-secret-keys")) return Buffer.from(sec());
      if (args.includes("--detach-sign")) {
        if (failSigning.once) { failSigning.once = false; throw new Error("Terraform GPG operation failed"); }
        writeFileSync(args[args.indexOf("--output") + 1]!, "deterministic signature");
      }
      if (args.includes("--verify")) return Buffer.from(valid);
      return Buffer.from(args.includes("--export") ? "public key" : "");
    };
  }

  test("signing is repeatable, leaves archives untouched and removes its gpg home", () => {
    const calls: { args: string[]; data?: Buffer | undefined }[] = [];
    const homes: string[] = [];
    const run = fakeGpg(calls, homes, { once: true });
    const credentials = { key: "secret fixture text", passphrase: "passphrase fixture text" };
    const archives = () => Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".zip")).map((name) => [name, readFileSync(join(directory, name))]));
    const original = archives();
    expect(() => processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, credentials, run)).toThrow("GPG operation failed");
    expect(existsSync(join(directory, "terraform-registry-manifest.json"))).toBe(false);
    expect(existsSync(join(directory, `${PREFIX}_SHA256SUMS.sig`))).toBe(false);
    for (let count = 0; count < 2; count += 1) {
      expect(processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, credentials, run)).toBe("public key");
    }
    for (const suffix of ["_SHA256SUMS", "_SHA256SUMS.sig"]) unlinkSync(join(directory, `${PREFIX}${suffix}`));
    expect(processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, credentials, run)).toBe("public key");
    processAssets("verify", directory, "test", VERSION, EPOCH, FINGERPRINT, { key: "public key" }, run);
    expect(archives()).toEqual(original);
    expect(homes.every((home) => !existsSync(home))).toBe(true);
    expect(calls.every(({ args }) => !args.includes("secret fixture text") && !args.includes("passphrase fixture text"))).toBe(true);
    const sign = calls.find(({ args }) => args.includes("--detach-sign"))!;
    expect(sign.data?.toString()).toBe("passphrase fixture text");
    expect(sign.args).toContain(`${FINGERPRINT}!`);
    expect(sign.args).toContain(`${EPOCH}!`);
    expect(sign.args).toContain("SHA256");
    expect(readFileSync(join(directory, `${PREFIX}_manifest.json`))).toEqual(MANIFEST);
    expect(readFileSync(join(directory, `${PREFIX}_SHA256SUMS`), "utf8").split("\n").filter(Boolean)).toHaveLength(14);
    expect(readdirSync(directory)).toHaveLength(16);
    expect(checksumContent(directory, [`${PREFIX}_manifest.json`]).toString()).toMatch(/^[0-9a-f]{64} {2}terraform-provider-test_1\.2\.3_manifest\.json\n$/u);
    writeFileSync(join(directory, `${PREFIX}_SHA256SUMS`), "wrong");
    expect(() => processAssets("verify", directory, "test", VERSION, EPOCH, FINGERPRINT, { key: "public key" }, run)).toThrow("Registry checksums do not match");
  });

  test("prepare checks the secret key listing as well as the public one", () => {
    const calls: { args: string[]; data?: Buffer | undefined }[] = [];
    processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, { key: "k", passphrase: "p" }, fakeGpg(calls, []));
    expect(calls.filter(({ args }) => args.includes("--list-secret-keys"))).toHaveLength(1);
    expect(calls.filter(({ args }) => args.includes("--list-keys"))).toHaveLength(1);
  });

  test("removes the gpg home when gpg fails", () => {
    const homes: string[] = [];
    const fail: Gpg = (home) => { homes.push(home); throw new Error("Terraform GPG operation failed"); };
    expect(() => processAssets("prepare", directory, "test", VERSION, EPOCH, FINGERPRINT, { key: "fixture", passphrase: "fixture" }, fail)).toThrow("GPG operation failed");
    expect(homes.length > 0 && homes.every((home) => !existsSync(home))).toBe(true);
  });
});
