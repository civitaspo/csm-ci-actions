import * as core from "@actions/core";
import { github } from "../lib/github.ts";
import { publishRelease } from "../release/publish.ts";

async function main(): Promise<void> {
  await publishRelease(github(core.getInput("github-token", { required: true })), {
    plan: JSON.parse(core.getInput("plan", { required: true })),
    expectedAssets: JSON.parse(core.getInput("assets", { required: true })),
    directory: core.getInput("directory", { required: true }),
    terraform: {
      publicKey: core.getInput("gpg-public-key"),
      fingerprint: core.getInput("gpg-fingerprint"),
      sourceDateEpoch: core.getInput("source-date-epoch"),
    },
  });
  core.info("published and verified the immutable release");
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
