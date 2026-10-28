import { readFileSync } from "node:fs";
import { ensure } from "./ensure.ts";
import { crc32, inflateRawSync } from "node:zlib";

export type ZipEntry = {
  /** Name up to the first NUL byte, as ZIP readers that stop at NUL see it. */
  name: string;
  /** Name exactly as stored in the central directory. */
  originalName: string;
  flags: number;
  externalAttributes: number;
  size: number;
  read: () => Buffer;
};

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Parses the central directory; entry contents are decompressed and CRC-checked only when read. */
export function openZip(path: string): ZipEntry[] {
  const data = readFileSync(path);
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 0xffff); offset -= 1) {
    if (data.readUInt32LE(offset) === END) { end = offset; break; }
  }
  ensure(!(end < 0), "not a ZIP file");
  const count = data.readUInt16LE(end + 10);
  const centralSize = data.readUInt32LE(end + 12);
  const centralOffset = data.readUInt32LE(end + 16);
  ensure(!(count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff), "ZIP64 is not supported");
  ensure(!(centralOffset + centralSize > end), "bad central directory");
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    ensure(!(offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL), "bad central directory entry");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttributes = data.readUInt32LE(offset + 38);
    const local = data.readUInt32LE(offset + 42);
    ensure(!(compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff), "ZIP64 is not supported");
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    const originalName = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    const nul = originalName.indexOf("\0");
    offset += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name: nul >= 0 ? originalName.slice(0, nul) : originalName,
      originalName,
      flags,
      externalAttributes,
      size,
      read: () => {
        ensure(!(flags & 0x60), "unsupported ZIP flags");
        ensure(!(local + 30 > data.length || data.readUInt32LE(local) !== LOCAL), "bad local header");
        const localName = data.subarray(local + 30, local + 30 + data.readUInt16LE(local + 26));
        ensure(!(!localName.equals(rawName)), "local header name differs");
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const body = data.subarray(start, start + compressed);
        ensure(!(body.length !== compressed), "truncated entry");
        ensure(method === 0 || method === 8, "unsupported compression method");
        const content = method === 0 ? body : inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
        ensure(!(content.length !== size || crc32(content) !== crc), "bad entry content");
        return content;
      },
    });
  }
  ensure(offset === centralOffset + centralSize, "central directory size does not match its entries");
  return entries;
}
