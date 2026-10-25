import * as core from "@actions/core";
import { github } from "../lib/github.ts";
import { ensureReleaseTag } from "../release/tag.ts";

async function main(): Promise<void> {
  await ensureReleaseTag(
    github(core.getInput("github-token", { required: true })),
    JSON.parse(core.getInput("plan", { required: true })),
  );
  core.info("release tag is present and points to the planned merge commit");
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
