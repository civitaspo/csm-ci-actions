import * as core from "@actions/core";
import { type MergeArgs, type MergeContext, acceptMerge } from "../lib/merge.ts";
import { github, loadCurrentServerConfig } from "../lib/github.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  if (core.getInput("mode", { required: true }) !== "accept") throw new Error("unknown merge action mode");
  const serverRepository = env("GITHUB_REPOSITORY");
  const configReader = github(core.getInput("github-token", { required: true }));
  const configPath = core.getInput("config-path", { required: true });
  const config = await loadCurrentServerConfig(configReader, serverRepository, configPath);
  const ctx: MergeContext = {
    server: github(core.getInput("server-token", { required: true })),
    deployments: github(core.getInput("deployments-token", { required: true })),
    notify: github(core.getInput("notification-token", { required: true })),
    config,
    reloadConfig: () => loadCurrentServerConfig(configReader, serverRepository, configPath),
    repository: core.getInput("repository", { required: true }).toLowerCase(),
    serverRepository,
    serverRun: { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") },
    now: () => new Date(),
  };
  const args = JSON.parse(core.getInput("args", { required: true })) as MergeArgs;
  const result = await acceptMerge(ctx, args);
  if (result.reservation) core.setOutput("reservation-id", String(result.reservation.deploymentId));
  core.info(`merge command ${result.kind}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
