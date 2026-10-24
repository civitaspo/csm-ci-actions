import * as core from "@actions/core";
import { fetchPull } from "../lib/approve.ts";
import { github, loadConfig } from "../lib/github.ts";
import { runPolicyCheck, policySummary } from "../lib/policy-check.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const config = await loadConfig(github(core.getInput("github-token", { required: true })), env("GITHUB_REPOSITORY"), env("GITHUB_SHA"), core.getInput("config-path", { required: true }));
  const server = github(core.getInput("server-token", { required: true }));
  const repository = core.getInput("repository", { required: true });
  const pull = await fetchPull(server, repository, Number(core.getInput("pull-number", { required: true })));
  const results = await runPolicyCheck({ server, config, repository, pull });
  core.setOutput("result", results.every((r) => r.ok) ? "success" : "failure");
  core.info(policySummary(results));
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
