import * as core from "@actions/core";
import { type MergeArgs, type MergeContext, acceptMerge } from "../lib/merge.ts";
import { github, loadCurrentServerConfig } from "../lib/github.ts";
import { summarizeReservation } from "../lib/automerge-summary.ts";
import { syncAutomergeDisplay } from "../lib/automerge-display.ts";

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
  const displayToken = core.getInput("display-commit-token");
  const ctx: MergeContext = {
    server: github(core.getInput("server-token", { required: true })),
    deployments: github(core.getInput("deployments-token", { required: true })),
    ...(displayToken ? { displayCommit: github(displayToken) } : {}),
    notify: github(core.getInput("notification-token", { required: true })),
    config,
    reloadConfig: () => loadCurrentServerConfig(configReader, serverRepository, configPath),
    repository: core.getInput("repository", { required: true }).toLowerCase(),
    serverRepository,
    serverRun: { serverUrl: env("GITHUB_SERVER_URL"), repository: serverRepository, id: env("GITHUB_RUN_ID"), attempt: env("GITHUB_RUN_ATTEMPT") },
    onAcceptanceFailure: (record, displayFailure) => summarizeReservation({ record, serverRepository, serverUrl: env("GITHUB_SERVER_URL"), runUrl: `${env("GITHUB_SERVER_URL")}/${serverRepository}/actions/runs/${env("GITHUB_RUN_ID")}/attempts/${env("GITHUB_RUN_ATTEMPT")}`, state: "reservation created; acceptance incomplete", displayFailure }),
    now: () => new Date(),
  };
  const args = JSON.parse(core.getInput("args", { required: true })) as MergeArgs;
  const result = await acceptMerge(ctx, args);
  if (result.reservation) core.setOutput("reservation-id", String(result.reservation.deploymentId));
  if (result.reservation) {
    const state = result.kind === "accepted" ? `queued: waiting for approval of ${result.reservation.payload.accepted_head.slice(0, 7)}` : result.kind === "cancelled" ? "inactive: cancelled" : result.reservation.state.kind === "active" ? `active: ${result.reservation.state.waitingReason ?? "waiting"}` : `${result.reservation.state.state}: ${result.reservation.state.reason}`;
    const runUrl = `${ctx.serverRun.serverUrl}/${serverRepository}/actions/runs/${ctx.serverRun.id}/attempts/${ctx.serverRun.attempt}`;
    const displayToken = core.getInput("display-deployments-token");
    const display = await syncAutomergeDisplay({ server: ctx.deployments, reader: ctx.server, ...(displayToken ? { client: github(displayToken) } : {}), serverRepository, repository: ctx.repository, serverBotId: config.apps.server_bot_id, record: result.reservation, runUrl, now: ctx.now() });
    if (display.kind === "unavailable") core.warning("Client display synchronization unavailable");
    await summarizeReservation({ record: result.reservation, serverRepository, serverUrl: ctx.serverRun.serverUrl, runUrl, state, displayFailure: Boolean(result.displayFailure), displaySyncFailure: display.kind === "unavailable", ...(display.kind === "synced" && display.deploymentId ? { displayDeploymentId: display.deploymentId } : {}) });
  }
  core.info(`merge command ${result.kind}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
