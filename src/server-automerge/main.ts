import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { createReservationStatus, findReservationsForPull, listReservations } from "../lib/automerge-github.ts";
import { terminalDescription } from "../lib/automerge.ts";
import { github, loadCurrentServerConfig, splitRepository } from "../lib/github.ts";
import { deriveManagedPullAttestation } from "../lib/managed-pull-context.ts";
import { ReleasedRevision } from "../lib/generated-workflows.ts";
import { managedDriftDispatchState, verifyManagedMergeTree } from "../lib/managed-pull.ts";
import { summarizeReservation } from "../lib/automerge-summary.ts";
import { syncAutomergeDisplay } from "../lib/automerge-display.ts";
import { evaluateMergeReadiness, evaluateReservation, mergeReservation, type MergeContext } from "../lib/merge.ts";
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
      const display = readToken ? await syncAutomergeDisplay({ server: deployments, reader: github(readToken), ...(displayToken ? { client: github(displayToken) } : {}), serverRepository, repository, serverBotId: config.apps.server_bot_id, record, runUrl, now: new Date() }) : { kind: "unavailable" as const, reason: "client read token unavailable" };
      if (display.kind === "unavailable") core.warning(`Client display synchronization unavailable: ${display.reason}`);
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
    attestManagedPull: async ({ repository, pullNumber, reservation }) => {
      const { owner, repo } = splitRepository(serverRepository);
      const { data: serverInfo } = await configReader.rest.repos.get({ owner, repo });
      if (!serverInfo.default_branch) throw new Error("server default branch is unavailable for managed-pull validation");
      const { data: defaultRef } = await configReader.rest.git.getRef({ owner, repo, ref: `heads/${serverInfo.default_branch}` });
      return deriveManagedPullAttestation({
        source: configReader,
        target: server,
        serverRepository,
        configSha: defaultRef.object.sha,
        configPath,
        workflowRelease: ReleasedRevision.parse({ version: reservation.release_version, sha: reservation.release_sha }),
        repository,
        pullNumber,
      });
    },
    managedReadiness: async ({ repository, pull, reservation }) => {
      const serverInfo = await configReader.rest.repos.get(splitRepository(serverRepository));
      if (!serverInfo.data.default_branch) throw new Error("server default branch is unavailable for managed policy validation");
      const defaultRef = await configReader.rest.git.getRef({ ...splitRepository(serverRepository), ref: `heads/${serverInfo.data.default_branch}` });
      const managedSource = {
        source: configReader,
        serverRepository,
        configSha: defaultRef.data.object.sha,
        configPath,
        workflowRelease: ReleasedRevision.parse({ version: reservation.release_version, sha: reservation.release_sha }),
      };
      return evaluateMergeReadiness({ server, config: ctx.config, repository }, pull, managedSource);
    },
    verifyManagedMerge: async ({ repository: targetRepository, mergeCommit, reservation }) => {
      if (targetRepository.toLowerCase() !== reservation.repository.toLowerCase()) {
        return { matches: false, reason: "managed merge target identity changed; reconciliation was not dispatched" };
      }
      const verification = await verifyManagedMergeTree({
        source: configReader,
        target: server,
        serverRepository,
        serverBotId: ctx.config.apps.server_bot_id,
        configPath,
        reservation,
        mergeCommit,
      });
      if (verification.matches) return verification;
      try {
        const { owner, repo } = splitRepository(serverRepository);
        const { data: serverInfo } = await configReader.rest.repos.get({ owner, repo });
        if (!serverInfo.default_branch) throw new Error("server default branch is unavailable");
        const readDispatchState = async (notBefore?: Date) => {
          const runs = await configReader.paginate(configReader.rest.actions.listWorkflowRuns, {
            owner,
            repo,
            workflow_id: "csm-ci-repo-settings.yml",
            event: "workflow_dispatch",
            per_page: 100,
          });
          return managedDriftDispatchState({
            runs: runs.map((run) => ({
              displayTitle: run.display_title,
              headBranch: run.head_branch,
              event: run.event,
              status: run.status ?? "",
              conclusion: run.conclusion ?? null,
              actorId: run.actor?.id == null ? null : Number(run.actor.id),
              actorLogin: run.actor?.login ?? null,
              createdAt: run.created_at,
            })),
            repository: reservation.repository,
            mergeCommit,
            defaultBranch: serverInfo.default_branch,
            ...(notBefore ? { notBefore } : {}),
          });
        };
        const dispatchState = await readDispatchState();
        if (dispatchState === "already-running" || dispatchState === "already-succeeded") {
          const detail = dispatchState === "already-succeeded" ? "already completed successfully" : "is already queued or running";
          return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; managed-files reconciliation ${detail}` };
        }
        const driftKey = createHash("sha256").update(`${reservation.repository.toLowerCase()}#${mergeCommit}`).digest("hex");
        const dispatchStartedAt = new Date();
        try {
          await configReader.rest.actions.createWorkflowDispatch({
            owner,
            repo,
            workflow_id: "csm-ci-repo-settings.yml",
            ref: serverInfo.default_branch,
            inputs: { repository: reservation.repository.toLowerCase(), targets: "managed-files", "managed-drift-key": driftKey },
          });
        } catch (dispatchError) {
          let lastReadError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
            try {
              const recovered = await readDispatchState(dispatchStartedAt);
              if (recovered === "already-running" || recovered === "already-succeeded") {
                return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; reconciliation run was found after an ambiguous dispatch response` };
              }
              if (recovered === "previous-failed") {
                return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; reconciliation run was created but failed after an ambiguous dispatch response` };
              }
            } catch (error) {
              lastReadError = error;
            }
          }
          const writeMessage = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
          const readMessage = lastReadError instanceof Error ? `; run lookup also failed: ${lastReadError.message}` : "; no matching run appeared in bounded recovery lookup";
          return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; dispatch response was ambiguous and no retry was attempted: ${writeMessage}${readMessage}` };
        }
        return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; managed-files reconciliation dispatched` };
      } catch (error) {
        const dispatchError = error instanceof Error ? error.message : String(error);
        return { ...verification, reason: `${verification.reason ?? "merged tree differs from the accepted managed manifest"}; managed-files reconciliation dispatch failed: ${dispatchError}` };
      }
    },
    now: () => new Date(),
  };
  const summarize = async (state: string): Promise<void> => {
    const runUrl = `${serverRun.serverUrl}/${serverRepository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`;
    const token = core.getInput("display-deployments-token");
    const display = await syncAutomergeDisplay({ server: deployments, reader: server, ...(token ? { client: github(token) } : {}), serverRepository, repository, serverBotId: config.apps.server_bot_id, record, runUrl, now: new Date() });
    if (display.kind === "unavailable") core.warning(`Client display synchronization unavailable: ${display.reason}`);
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
