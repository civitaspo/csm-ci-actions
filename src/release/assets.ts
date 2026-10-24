import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Rejection } from "../lib/request.ts";

export type AssetDigest = { name: string; sha256: string; path: string };

export async function prepareAssets(directory: string): Promise<AssetDigest[]> {
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).sort();
  const existingSums = names.includes("SHA256SUMS") ? await readFile(join(directory, "SHA256SUMS"), "utf8") : undefined;
  const assets: AssetDigest[] = [];
  for (const name of names) {
    if (name === "SHA256SUMS") continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(name)) throw new Rejection(`asset name ${JSON.stringify(name)} is not a safe filename`);
    const path = join(directory, name);
    const info = await lstat(path);
    if (!info.isFile()) throw new Rejection(`asset ${JSON.stringify(name)} is not a regular file`);
    const content = await readFile(path);
    assets.push({ name, path, sha256: createHash("sha256").update(content).digest("hex") });
  }
  const sums = assets.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n");
  const content = `${sums}${sums ? "\n" : ""}`;
  if (existingSums !== undefined && existingSums !== content) throw new Rejection("existing SHA256SUMS does not match the build outputs");
  if (existingSums === undefined) await writeFile(join(directory, "SHA256SUMS"), content);
  const checksums = await readFile(join(directory, "SHA256SUMS"));
  assets.push({ name: "SHA256SUMS", path: join(directory, "SHA256SUMS"), sha256: createHash("sha256").update(checksums).digest("hex") });
  return assets;
}
