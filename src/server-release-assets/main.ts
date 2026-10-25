import * as core from "@actions/core";
import { prepareAssets } from "../release/assets.ts";
import { ReleaseSchema } from "../lib/config.ts";

async function main(): Promise<void> {
  const directory = core.getInput("directory", { required: true });
  const releaseConfig = core.getInput("release-config");
  const release = releaseConfig ? ReleaseSchema.parse(JSON.parse(releaseConfig)) : undefined;
  const assets = await prepareAssets(directory, release);
  core.setOutput("subject-path", `${directory}/*`);
  core.setOutput("assets", JSON.stringify(assets.map(({ name, sha256 }) => ({ name, sha256 }))));
  core.info(`prepared ${assets.length} release asset${assets.length === 1 ? "" : "s"} including SHA256SUMS`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
