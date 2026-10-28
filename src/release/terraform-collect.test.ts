import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collect } from "./terraform-collect.ts";

let root: string;
let client: string;
let destination: string;
const rows = [{ type: "Archive", path: "dist/provider.zip" }, { type: "Checksum", path: "dist/checksums" }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "terraform-collect-"));
  client = join(root, "client");
  destination = join(root, "assets");
  mkdirSync(join(client, "dist"), { recursive: true });
  writeFileSync(join(client, "dist/provider.zip"), "archive");
  writeFileSync(join(client, "dist/checksums"), "untrusted checksums");
  writeFileSync(join(client, "terraform-registry-manifest.json"), "manifest");
  writeFileSync(join(client, "dist/artifacts.json"), JSON.stringify(rows));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Terraform build output collection", () => {
  test("collects only archives and the root manifest", () => {
    collect(client, destination);
    expect(readdirSync(destination).sort()).toEqual(["provider.zip", "terraform-registry-manifest.json"]);
    expect(readFileSync(join(destination, "provider.zip"), "utf8")).toBe("archive");
  });

  test.each([
    [{}, "manifest is not a list"],
    [["not an object"], "artifact is not an object"],
    [[null], "artifact is not an object"],
    [[[]], "artifact is not an object"],
    [[{ type: "Archive" }], "path is not a string"],
    [[{ type: "Archive", path: "outside.zip" }], "path is outside dist/"],
    [[{ type: "Archive", path: "dist/../outside.zip" }], "path is outside dist/"],
    [[{ type: "Archive", path: "/dist/a.zip" }], "path is outside dist/"],
    [[{ type: "Archive", path: "dist/a\\b.zip" }], "path is outside dist/"],
    [[{ type: "Archive", path: "" }], "path is outside dist/"],
    [[{ type: "Checksum", path: "dist/checksums" }], "no release archives"],
    [[rows[0], rows[0]], "duplicate GoReleaser asset name"],
  ])("rejects invalid artifact rows %j", (content, message) => {
    writeFileSync(join(client, "dist/artifacts.json"), JSON.stringify(content));
    expect(() => collect(client, destination)).toThrow(message);
  });

  test.each([
    ["dist/artifacts.json", "regular artifacts.json"],
    ["dist/provider.zip", "regular file inside dist/"],
    ["terraform-registry-manifest.json", "build output is not a regular file"],
  ])("rejects a symbolic link at %s", (name, message) => {
    const path = join(client, name);
    const content = readFileSync(path);
    unlinkSync(path);
    writeFileSync(join(root, "outside"), content);
    symlinkSync(join(root, "outside"), path);
    expect(() => collect(client, destination)).toThrow(message);
  });

  test("rejects a directory that is not a regular archive", () => {
    unlinkSync(join(client, "dist/provider.zip"));
    mkdirSync(join(client, "dist/provider.zip"));
    expect(() => collect(client, destination)).toThrow("regular file inside dist/");
  });

  test("does not overwrite an existing asset", () => {
    mkdirSync(destination);
    writeFileSync(join(destination, "provider.zip"), "existing");
    expect(() => collect(client, destination)).toThrow();
    expect(readFileSync(join(destination, "provider.zip"), "utf8")).toBe("existing");
  });
});
