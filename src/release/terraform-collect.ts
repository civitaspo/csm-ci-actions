import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { ensure } from "./ensure.ts";

const regular = (path: string) => lstatSync(path).isFile();

export function collect(client: string, destination: string): void {
  const manifest = join(client, "dist/artifacts.json");
  ensure(regular(manifest), "GoReleaser did not produce a regular artifacts.json manifest");
  const artifacts: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  ensure(Array.isArray(artifacts), "GoReleaser artifacts manifest is not a list");
  const files: string[] = [];
  for (const artifact of artifacts as unknown[]) {
    ensure(typeof artifact === "object" && artifact !== null && !Array.isArray(artifact), "GoReleaser artifact is not an object");
    const { type, path: relative } = artifact as { type?: unknown; path?: unknown };
    if (type !== "Archive") continue;
    ensure(typeof relative === "string", "GoReleaser archive path is not a string");
    const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
    ensure(!relative.startsWith("/") && parts[0] === "dist" && !parts.includes("..") && !relative.includes("\\"),
      "GoReleaser archive path is outside dist/");
    const source = join(client, ...parts);
    const root = realpathSync(join(client, "dist"));
    const resolved = realpathSync(source);
    ensure((resolved === root || resolved.startsWith(root + sep)) && regular(source), "GoReleaser archive is not a regular file inside dist/");
    files.push(source);
  }
  ensure(files.length > 0, "GoReleaser produced no release archives");
  files.push(join(client, "terraform-registry-manifest.json"));
  const names = files.map((path) => basename(path));
  ensure(names.length === new Set(names).size, "duplicate GoReleaser asset name");
  for (const path of files) ensure(regular(path), "Terraform build output is not a regular file");
  mkdirSync(destination, { recursive: true });
  for (const path of files) copyFileSync(path, join(destination, basename(path)), constants.COPYFILE_EXCL);
}
