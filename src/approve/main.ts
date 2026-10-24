import * as core from "@actions/core";
import { runApprove } from "../lib/approve.ts";
import { github, loadConfig } from "../lib/github.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const config = await loadConfig(github(core.getInput("github-token", { required: true })), env("GITHUB_REPOSITORY"), env("GITHUB_SHA"), core.getInput("config-path", { required: true }));
  const outcome = await runApprove(
    {
      server: github(core.getInput("server-token", { required: true })),
      approver: github(core.getInput("approver-token", { required: true })),
      config,
      repository: core.getInput("repository", { required: true }),
      now: () => new Date(),
    },
    JSON.parse(core.getInput("args", { required: true })),
  );
  core.setOutput("result", outcome.result);
  core.info(`${outcome.result} at ${outcome.head}`);
  for (const p of outcome.problems) core.info(`  ${p}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
