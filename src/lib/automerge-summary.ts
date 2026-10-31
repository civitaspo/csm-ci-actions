import * as core from "@actions/core";
import { escapeHtml } from "./notify.ts";
import { type ReservationRecord } from "./automerge-github.ts";

type SummaryArgs = { record: ReservationRecord; repository?: string; serverRepository: string; serverUrl: string; runUrl: string; state: string; displayFailure?: boolean; displaySyncFailure?: boolean; displayDeploymentId?: number };

export function reservationSummary(args: SummaryArgs, observedAt: Date): string {
  const { record } = args;
  const repository = args.repository ?? record.payload.repository;
  const pullUrl = `${args.serverUrl}/${repository}/pull/${record.payload.pull_number}`;
  const apiUrl = `https://api.github.com/repos/${args.serverRepository}/deployments/${record.deploymentId}`;
  return `<h3>Automerge reservation ${record.deploymentId}</h3>\n<ul><li>Client PR: <a href="${escapeHtml(pullUrl)}">${escapeHtml(repository)}#${record.payload.pull_number}</a></li><li>Server: ${escapeHtml(args.serverRepository)}; <a href="${escapeHtml(apiUrl)}">Deployment ${record.deploymentId} (API JSON)</a></li><li>Observed: ${escapeHtml(args.state)} at ${observedAt.toISOString()}</li><li><a href="${escapeHtml(args.runUrl)}">Server Actions run</a></li>${args.displayDeploymentId ? `<li>Client display Deployment ${args.displayDeploymentId}; <a href="${escapeHtml(`${args.serverUrl}/${repository}/deployments/${"csm-ci-automerge-display"}`)}">environment list</a></li>` : ""}${args.displayFailure ? "<li>Display commit unavailable; reservation uses the default branch.</li>" : ""}${args.displaySyncFailure ? "<li>Client display synchronization unavailable.</li>" : ""}</ul>\n`;
}

export async function summarizeReservation(args: SummaryArgs): Promise<void> {
  try { await core.summary.addRaw(reservationSummary(args, new Date())).write(); } catch { core.warning("Unable to write automerge reservation summary"); }
}
