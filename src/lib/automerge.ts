import { z } from "zod";

const ReservationPayloadSchema = z.strictObject({
  version: z.literal(1),
  repository_id: z.number().int().positive(),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  pull_number: z.number().int().positive(),
  pull_node_id: z.string().min(1),
  base_ref: z.string().min(1),
  merger: z.strictObject({ id: z.number().int().positive(), login: z.string().min(1), type: z.enum(["User", "Bot"]) }),
  mode: z.enum(["human", "bot"]),
  command_comment_id: z.number().int().positive(),
  accepted_head: z.string().regex(/^[0-9a-f]{40}$/),
  accepted_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
}).refine((payload) => Date.parse(payload.expires_at) === Date.parse(payload.accepted_at) + 7 * 24 * 60 * 60 * 1000, {
  message: "expires_at must be exactly seven days after accepted_at",
  path: ["expires_at"],
}).refine((payload) => (payload.mode === "bot") === (payload.merger.type === "Bot"), {
  message: "mode must match the merger type",
  path: ["mode"],
});

type ReservationPayload = z.infer<typeof ReservationPayloadSchema>;
type TerminalState = "success" | "failure" | "inactive";
type DeploymentStatus = {
  id: number;
  state: "queued" | TerminalState | "error";
  description: string | null;
  createdAt: string;
  creator: { type: "Bot"; databaseId: number } | { type: "Other" };
};
type ReservationState =
  | { kind: "active"; waitingReason?: string }
  | { kind: "terminal"; state: TerminalState; at: string; description: string | null; reason: TerminalReason };

type TerminalReason = "external-merge" | "closed" | "expired" | "invalidated" | "rejected" | "merged" | "cancelled" | "other";

const terminalReasonPrefix = "csm-ci:automerge:reason=";
const terminalReasons: readonly TerminalReason[] = ["external-merge", "closed", "expired", "invalidated", "rejected", "merged", "cancelled", "other"];

function terminalReason(description: string | null): TerminalReason {
  const match = description?.match(/^csm-ci:automerge:reason=([a-z-]+)\|/);
  return terminalReasons.find((reason) => reason === match?.[1]) ?? "other";
}

function terminalDescription(reason: TerminalReason, description: string): string {
  return `${terminalReasonPrefix}${reason}| ${description}`;
}

function reservationState(args: { statuses: readonly DeploymentStatus[]; serverBotId: number }): ReservationState {
  const statuses = args.statuses.filter((status) => status.creator.type === "Bot" && status.creator.databaseId === args.serverBotId);
  const terminal = statuses.filter((status): status is DeploymentStatus & { state: TerminalState } => status.state === "success" || status.state === "failure" || status.state === "inactive")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)[0];
  if (terminal) return { kind: "terminal", state: terminal.state, at: terminal.createdAt, description: terminal.description, reason: terminalReason(terminal.description) };
  const latestQueued = statuses.filter((status): status is DeploymentStatus & { state: "queued" } => status.state === "queued")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)[0];
  return latestQueued?.description ? { kind: "active", waitingReason: latestQueued.description } : { kind: "active" };
}

type PullFacts = {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
};
type Readiness = { kind: "ready" } | { kind: "waiting"; reason: string };
type Decision =
  | { kind: "terminal"; state: TerminalState; reason: TerminalReason; description: string; comment: "none" | "complete" }
  | { kind: "wait"; reason: string }
  | { kind: "merge"; head: string };

function decide(args: {
  reservation: { state: ReservationState; payload: ReservationPayload };
  pull: PullFacts;
  now: Date;
  trustValid: boolean;
  mergeEnabled: boolean;
  allowBotRequests: boolean;
  botCommitsValid: boolean;
  readiness: Readiness;
}): Decision {
  const { state, payload } = args.reservation;
  if (state.kind === "terminal") {
    const description = state.description ?? "";
    const noComment = state.reason === "external-merge" || state.reason === "closed";
    return { kind: "terminal", state: state.state, reason: state.reason, description, comment: noComment ? "none" : "complete" };
  }
  if (args.pull.merged) return { kind: "terminal", state: "success", reason: "external-merge", description: "merged outside csm-ci", comment: "none" };
  if (args.pull.state === "closed") return { kind: "terminal", state: "inactive", reason: "closed", description: "pull request closed", comment: "none" };
  if (args.now.getTime() >= Date.parse(payload.expires_at)) return { kind: "terminal", state: "inactive", reason: "expired", description: "expired", comment: "complete" };
  if (!args.trustValid) return { kind: "terminal", state: "inactive", reason: "invalidated", description: "merger is no longer trusted", comment: "complete" };
  if (!args.mergeEnabled) return { kind: "terminal", state: "inactive", reason: "invalidated", description: "merge is disabled", comment: "complete" };
  if (payload.mode === "bot" && !args.allowBotRequests) return { kind: "terminal", state: "inactive", reason: "invalidated", description: "bot merge requests are disabled", comment: "complete" };
  if (args.pull.baseRef !== payload.base_ref) return { kind: "terminal", state: "inactive", reason: "invalidated", description: "base branch changed", comment: "complete" };
  if (payload.mode === "bot" && !args.botCommitsValid) return { kind: "terminal", state: "failure", reason: "rejected", description: `a commit is not authored by ${payload.merger.login}`, comment: "complete" };
  if (args.pull.draft) return { kind: "wait", reason: "draft" };
  if (args.readiness.kind === "waiting") return { kind: "wait", reason: args.readiness.reason };
  return { kind: "merge", head: args.pull.headSha };
}

function canCancelReservation(args: { commenterId: number; trustedMergerIds: readonly number[]; reservationMergerId: number }): boolean {
  return args.commenterId === args.reservationMergerId || args.trustedMergerIds.includes(args.commenterId);
}

type AutomergeEvent = "accepted" | "merged" | "expired" | "cancelled" | "invalidated" | "rejected";
const AUTOMERGE_LABEL = "csm-ci/automerge";
function automergeMarker(deploymentId: number, event: AutomergeEvent): string {
  return `<!-- csm-ci:automerge:${deploymentId}:${event} -->`;
}
function truncateDeploymentDescription(description: string): string {
  const characters = Array.from(description);
  return characters.length <= 140 ? description : `${characters.slice(0, 139).join("")}…`;
}

export {
  AUTOMERGE_LABEL,
  ReservationPayloadSchema,
  automergeMarker,
  canCancelReservation,
  decide,
  reservationState,
  terminalDescription,
  truncateDeploymentDescription,
};
export type { Decision, DeploymentStatus, ReservationPayload, ReservationState, TerminalReason, TerminalState };
