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
  const source = github(core.getInput("github-token", { required: true }));
  const serverRepository = env("GITHUB_REPOSITORY");
  const configSha = env("GITHUB_SHA");
  const configPath = core.getInput("config-path", { required: true });
  const config = await loadConfig(source, serverRepository, configSha, configPath);
  const server = github(core.getInput("server-token", { required: true }));
  const managedDeploymentsToken = core.getInput("managed-deployments-token");
  const repository = core.getInput("repository", { required: true });
  const pull = await fetchPull(server, repository, Number(core.getInput("pull-number", { required: true })));
  const outcome = await runPolicyCheck({
    server,
    config,
    repository,
    pull,
    managedSource: {
      source,
      serverRepository,
      configSha,
      configPath,
      ...(managedDeploymentsToken ? { deployments: github(managedDeploymentsToken) } : {}),
    },
    serverRun: { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") },
  });
  if (outcome.result === "skipped") {
    core.setOutput("result", "skipped");
    core.info(`Policy check skipped: ${outcome.reason}`);
    return;
  }
  const results = outcome.results;
  core.setOutput("result", results.every((r) => r.ok) ? "success" : "failure");
  core.info(policySummary(results));
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
