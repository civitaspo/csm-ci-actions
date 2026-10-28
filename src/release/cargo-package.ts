import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { ensure } from "./ensure.ts";

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
  const field = Buffer.alloc(length);
  field.write(value.toString(8).padStart(length - 1, "0"), "ascii");
  return field;
}

function header(name: Buffer, size: number, mode: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0, 0, 100);
  octal(mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156, "ascii");
  block.write("ustar\0" + "00", 257, "ascii");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

function padded(content: Buffer): Buffer {
  return Buffer.concat([content, Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK)]);
}

// A PAX extended header carries names that do not fit the 100-byte ustar field or are not ASCII.
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

function entry(name: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const parts: Buffer[] = [];
  if (nameBytes.length > 100 || nameBytes.some((byte) => byte > 0x7f)) {
    const record = paxRecord("path", name);
    parts.push(header(Buffer.from("././@PaxHeader"), record.length, 0o644, "x"), padded(record));
  }
  parts.push(header(nameBytes, content.length, 0o755, "0"), padded(content));
  return Buffer.concat(parts);
}

function gzip(tar: Buffer): Buffer {
  // Fixed header: no file name, mtime 0, maximum compression flag, unknown OS.
  const head = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(tar), 0);
  tail.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([head, deflateRawSync(tar, { level: 9 }), tail]);
}

function list(directory: string, prefix = ""): { relative: string; path: string; symlink: boolean; file: boolean }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = join(directory, item.name);
    const relative = prefix + item.name;
    const stat = lstatSync(path);
    const self = { relative, path, symlink: stat.isSymbolicLink(), file: stat.isFile() };
    return stat.isDirectory() ? [self, ...list(path, `${relative}/`)] : [self];
  });
}

export function packageCargo(source: string, destination: string): void {
  const paths = list(source);
  ensure(!paths.some((item) => item.symlink), "Cargo output contains a symbolic link");
  const files = paths.filter((item) => item.file).sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  ensure(files.length > 0, "Cargo produced no executable binaries to package");

  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now().toString(36)}`);
  try {
    const tar = Buffer.concat([...files.map((file) => entry(file.relative, readFileSync(file.path))), Buffer.alloc(BLOCK * 2)]);
    const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(output, gzip(padToRecord(tar)));
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Python's tarfile pads the archive to a 10240-byte record.
function padToRecord(tar: Buffer): Buffer {
  const record = BLOCK * 20;
  return Buffer.concat([tar, Buffer.alloc((record - (tar.length % record)) % record)]);
}
