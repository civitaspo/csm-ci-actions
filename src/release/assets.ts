import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Rejection } from "../lib/request.ts";
import type { Release } from "../lib/config.ts";

export type AssetDigest = { name: string; sha256: string; path: string };

export async function prepareAssets(directory: string, release?: Release): Promise<AssetDigest[]> {
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).sort();
  const sumsPath = join(directory, "SHA256SUMS");
  const sumsInfo = names.includes("SHA256SUMS") ? await lstat(sumsPath) : undefined;
  if (sumsInfo && !sumsInfo.isFile()) throw new Rejection('asset "SHA256SUMS" is not a regular file');
  const existingSums = sumsInfo ? await readFile(sumsPath, "utf8") : undefined;
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
  if (release?.build_type === "cargo-raw") {
    const binaries = release.targets.map((target) => `${release.binary}-${target}`);
    const expected = new Set(binaries.flatMap((name) => [name, `${name}.sha256`]));
    for (const asset of assets) {
      if (!expected.has(asset.name)) throw new Rejection(`unexpected cargo-raw asset ${JSON.stringify(asset.name)}`);
    }
    const sidecars: Array<{ name: string; content: string }> = [];
    for (const name of binaries) {
      const binary = assets.find((asset) => asset.name === name);
      if (!binary) throw new Rejection(`missing cargo-raw binary ${JSON.stringify(name)}`);
      const sidecar = `${name}.sha256`;
      const content = `${binary.sha256}  ${name}\n`;
      if (assets.some((asset) => asset.name === sidecar)) {
        if (await readFile(join(directory, sidecar), "utf8") !== content) {
          throw new Rejection(`cargo-raw checksum ${JSON.stringify(sidecar)} does not match its binary`);
        }
      } else sidecars.push({ name: sidecar, content });
    }
    for (const { name, content } of sidecars) {
      const path = join(directory, name);
      await writeFile(path, content, { flag: "wx" });
      assets.push({ name, path, sha256: createHash("sha256").update(content).digest("hex") });
    }
    assets.sort((a, b) => a.name.localeCompare(b.name, "en"));
  }
  const sums = assets.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n");
  const content = `${sums}\n`;
  if (existingSums !== undefined && existingSums !== content) throw new Rejection("existing SHA256SUMS does not match the build outputs");
  if (existingSums === undefined) await writeFile(sumsPath, content, { flag: "wx" });
  const checksums = await readFile(sumsPath);
  assets.push({ name: "SHA256SUMS", path: sumsPath, sha256: createHash("sha256").update(checksums).digest("hex") });
  return assets;
}
