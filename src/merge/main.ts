import { setTimeout as sleep } from "node:timers/promises";
import * as core from "@actions/core";
import { type MergeArgs, runMerge, waitForMerge } from "../lib/merge.ts";
import { github, loadConfig } from "../lib/github.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const read = github(core.getInput("server-token", { required: true }));
  const config = await loadConfig(github(core.getInput("github-token", { required: true })), env("GITHUB_REPOSITORY"), env("GITHUB_SHA"), core.getInput("config-path", { required: true }));
  const args = JSON.parse(core.getInput("args", { required: true })) as MergeArgs;
  const ctx = {
    server: read,
    write: core.getInput("mode") === "merge" ? github(core.getInput("write-token", { required: true })) : read,
    config,
    repository: core.getInput("repository", { required: true }),
    now: () => new Date(),
    sleep: async (milliseconds: number) => { await sleep(milliseconds); },
  };
  const mode = core.getInput("mode", { required: true });
  if (mode === "wait") {
    const ready = await waitForMerge(ctx, args);
    core.setOutput("ready", "true");
    core.setOutput("head", ready.head);
    core.info(`pull request is ready at ${ready.head}`);
    return;
  }
  if (mode !== "merge") throw new Error(`unknown merge action mode: ${mode}`);
  const outcome = await runMerge(ctx, args, { head: core.getInput("head", { required: true }) });
  core.setOutput("result", outcome.result);
  core.setOutput("merge-commit", outcome.mergeCommit);
  core.info(`${outcome.result} at ${outcome.mergeCommit}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
