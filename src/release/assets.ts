import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Rejection } from "../lib/request.ts";
import type { Release } from "../lib/config.ts";
import { terraformAssets, type TerraformVerification } from "./terraform.ts";
import { ArtifactManifestSchema } from "./cargo-raw.ts";

export type AssetDigest = { name: string; sha256: string; path: string };
type CargoRawAssetRelease = Extract<Release, { build_type: "cargo-raw" }> & { version?: string; source_revision?: string };
export type AssetRelease = Exclude<Release, { build_type: "terraform-provider" | "cargo-raw" }>
  | CargoRawAssetRelease
  | (Extract<Release, { build_type: "terraform-provider" }> & TerraformVerification);

export async function prepareAssets(directory: string, release?: AssetRelease): Promise<AssetDigest[]> {
  await mkdir(directory, { recursive: true });
  if (release?.build_type === "terraform-provider") {
    await terraformAssets({ directory, providerName: release.provider_name, ...release,
      credentials: { mode: "verify", publicKey: release.publicKey } });
  }
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
    const optedIn = release.version_probe_args !== undefined;
    if (optedIn && (!release.version || !release.source_revision)) {
      throw new Rejection("cargo-raw metadata publication requires the planned version and source revision");
    }
    const expected = new Set(binaries.flatMap((name) => optedIn
      ? [name, `${name}.artifact.json`, `${name}.sha256`]
      : [name, `${name}.sha256`]));
    for (const asset of assets) {
      if (!expected.has(asset.name)) throw new Rejection(`unexpected cargo-raw asset ${JSON.stringify(asset.name)}`);
    }
    const sidecars: Array<{ name: string; content: string }> = [];
    for (const target of release.targets) {
      const name = `${release.binary}-${target}`;
      const binary = assets.find((asset) => asset.name === name);
      if (!binary) throw new Rejection(`missing cargo-raw binary ${JSON.stringify(name)}`);
      if (optedIn) {
        const manifestName = `${name}.artifact.json`;
        const manifest = assets.find((asset) => asset.name === manifestName);
        if (!manifest) throw new Rejection(`missing cargo-raw artifact manifest ${JSON.stringify(manifestName)}`);
        const bytes = await readFile(join(directory, manifestName));
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Rejection(`cargo-raw artifact manifest ${JSON.stringify(manifestName)} is not valid UTF-8`); }
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new Rejection(`cargo-raw artifact manifest ${JSON.stringify(manifestName)} is not valid JSON`); }
        const result = ArtifactManifestSchema.safeParse(parsed);
        if (!result.success) throw new Rejection(`cargo-raw artifact manifest ${JSON.stringify(manifestName)} is invalid`);
        const value = result.data;
        if (value.version !== release.version || value.rust_target !== target ||
            value.source_revision !== release.source_revision || value.dirty !== false || value.sha256 !== binary.sha256) {
          throw new Rejection(`cargo-raw artifact manifest ${JSON.stringify(manifestName)} does not match the release plan or binary`);
        }
      }
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
