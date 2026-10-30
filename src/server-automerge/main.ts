import * as core from "@actions/core";
import { createReservationStatus, findReservationsForPull, listReservations } from "../lib/automerge-github.ts";
import { terminalDescription } from "../lib/automerge.ts";
import { github, loadCurrentServerConfig, splitRepository } from "../lib/github.ts";
import { summarizeReservation } from "../lib/automerge-summary.ts";
import { syncAutomergeDisplay } from "../lib/automerge-display.ts";
import { evaluateReservation, mergeReservation, type MergeContext } from "../lib/merge.ts";
import { automergeConcurrencyKey } from "../lib/request.ts";
import { activeReservationForPullByRepositoryId, activeSweepReservations, evaluationReservation, installedRepositoryId, partitionSweepRepositories, resolveRepositoryName, sweepBatch, terminalRepairReservations } from "./sweep.ts";

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
    const repositories = new Map(installed.map((repo) => [Number(repo.id), repo.full_name]));
    const latest = activeSweepReservations(reservations);
    const serverRun = { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") };
    const { ready, expire, unavailable } = partitionSweepRepositories(latest, repositories, new Date());
    if (unavailable.length > 0) core.warning(`${unavailable.length} active automerge reservations are outside the server owner's discovery scope; evaluation will resolve them with owner-scoped tokens`);
    for (const record of expire) {
      await createReservationStatus({
        server: deployments, serverRepository, serverBotId: config.apps.server_bot_id,
        deploymentId: record.deploymentId,
        serverRunUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`,
        pullUrl: `${serverRun.serverUrl}/${record.payload.repository}/pull/${record.payload.pull_number}`,
        state: "inactive", description: terminalDescription("expired", "reservation expired while client repository was unavailable; notification unavailable"),
      });
      await summarizeReservation({ record, serverRepository, serverUrl: serverRun.serverUrl, runUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, state: "inactive: expired" });
    }
    if (ready.length > 256) core.warning(`Automerge sweep has ${ready.length} active reservations; evaluating the first 256`);
    const matrix = sweepBatch(ready).map(({ record, repository }) => ({
      repository,
      repository_owner: splitRepository(repository).owner,
      pull_number: record.payload.pull_number,
      deployment_id: record.deploymentId,
    }));
    core.setOutput("matrix", JSON.stringify(matrix));
    core.setOutput("count", String(matrix.length));
    const terminal = terminalRepairReservations(reservations, new Date());
    const repair = terminal.map((record) => ({ repository: repositories.get(record.payload.repository_id) ?? record.payload.repository, repository_owner: splitRepository(repositories.get(record.payload.repository_id) ?? record.payload.repository).owner, pull_number: record.payload.pull_number, deployment_id: record.deploymentId }));
    core.setOutput("repair-matrix", JSON.stringify(repair));
    core.setOutput("repair-count", String(repair.length));
    return;
  }
  const repository = core.getInput("repository", { required: true }).toLowerCase();
  const pullNumber = Number(core.getInput("pull-number", { required: true }));
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("pull-number must be a positive integer");
  const id = core.getInput("deployment-id");
  const serverRun = { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") };
  if (mode === "resolve" || mode === "resolve-repair") {
    if (!id) {
      const repository = core.getInput("repository", { required: true }).toLowerCase();
      const parts = splitRepository(repository);
      core.setOutput("resolved", "true");
      core.setOutput("repository", repository);
      core.setOutput("repository-owner", parts.owner);
      core.setOutput("repository-name", parts.repo);
      core.setOutput("concurrency-key", automergeConcurrencyKey(repository, pullNumber));
      return;
    }
    const records = await listReservations(listArgs);
    const record = id ? records.find((item) => String(item.deploymentId) === id && item.payload.pull_number === pullNumber && (mode === "resolve-repair" ? item.state.kind === "terminal" : item.state.kind === "active")) : undefined;
    if (!record) {
      core.setOutput("resolved", "false");
      return;
    }
    const discovery = github(core.getInput("discovery-token", { required: true }));
    const installed = await discovery.paginate("GET /installation/repositories", { per_page: 100 });
    const repository = resolveRepositoryName({ deploymentId: id, repository: core.getInput("repository"), repositoryId: record.payload.repository_id, repositories: installed });
    if (!repository) {
      if (mode === "resolve-repair") {
        core.warning("Client display repair could not resolve the repository");
        await summarizeReservation({ record, serverRepository, serverUrl: serverRun.serverUrl, runUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, state: record.state.kind === "terminal" ? `${record.state.state}: ${record.state.reason}` : "active", displaySyncFailure: true });
      }
      core.setOutput("resolved", "false");
      return;
    }
    const parts = splitRepository(repository);
    core.setOutput("resolved", "true");
    core.setOutput("repository", repository);
    core.setOutput("repository-owner", parts.owner);
    core.setOutput("repository-name", parts.repo);
    core.setOutput("concurrency-key", automergeConcurrencyKey(repository, pullNumber));
    return;
  }
  if (mode === "error-status") {
    const records = await listReservations(listArgs);
    let record = id ? records.find((item) => String(item.deploymentId) === id && item.payload.pull_number === pullNumber) : undefined;
    if (!id) {
      const discovery = github(core.getInput("discovery-token", { required: true }));
      const installed = await discovery.paginate("GET /installation/repositories", { per_page: 100 });
      const repositoryId = installedRepositoryId(installed, repository);
      if (repositoryId !== undefined) record = activeReservationForPullByRepositoryId(records, repositoryId, pullNumber);
    }
    if (record && record.state.kind === "active") {
      await createReservationStatus({ server: deployments, serverRepository, serverBotId: config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, pullUrl: `${serverRun.serverUrl}/${repository}/pull/${pullNumber}`, state: "error", description: core.getInput("failure-message") || "evaluation failed" });
      const runUrl = `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`;
      const readToken = core.getInput("server-token");
      const displayToken = core.getInput("display-deployments-token");
      const display = readToken ? await syncAutomergeDisplay({ server: deployments, reader: github(readToken), ...(displayToken ? { client: github(displayToken) } : {}), serverRepository, repository, serverBotId: config.apps.server_bot_id, record, runUrl, now: new Date() }) : { kind: "unavailable" as const };
      if (display.kind === "unavailable") core.warning("Client display synchronization unavailable");
      await summarizeReservation({ record, repository, serverRepository, serverUrl: serverRun.serverUrl, runUrl, state: "error: evaluation failed", displaySyncFailure: display.kind === "unavailable", ...(display.kind === "synced" && display.deploymentId ? { displayDeploymentId: display.deploymentId } : {}) });
    }
    if (record && record.state.kind === "terminal") {
      core.warning("Client display repair failed");
      await summarizeReservation({ record, repository, serverRepository, serverUrl: serverRun.serverUrl, runUrl: `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, state: `${record.state.state}: ${record.state.reason}`, displaySyncFailure: true });
    }
    return;
  }
  const server = github(core.getInput("server-token", { required: true }));
  const { data: repo } = await server.rest.repos.get(splitRepository(repository));
  const records = await findReservationsForPull({ ...listArgs, repositoryId: Number(repo.id), pullNumber });
  const record = evaluationReservation(records, id);
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
  const summarize = async (state: string): Promise<void> => {
    const runUrl = `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`;
    const token = core.getInput("display-deployments-token");
    const display = await syncAutomergeDisplay({ server: deployments, reader: server, ...(token ? { client: github(token) } : {}), serverRepository, repository, serverBotId: config.apps.server_bot_id, record, runUrl, now: new Date() });
    if (display.kind === "unavailable") core.warning("Client display synchronization unavailable");
    await summarizeReservation({ record, repository, serverRepository, serverUrl: serverRun.serverUrl, runUrl, state, displaySyncFailure: display.kind === "unavailable", ...(display.kind === "synced" && display.deploymentId ? { displayDeploymentId: display.deploymentId } : {}) });
  };
  if (mode === "repair") {
    await summarize(record.state.kind === "terminal" ? `${record.state.state}: ${record.state.reason}` : "active");
    return;
  }
  if (mode === "evaluate") {
    const evaluation = await evaluateReservation(ctx, record);
    const decision = evaluation.decision;
    await summarize(decision.kind === "terminal" ? `${decision.state}: ${decision.reason}` : decision.kind === "wait" ? `queued: ${decision.reason}` : "ready");
    core.setOutput("ready", String(evaluation.ready));
    core.setOutput("head", evaluation.head);
    return;
  }
  if (mode === "merge") {
    const outcome = await mergeReservation(ctx, record, core.getInput("head", { required: true }));
    await summarize(`${outcome.result}: ${outcome.mergeCommit}`);
    return;
  }
  throw new Error(`unknown automerge action mode: ${mode}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
