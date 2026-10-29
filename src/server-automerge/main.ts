import * as core from "@actions/core";
import { createReservationStatus, findReservationsForPull, listReservations } from "../lib/automerge-github.ts";
import { github, loadCurrentServerConfig, splitRepository } from "../lib/github.ts";
import { evaluateReservation, mergeReservation, type MergeContext } from "../lib/merge.ts";
import { automergeConcurrencyKey } from "../lib/request.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const mode = core.getInput("mode", { required: true });
  const serverRepository = env("GITHUB_REPOSITORY");
  const configReader = github(core.getInput("github-token", { required: true }));
  const configPath = core.getInput("config-path", { required: true });
  const config = await loadCurrentServerConfig(configReader, serverRepository, configPath);
  const deployments = github(core.getInput("deployments-token", { required: true }));
  const listArgs = { server: deployments, serverRepository, serverBotId: config.apps.server_bot_id, now: new Date() };
  if (mode === "list") {
    const reservations = await listReservations(listArgs);
    const discovery = github(core.getInput("discovery-token", { required: true }));
    const installed = await discovery.paginate("GET /installation/repositories", { per_page: 100 });
    const repositories = new Map(installed.map((repo) => [repo.id, repo.full_name]));
    const latestByPull = new Map<string, (typeof reservations)[number]>();
    for (const record of reservations) {
      const key = `${record.payload.repository_id}#${record.payload.pull_number}`;
      if (!latestByPull.has(key)) latestByPull.set(key, record);
    }
    const latest = [...latestByPull.values()].reverse();
    const selected = latest.flatMap((record) => {
      const repository = repositories.get(record.payload.repository_id);
      if (!repository) {
        core.warning(`Automerge repository ID ${record.payload.repository_id} is not installed; skipping reservation ${record.deploymentId}`);
        return [];
      }
      return [{ record, repository }];
    });
    if (selected.length > 256) core.warning(`Automerge sweep has ${selected.length} reservations; evaluating the first 256`);
    const matrix = selected.slice(0, 256).map(({ record, repository }) => ({
      repository,
      repository_owner: splitRepository(repository).owner,
      repository_name: splitRepository(repository).repo,
      pull_number: record.payload.pull_number,
      deployment_id: record.deploymentId,
      concurrency_key: automergeConcurrencyKey(repository, record.payload.pull_number),
    }));
    core.setOutput("matrix", JSON.stringify(matrix));
    core.setOutput("count", String(matrix.length));
    return;
  }
  const repository = core.getInput("repository", { required: true }).toLowerCase();
  const pullNumber = Number(core.getInput("pull-number", { required: true }));
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("pull-number must be a positive integer");
  const id = core.getInput("deployment-id");
  const serverRun = { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") };
  if (mode === "error-status") {
    const records = await listReservations(listArgs);
    const record = id ? records.find((item) => String(item.deploymentId) === id && item.payload.pull_number === pullNumber) : records.find((item) => item.payload.repository.toLowerCase() === repository && item.payload.pull_number === pullNumber && item.state.kind === "active");
    if (record && record.state.kind === "active") await createReservationStatus({ server: deployments, serverRepository, serverBotId: config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, pullUrl: `${serverRun.serverUrl}/${repository}/pull/${pullNumber}`, state: "error", description: core.getInput("failure-message") || "evaluation failed" });
    return;
  }
  const server = github(core.getInput("server-token", { required: true }));
  const { data: repo } = await server.rest.repos.get(splitRepository(repository));
  const records = await findReservationsForPull({ ...listArgs, repositoryId: Number(repo.id), pullNumber });
  const record = id ? records.find((item) => String(item.deploymentId) === id) : records.find((item) => item.state.kind === "active");
  if (!record) {
    core.setOutput("ready", "false");
    return;
  }
  core.setOutput("deployment-id", String(record.deploymentId));
  const ctx: MergeContext = {
    server, deployments, serverRepository, config, repository, serverRun,
    notify: github(core.getInput("notification-token", { required: true })),
    ...(mode === "merge" ? { write: github(core.getInput("write-token", { required: true })) } : {}),
    reloadConfig: () => loadCurrentServerConfig(configReader, serverRepository, configPath),
    now: () => new Date(),
  };
  if (mode === "evaluate") {
    const evaluation = await evaluateReservation(ctx, record);
    core.setOutput("ready", String(evaluation.ready));
    core.setOutput("head", evaluation.head);
    return;
  }
  if (mode === "merge") {
    await mergeReservation(ctx, record, core.getInput("head", { required: true }));
    return;
  }
  throw new Error(`unknown automerge action mode: ${mode}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
