import { setTimeout as sleep } from "node:timers/promises";
import * as core from "@actions/core";
import { type MergeArgs, type MergeContext, postMergeFailureReceipt, runMerge, waitForMerge } from "../lib/merge.ts";
import { github, loadConfig, loadCurrentServerConfig } from "../lib/github.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const read = github(core.getInput("server-token", { required: true }));
  const workflowRepository = env("GITHUB_REPOSITORY");
  const configPath = core.getInput("config-path", { required: true });
  const configReader = github(core.getInput("github-token", { required: true }));
  const config = await loadConfig(configReader, workflowRepository, env("GITHUB_SHA"), configPath);
  const args = JSON.parse(core.getInput("args", { required: true })) as MergeArgs;
  const ctx: MergeContext = {
    server: read,
    notify: github(core.getInput("notification-token", { required: true })),
    ...(core.getInput("mode") === "merge" ? { write: github(core.getInput("write-token", { required: true })) } : {}),
    config,
    reloadConfig: () => loadCurrentServerConfig(configReader, workflowRepository, configPath),
    repository: core.getInput("repository", { required: true }),
    serverRun: { serverUrl: env("GITHUB_SERVER_URL"), repository: env("GITHUB_REPOSITORY"), id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") },
    now: () => new Date(),
    sleep: async (milliseconds: number) => { await sleep(milliseconds); },
  };
  const mode = core.getInput("mode", { required: true });
  if (mode === "wait") {
    ctx.onAccepted = (head) => {
      core.setOutput("accepted", "true");
      core.setOutput("head", head);
    };
    try {
      const ready = await waitForMerge(ctx, args);
      core.setOutput("ready", "true");
      core.setOutput("head", ready.head);
      core.info(`pull request is ready at ${ready.head}`);
    } catch (error) {
      core.setOutput("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
    return;
  }
  if (mode === "failure-receipt") {
    await postMergeFailureReceipt(ctx, args, core.getInput("failure-message", { required: true }), core.getInput("head", { required: true }));
    return;
  }
  if (mode !== "merge") throw new Error(`unknown merge action mode: ${mode}`);
  const outcome = await runMerge(ctx, args, { head: core.getInput("head", { required: true }) });
  core.setOutput("result", outcome.result);
  core.setOutput("merge-commit", outcome.mergeCommit);
  core.info(`${outcome.result} at ${outcome.mergeCommit}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
