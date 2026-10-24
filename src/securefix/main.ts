import * as core from "@actions/core";
import { applySecurefix, inspectSecurefix, locateSecurefix, securefixPreparationOutput } from "../lib/securefix-operation.ts";
import { github, loadConfig } from "../lib/github.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function runId(): number {
  const value = Number(core.getInput("run-id", { required: true }));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("run-id must be a positive safe integer");
  return value;
}

async function main(): Promise<void> {
  const serverRepository = env("GITHUB_REPOSITORY");
  const configPath = core.getInput("config-path") || "csm-ci.yaml";
  const config = await loadConfig(github(core.getInput("github-token") || env("GITHUB_TOKEN")), serverRepository, env("GITHUB_SHA"), configPath);
  const repository = core.getInput("repository", { required: true });
  const id = runId();
  const mode = core.getInput("mode", { required: true });
  const token = core.getInput(mode === "apply" ? "write-token" : "server-token", { required: true });
  const gh = github(token);
  if (mode === "locate") {
    const { context } = await locateSecurefix(gh, config, repository, id);
    core.setOutput("artifact-name", context.artifact.name);
    core.setOutput("artifact-id", String(context.artifact.id));
    core.setOutput("route-mode", String(context.route !== null));
    core.info(`located ${context.artifact.name} for ${repository} run ${id}`);
    return;
  }
  const artifactPath = core.getInput("artifact-path", { required: true });
  if (mode === "prepare") {
    const result = await inspectSecurefix(gh, config, repository, id, artifactPath);
    const outputs = securefixPreparationOutput(result);
    core.setOutput("result", outputs.result);
    core.setOutput("requires-workflows-write", outputs["requires-workflows-write"]);
    core.setOutput("route-mode", String(result.context.route !== null));
    core.info(`${outputs.result} securefix for ${repository} run ${id}`);
    return;
  }
  if (mode === "apply") {
    const result = await applySecurefix(gh, config, repository, id, artifactPath, token);
    core.setOutput("result", result.status);
    core.setOutput("commit", result.commit);
    if (result.pullRequest !== undefined) core.setOutput("pull-request", String(result.pullRequest));
    core.info(`${result.status} securefix commit ${result.commit}`);
    return;
  }
  throw new Error(`unknown securefix mode ${mode}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
