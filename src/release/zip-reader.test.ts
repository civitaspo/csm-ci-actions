import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { zip } from "./zip-fixture.ts";
import { openZip } from "./zip-reader.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zip-reader-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const members = [{ name: "a", content: "alpha", mode: 0o100644 }, { name: "b", content: "beta", mode: 0o100644 }];
const central = (content: Buffer) => content.indexOf("PK\x01\x02");
const endOfDirectory = (content: Buffer) => content.length - 22;

function open(mutate: (content: Buffer) => Buffer | void = () => undefined) {
  const content = zip(members);
  const path = join(directory, "test.zip");
  writeFileSync(path, mutate(content) ?? content);
  return openZip(path);
}

test("reads names, sizes and contents", () => {
  const entries = open();
  expect(entries.map((entry) => [entry.name, entry.size, entry.read().toString()])).toEqual([["a", 5, "alpha"], ["b", 4, "beta"]]);
});

test.each<[string, (content: Buffer) => Buffer | void, string | RegExp]>([
  ["no end of directory", (content) => content.subarray(0, 10), "not a ZIP file"],
  ["ZIP64 entry count", (content) => { content.writeUInt16LE(0xffff, endOfDirectory(content) + 10); }, "ZIP64 is not supported"],
  ["ZIP64 directory size", (content) => { content.writeUInt32LE(0xffffffff, endOfDirectory(content) + 12); }, "ZIP64 is not supported"],
  ["ZIP64 directory offset", (content) => { content.writeUInt32LE(0xffffffff, endOfDirectory(content) + 16); }, "ZIP64 is not supported"],
  ["directory beyond the end record", (content) => { content.writeUInt32LE(content.length, endOfDirectory(content) + 16); }, /^bad central directory$/u],
  ["bad entry signature", (content) => { content.write("XXXX", central(content)); }, "bad central directory entry"],
  ["fewer entries than the directory holds", (content) => { content.writeUInt16LE(1, endOfDirectory(content) + 10); }, "central directory size does not match its entries"],
  ["more entries than the directory holds", (content) => { content.writeUInt16LE(3, endOfDirectory(content) + 10); }, "bad central directory entry"],
  ["ZIP64 compressed size", (content) => { content.writeUInt32LE(0xffffffff, central(content) + 20); }, "ZIP64 is not supported"],
  ["ZIP64 size", (content) => { content.writeUInt32LE(0xffffffff, central(content) + 24); }, "ZIP64 is not supported"],
  ["ZIP64 local offset", (content) => { content.writeUInt32LE(0xffffffff, central(content) + 42); }, "ZIP64 is not supported"],
])("rejects %s while opening", (_, mutate, message) => {
  expect(() => open(mutate)).toThrow(message);
});

test.each<[string, (content: Buffer) => Buffer | void, string]>([
  ["unsupported flags", (content) => { content.writeUInt16LE(0x20, central(content) + 8); }, "unsupported ZIP flags"],
  ["strong encryption flag", (content) => { content.writeUInt16LE(0x40, central(content) + 8); }, "unsupported ZIP flags"],
  ["bad local signature", (content) => { content.write("FAIL", 0); }, "bad local header"],
  ["different local name", (content) => { content[30] = 0x58; }, "local header name differs"],
  ["truncated body", (content) => { content.writeUInt32LE(content.length, central(content) + 20); }, "truncated entry"],
  ["unsupported method", (content) => { content.writeUInt16LE(12, central(content) + 10); }, "unsupported compression method"],
  ["wrong size", (content) => { content.writeUInt32LE(2, central(content) + 24); }, ""],
  ["wrong checksum", (content) => { content[central(content) + 16]! ^= 1; }, "bad entry content"],
])("rejects %s while reading", (_, mutate, message) => {
  expect(() => open(mutate)[0]!.read()).toThrow(message);
});
