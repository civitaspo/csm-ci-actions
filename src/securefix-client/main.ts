import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { createRequestLabel, github } from "../lib/github.ts";
import { assertWorkspaceAtHead, buildSecurefixArtifact, securefixClientContext } from "../lib/securefix.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function runId(): number {
  const value = Number(env("GITHUB_RUN_ID"));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("GITHUB_RUN_ID must be a positive safe integer");
  return value;
}

// The composite action calls this twice: once to package before the artifact upload, and once to
// send the request after the upload and the Client App token step.
async function packageChanges(): Promise<void> {
  const context = securefixClientContext({
    eventName: env("GITHUB_EVENT_NAME"),
    event: JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8")),
    repository: env("GITHUB_REPOSITORY"),
    sha: env("GITHUB_SHA"),
    serverRepository: core.getInput("server_repository", { required: true }),
  });
  if (context.kind === "skip") {
    core.notice(context.reason);
    core.setOutput("has-changes", "false");
    return;
  }
  const workspace = core.getInput("workspace") || env("GITHUB_WORKSPACE");
  assertWorkspaceAtHead(workspace, context.headSha);
  const id = runId();
  const result = await buildSecurefixArtifact({
    workspace,
    repository: env("GITHUB_REPOSITORY"),
    runId: id,
    headSha: context.headSha,
    message: core.getInput("message") || `Apply securefix changes from workflow run ${id}`,
  });
  core.setOutput("has-changes", String(result.hasChanges));
  core.setOutput("server-owner", context.server.owner);
  core.setOutput("server-name", context.server.repo);
  if (result.hasChanges) core.setOutput("artifact-path", result.path);
  core.info(result.hasChanges ? "Prepared the securefix artifact." : "No securefix changes; nothing will be requested.");
}

async function sendRequest(): Promise<void> {
  const server = core.getInput("server_repository", { required: true });
  const label = await createRequestLabel(github(core.getInput("token", { required: true })), server, "securefix", env("GITHUB_REPOSITORY"), [runId()]);
  core.setOutput("label", label.name);
  // e2e correlates requests by this exact line.
  core.info(`created label ${label.name} (${label.description}) in ${server}`);
}

const step = process.env.CSM_CI_SECUREFIX_STEP;
(step === "package" ? packageChanges() : step === "request" ? sendRequest() : Promise.reject(new Error(`unknown securefix client step ${step}`)))
  .catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
