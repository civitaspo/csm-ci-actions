import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { buildSecurefixArtifact } from "../lib/securefix.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const runId = Number(env("GITHUB_RUN_ID"));
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("GITHUB_RUN_ID must be a positive safe integer");
  const event = JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8")) as { pull_request?: { head?: { sha?: unknown } } };
  const eventHead = event.pull_request?.head?.sha;
  const headSha = typeof eventHead === "string" ? eventHead : env("GITHUB_SHA");
  const result = await buildSecurefixArtifact({
    workspace: core.getInput("workspace") || env("GITHUB_WORKSPACE"),
    repository: env("GITHUB_REPOSITORY"),
    runId,
    headSha,
    message: core.getInput("message") || `Apply securefix changes from workflow run ${runId}`,
  });
  core.setOutput("has-changes", String(result.hasChanges));
  if (result.hasChanges) core.setOutput("artifact-path", result.path);
  core.info(result.hasChanges ? "Prepared the securefix artifact." : "No securefix changes to upload.");
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
