import { resolve } from "node:path";
import { packageCargo } from "./cargo-package.ts";
import { verifyRaw } from "./cargo-raw.ts";
import { ensure } from "./ensure.ts";
import { collect } from "./terraform-collect.ts";

// Commands of the server release-build action; returns text to print on success.
export function releaseBuild(args: string[]): string | undefined {
  const [command, ...rest] = args;
  if (command === "package") {
    ensure(rest.length === 2, "usage: release-build package SOURCE_DIRECTORY DESTINATION");
    packageCargo(rest[0]!, rest[1]!);
    return undefined;
  }
  if (command === "raw") return verifyRaw(rest);
  if (command === "terraform") {
    ensure(rest.length === 2, "usage: release-build terraform CLIENT_DIRECTORY DESTINATION");
    collect(resolve(rest[0]!), resolve(rest[1]!));
    return undefined;
  }
  throw new Error("usage: release-build package|raw|terraform ...");
}
