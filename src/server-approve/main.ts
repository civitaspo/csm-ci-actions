import * as core from "@actions/core";
import { runApprove } from "../lib/approve.ts";
import { github, loadConfig } from "../lib/github.ts";

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
  const managedDeploymentsToken = core.getInput("managed-deployments-token");
  const outcome = await runApprove(
    {
      server: github(core.getInput("server-token", { required: true })),
      approver: github(core.getInput("approver-token", { required: true })),
      config,
      managedSource: {
        source,
        serverRepository,
        configSha,
        configPath,
        ...(managedDeploymentsToken ? { deployments: github(managedDeploymentsToken) } : {}),
      },
      repository: core.getInput("repository", { required: true }),
      serverRun: { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") },
      now: () => new Date(),
    },
    JSON.parse(core.getInput("args", { required: true })),
  );
  core.setOutput("result", outcome.result);
  core.info(`${outcome.result} at ${outcome.head}`);
  for (const p of outcome.problems) core.info(`  ${p}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
