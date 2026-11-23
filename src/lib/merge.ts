import { type CommentFacts, checkPullState, type PullFacts, validateComment } from "./command.ts";
import { type Config, type Principal, repositoryEntry } from "./config.ts";
import { approverApprovedHead, evaluatePullPolicies } from "./policy-check.ts";
import { fetchComment } from "./approve.ts";
import { escapeHtml, hasServerMarker, marker, postResult, receiptFooter, type ServerRun } from "./notify.ts";
import { Rejection } from "./request.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";
import { AUTOMERGE_LABEL, automergeMarker, canCancelReservation, decide, ReservationPayloadSchema, terminalDescription, type Decision, type ReservationPayload } from "./automerge.ts";
import { createReservation, createReservationStatus, findReservationsForPull, type ReservationRecord } from "./automerge-github.ts";
import { createAutomergeDisplayCommit } from "./automerge-display-commit.ts";
import { type GitHub, isNetworkFailure, splitRepository } from "./github.ts";
import type { ManagedPullAttestation } from "./managed-pull.ts";
import type { ManagedPullSourceContext } from "./managed-pull-context.ts";

export type MergeArgs = { pull_number: number; comment_id: number };
export type MergeContext = {
  server: GitHub;
  deployments: GitHub;
  displayCommit?: GitHub;
  acceptanceWrite?: GitHub;
  onAcceptanceFailure?: (record: ReservationRecord, displayFailure: boolean) => Promise<void>;
  /** Must independently derive current managed state; it must not use reservation fields as expectation inputs. */
  attestManagedPull?: (args: { repository: string; pullNumber: number; reservation: Extract<ReservationPayload, { version: 2 }> }) => Promise<ManagedPullAttestation | undefined>;
  /** Must independently read the current policy source context for this evaluation. */
  managedPolicySource?: (args: { repository: string; pull: PullFacts; reservation: Extract<ReservationPayload, { version: 2 }> }) => Promise<ManagedPullSourceContext>;
  /** Compares the actual squash result with a freshly derived desired managed-file tree. */
  verifyManagedMerge?: (args: { repository: string; pullNumber: number; mergeCommit: string; reservation: Extract<ReservationPayload, { version: 2 }> }) => Promise<{ matches: boolean; reason?: string }>;
  notify: GitHub;
  write?: GitHub;
  config: Config;
  reloadConfig: () => Promise<Config>;
  repository: string;
  serverRepository: string;
  serverRun: ServerRun;
  now: () => Date;
};
// commit carries the title and body that this evaluation read and validated; the merge write uses only it.
export type Evaluation = { decision: Decision; ready: boolean; head: string; reservation: ReservationRecord; repository: string; commit?: { title: string; message: string } };
export type MergeOutcome = { result: "merged"; head: string; mergeCommit: string };
export type MergeAcceptancePreparation =
  | { kind: "accept"; pull: MergePullFacts; comment: CommentFacts; merger: Principal; mode: Extract<ReservationPayload, { version: 1 }>["mode"] }
  | { kind: "cancel"; pull: MergePullFacts; comment: CommentFacts }
  | { kind: "replay"; pull: MergePullFacts; comment: CommentFacts; reservation: ReservationRecord }
  | { kind: "conflict"; pull: MergePullFacts; comment: CommentFacts; active: ReservationRecord }
  | { kind: "external-merge"; pull: MergePullFacts; comment: CommentFacts }
  | { kind: "external-merge-replay" };

type MergePullFacts = Omit<PullFacts, "state"> & { state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; repositoryId: number; nodeId: string; title: string; body: string | null };

async function pullFacts(server: GitHub, repository: string, number: number): Promise<MergePullFacts> {
  const { data: p } = await server.rest.pulls.get({ ...splitRepository(repository), pull_number: number });
  return {
    number: p.number,
    state: p.state === "closed" ? "closed" : "open",
    merged: p.merged === true,
    mergeCommitSha: p.merge_commit_sha ?? null,
    draft: p.draft === true,
    headSha: p.head.sha,
    headRepository: p.head.repo?.full_name ?? null,
    baseRepository: p.base.repo.full_name,
    baseRef: p.base.ref,
    defaultBranch: p.base.repo.default_branch,
    authorId: Number(p.user.id),
    repositoryId: Number(p.base.repo.id),
    nodeId: p.node_id,
    title: p.title,
    body: p.body,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function principal(user: CommentFacts["user"], allowed: readonly Principal[], role: string): Principal {
  const match = user ? allowed.find((p) => p.id === user.id) : undefined;
  if (!match) throw new Rejection(`${user?.login ?? "a deleted user"} is not one of the ${role}`);
  return match;
}

async function authorizeMergeRequest(ctx: MergeContext, pull: MergePullFacts, comment: CommentFacts): Promise<{ merger: Principal; mode: Extract<ReservationPayload, { version: 1 }>["mode"] }> {
  const author = comment.user;
  if (!author) throw new Rejection("the merge comment author was deleted");
  if (author.type === "Bot") {
    const merger = principal(author, ctx.config.trust.bot_mergers, "bot mergers");
    if (repositoryEntry(ctx.config, ctx.repository)?.merge?.allow_bot_requests === false) throw new Rejection(`bot merge requests are disabled for repository ${ctx.repository}`);
    if (!(await verifyBotCommits(ctx, pull, merger))) throw new Rejection(`bot merger ${merger.login} can merge only its own pull request and commits`);
    return { merger, mode: "bot" };
  }
  if (author.type === "User") return { merger: principal(author, ctx.config.trust.mergers, "mergers"), mode: "human" };
  throw new Rejection(`${author.login} has unsupported account type ${author.type}`);
}

function checkMergedPullState(pull: MergePullFacts, integrationBranches?: readonly string[]): void {
  if (pull.state !== "closed" || !pull.merged) throw new Rejection(`#${pull.number} is ${pull.state}`);
  if (pull.headRepository?.toLowerCase() !== pull.baseRepository.toLowerCase()) throw new Rejection(`#${pull.number} comes from a fork`);
  if (pull.baseRef !== pull.defaultBranch && !integrationBranches?.includes(pull.baseRef)) {
    throw new Rejection(`#${pull.number} targets ${pull.baseRef}, not the default branch ${pull.defaultBranch} or a configured integration branch`);
  }
}

async function validateHeadBeforeComment(ctx: MergeContext, pull: PullFacts, comment: CommentFacts): Promise<void> {
  const repo = splitRepository(ctx.repository);
  const posted = new Date(comment.createdAt).getTime();
  const { data: head } = await ctx.server.rest.repos.getCommit({ ...repo, ref: pull.headSha });
  const date = head.commit.committer?.date;
  if (!date || new Date(date).getTime() > posted) throw new Rejection(`the head ${pull.headSha} is newer than comment ${comment.id}`);
  const events = await ctx.server.paginate(ctx.server.rest.issues.listEventsForTimeline, { ...repo, issue_number: pull.number, per_page: 100 });
  if (events.some((e) => "event" in e && e.event === "head_ref_force_pushed" && "created_at" in e && new Date(String(e.created_at)).getTime() >= posted)) {
    throw new Rejection(`#${pull.number} was force-pushed after comment ${comment.id}`);
  }
}

async function verifyBotCommits(ctx: MergeContext, pull: PullFacts, merger: Principal): Promise<boolean> {
  if (pull.authorId !== merger.id) return false;
  const facts = await fetchCommitFacts(ctx.server, ctx.repository, pull.number);
  const trust = evaluateTrust(facts, pull.headSha, ctx.config);
  return trust.problems.length === 0 && trust.commits.every((commit) => commit.identity.kind === "user" && commit.identity.principal.id === merger.id);
}

async function refreshConfig(ctx: MergeContext): Promise<void> {
  ctx.config = await ctx.reloadConfig();
}

function requireMergeEnabled(ctx: MergeContext): void {
  if (!repositoryEntry(ctx.config, ctx.repository)?.ops.includes("merge")) throw new Rejection(`repository ${ctx.repository} no longer enables merge`);
}

async function postAutomergeComment(ctx: MergeContext, record: ReservationRecord, event: Parameters<typeof automergeMarker>[1], text: string, head: string): Promise<void> {
  const markerText = automergeMarker(record.deploymentId, event);
  const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: record.payload.pull_number, per_page: 100 });
  if (hasServerMarker(comments, markerText, ctx.config.apps.server_bot_id)) return;
  const footer = record.payload.version === 1
    ? receiptFooter({ repository: ctx.repository, pullNumber: record.payload.pull_number, commentId: record.payload.command_comment_id, head, serverRun: ctx.serverRun })
    : `<sub><a href="${ctx.serverRun.serverUrl}/${ctx.repository}/pull/${record.payload.pull_number}">Pull request #${record.payload.pull_number}</a> · <a href="${ctx.serverRun.serverUrl}/${ctx.repository}/commit/${head}">Head ${head.slice(0, 7)}</a> · <a href="${ctx.serverRun.serverUrl}/${ctx.serverRun.repository}/actions/runs/${ctx.serverRun.id}/attempts/${ctx.serverRun.attempt}">Server run ${ctx.serverRun.id}, attempt ${ctx.serverRun.attempt}</a></sub>`;
  const body = `csm-ci: ${escapeHtml(text)}\n\n${footer}\n\n<a href="https://api.github.com/repos/${ctx.serverRepository}/deployments/${record.deploymentId}">Automerge deployment ${record.deploymentId} (API JSON)</a>`;
  try {
    await postResult(ctx.notify, ctx.repository, record.payload.pull_number, markerText, body);
  } catch (error) {
    if (![502, 503, 504].includes(status(error) ?? 0) && !isNetworkFailure(error)) throw error;
    const after = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: record.payload.pull_number, per_page: 100 });
    if (!hasServerMarker(after, markerText, ctx.config.apps.server_bot_id)) throw error;
  }
}

async function postExternalMergeReceipt(ctx: MergeContext, pullNumber: number, commentId: number, head: string): Promise<void> {
  const receipt = marker("merge-external", commentId);
  const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pullNumber, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return;
  const body = `${receipt}\ncsm-ci: pull request #${pullNumber} was merged outside csm-ci before a merge reservation was created.\n\n${receiptFooter({ repository: ctx.repository, pullNumber, commentId, head, serverRun: ctx.serverRun })}`;
  await postResult(ctx.notify, ctx.repository, pullNumber, receipt, body);
}

async function setLabel(ctx: MergeContext, pullNumber: number, shouldHave: boolean): Promise<void> {
  const repo = splitRepository(ctx.repository);
  const labels = await ctx.notify.paginate(ctx.notify.rest.issues.listLabelsOnIssue, { ...repo, issue_number: pullNumber, per_page: 100 });
  const exists = labels.some((label) => label.name === AUTOMERGE_LABEL);
  if (exists === shouldHave) return;
  if (shouldHave) {
    try {
      await ctx.notify.rest.issues.addLabels({ ...repo, issue_number: pullNumber, labels: [AUTOMERGE_LABEL] });
    } catch (error) {
      if (status(error) !== 422) throw error;
      await ctx.notify.rest.issues.createLabel({ ...repo, name: AUTOMERGE_LABEL, color: "0e8a16", description: "Merged or queued for merge by csm-ci" });
      await ctx.notify.rest.issues.addLabels({ ...repo, issue_number: pullNumber, labels: [AUTOMERGE_LABEL] });
    }
  } else {
    await ctx.notify.rest.issues.removeLabel({ ...repo, issue_number: pullNumber, name: AUTOMERGE_LABEL });
  }
}

async function postCancelNoop(ctx: MergeContext, pullNumber: number, commentId: number, head: string): Promise<void> {
  const receipt = `<!-- csm-ci:automerge:cancel:${commentId} -->`;
  const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pullNumber, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return;
  const body = `${receipt}\ncsm-ci: no active merge reservation was found to cancel.\n\n${receiptFooter({ repository: ctx.repository, pullNumber, commentId, head, serverRun: ctx.serverRun })}`;
  await postResult(ctx.notify, ctx.repository, pullNumber, receipt, body);
}

async function postCancelReceipt(ctx: MergeContext, record: ReservationRecord, commentId: number, message: string): Promise<void> {
  const receipt = `<!-- csm-ci:automerge:cancel:${commentId} -->`;
  const eventMarker = `<!-- csm-ci:automerge:${record.deploymentId}:cancelled -->`;
  const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: record.payload.pull_number, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return;
  const footer = record.payload.version === 1
    ? receiptFooter({ repository: ctx.repository, pullNumber: record.payload.pull_number, commentId, head: record.payload.accepted_head, serverRun: ctx.serverRun })
    : `<sub><a href="${ctx.serverRun.serverUrl}/${ctx.repository}/pull/${record.payload.pull_number}">Pull request #${record.payload.pull_number}</a> · <a href="${ctx.serverRun.serverUrl}/${ctx.serverRun.repository}/actions/runs/${ctx.serverRun.id}/attempts/${ctx.serverRun.attempt}">Server run ${ctx.serverRun.id}, attempt ${ctx.serverRun.attempt}</a></sub>`;
  const body = `${receipt}\n${eventMarker}\n${message}\n\n${footer}`;
  await postResult(ctx.notify, ctx.repository, record.payload.pull_number, receipt, body);
}

async function requiredChecks(ctx: Pick<MergeContext, "server" | "config" | "repository">, pull: PullFacts): Promise<{ ok: boolean; problems: string[] }> {
  const runs = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { ...splitRepository(ctx.repository), ref: pull.headSha, per_page: 100 });
  const problems: string[] = [];
  for (const required of ctx.config.merge.required_checks) {
    const latest = runs.filter((run) => run.name === required.name && run.app?.id === required.app_id)
      .reduce<(typeof runs)[number] | undefined>((current, run) => !current || String(run.started_at ?? "") > String(current.started_at ?? "") || (run.started_at === current.started_at && run.id > current.id) ? run : current, undefined);
    if (!latest || latest.status !== "completed" || !["success", "skipped"].includes(latest.conclusion ?? "")) problems.push(`${required.name} from app ${required.app_id} is not success or skipped`);
  }
  return { ok: problems.length === 0, problems };
}

export async function evaluateMergeReadiness(ctx: Pick<MergeContext, "server" | "config" | "repository">, pull: PullFacts, managedSource?: ManagedPullSourceContext): Promise<{ kind: "ready" } | { kind: "waiting"; reason: string }> {
  const facts = await evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull, ...(managedSource ? { managedSource } : {}) });
  return finishMergeReadiness(ctx, pull, facts);
}

async function evaluateManagedMergeReadiness(ctx: Pick<MergeContext, "server" | "config" | "repository">, pull: PullFacts, managedSource: ManagedPullSourceContext, attestation: ManagedPullAttestation): Promise<{ kind: "ready" } | { kind: "waiting"; reason: string }> {
  const release = managedSource.workflowRelease;
  if (managedSource.configSha !== attestation.configSha || !release || release.version !== attestation.releaseVersion || release.sha !== attestation.releaseSha) {
    return { kind: "waiting", reason: "managed-file provenance changed during evaluation" };
  }
  const facts = await evaluatePullPolicies({
    server: ctx.server,
    config: ctx.config,
    repository: ctx.repository,
    pull,
    managedSource,
    deriveManagedPull: async () => attestation,
  });
  return finishMergeReadiness(ctx, pull, facts);
}

async function finishMergeReadiness(ctx: Pick<MergeContext, "server" | "config" | "repository">, pull: PullFacts, facts: Awaited<ReturnType<typeof evaluatePullPolicies>>): Promise<{ kind: "ready" } | { kind: "waiting"; reason: string }> {
  const failures = facts.filter((result) => !result.ok).flatMap((result) => result.problems.map((problem) => `${result.type}: ${problem}`));
  if (failures.length) return { kind: "waiting", reason: `policies failed: ${failures.join("; ")}` };
  if (!(await approverApprovedHead(ctx.server, ctx.config, ctx.repository, pull))) return { kind: "waiting", reason: `waiting for approval of ${pull.headSha.slice(0, 7)}` };
  const checks = await requiredChecks(ctx, pull);
  if (!checks.ok) return { kind: "waiting", reason: `waiting for check ${checks.problems[0]}` };
  return { kind: "ready" };
}

async function readiness(ctx: MergeContext, pull: PullFacts): Promise<{ kind: "ready" } | { kind: "waiting"; reason: string }> {
  return evaluateMergeReadiness(ctx, pull);
}

function matchesManagedAttestation(record: ReservationRecord, attestation: ManagedPullAttestation, pull: MergePullFacts): boolean {
  const payload = record.payload;
  return payload.version === 2 && attestation.repositoryId === payload.repository_id && attestation.repository.toLowerCase() === payload.repository.toLowerCase() &&
    attestation.pullNumber === payload.pull_number && attestation.pullNodeId === payload.pull_node_id && attestation.baseRef === payload.base_ref &&
    attestation.headSha === payload.accepted_head && attestation.configSha === payload.configuration_sha && attestation.releaseSha === payload.release_sha && attestation.releaseVersion === payload.release_version &&
    attestation.baseSha === payload.accepted_base && attestation.manifestDigest === payload.manifest_digest && pull.repositoryId === payload.repository_id && pull.nodeId === payload.pull_node_id &&
    pull.baseRef === payload.base_ref && pull.headSha === payload.accepted_head;
}

export async function prepareMergeAcceptance(ctx: MergeContext, args: MergeArgs): Promise<MergeAcceptancePreparation> {
  await refreshConfig(ctx);
  const pull = await pullFacts(ctx.server, ctx.repository, args.pull_number);
  const comment = await fetchComment(ctx.server, ctx.repository, args.comment_id);
  const command = validateComment(comment, ctx.repository, pull.number, ctx.now());
  if (command.name === "merge-cancel") {
    const records = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: pull.repositoryId, pullNumber: pull.number, now: ctx.now() });
    authorizeCancellation({ author: comment.user, trustedMergerIds: ctx.config.trust.mergers.map((item) => item.id), records, commentId: comment.id });
    return { kind: "cancel", pull, comment };
  }
  if (command.name !== "merge") throw new Rejection(`comment ${comment.id} is not /merge`);
  const existing = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: pull.repositoryId, pullNumber: pull.number, now: ctx.now() });
  const replay = existing.find((record) => record.payload.version === 1 && record.payload.command_comment_id === comment.id);
  if (replay) return { kind: "replay", pull, comment, reservation: replay };
  const oldReceipts = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(oldReceipts, marker("merge", comment.id), ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${comment.id} was already handled`);
  if (hasServerMarker(oldReceipts, marker("merge-external", comment.id), ctx.config.apps.server_bot_id)) return { kind: "external-merge-replay" };
  requireMergeEnabled(ctx);
  const integrationBranches = repositoryEntry(ctx.config, ctx.repository)?.integration_branches;
  let authorization: { merger: Principal; mode: Extract<ReservationPayload, { version: 1 }>["mode"] };
  if (pull.merged) {
    checkMergedPullState(pull, integrationBranches);
    await validateHeadBeforeComment(ctx, pull, comment);
    authorization = await authorizeMergeRequest(ctx, pull, comment);
  } else {
    checkPullState(pull, { allowDraft: true, ...(integrationBranches === undefined ? {} : { integrationBranches }) });
    await validateHeadBeforeComment(ctx, pull, comment);
    authorization = await authorizeMergeRequest(ctx, pull, comment);
  }
  const active = existing.find((record) => record.state.kind === "active");
  if (active) return { kind: "conflict", pull, comment, active };
  if (pull.merged) return { kind: "external-merge", pull, comment };
  return { kind: "accept", pull, comment, ...authorization };
}

async function rejectActiveReservation(ctx: MergeContext, pull: MergePullFacts, comment: CommentFacts, active: ReservationRecord): Promise<never> {
    const markerText = `<!-- csm-ci:automerge:merge:${comment.id}:rejected -->`;
    const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
    if (!hasServerMarker(comments, markerText, ctx.config.apps.server_bot_id)) {
      const owner = active.payload.version === 1 ? ` by ${active.payload.merger.login}` : " by the managed-files operation";
      const body = `${markerText}\nPull request is already reserved${owner}.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: comment.id, head: pull.headSha, serverRun: ctx.serverRun })}`;
      await postResult(ctx.notify, ctx.repository, pull.number, markerText, body);
    }
    throw new Rejection(`pull request #${pull.number} already has an active merge reservation`);
}

export async function acceptMerge(ctx: MergeContext, args: MergeArgs): Promise<{ kind: "accepted" | "replay" | "cancelled" | "cancel-noop" | "external-merge"; reservation?: ReservationRecord; displayFailure?: string }> {
  const prepared = await prepareMergeAcceptance(ctx, args);
  if (prepared.kind === "cancel") return cancelReservation(ctx, prepared.pull, prepared.comment, args);
  if (prepared.kind === "external-merge") {
    await postExternalMergeReceipt(ctx, prepared.pull.number, prepared.comment.id, prepared.pull.headSha);
    return { kind: "external-merge" };
  }
  if (prepared.kind === "external-merge-replay") return { kind: "external-merge" };
  if (prepared.kind === "conflict") return rejectActiveReservation(ctx, prepared.pull, prepared.comment, prepared.active);
  if (prepared.kind === "replay") {
    const { pull, reservation: replay } = prepared;
    if (replay.state.kind === "active") {
      await postAutomergeComment(ctx, replay, "accepted", `Merge reserved until ${replay.payload.expires_at}. It follows head changes and requires approval and checks for the current head. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, replay.payload.accepted_head);
      await setLabel(ctx, pull.number, true);
    }
    return { kind: "replay", reservation: replay };
  }
  const { pull, comment, merger, mode } = prepared;
  const acceptanceWrite = ctx.acceptanceWrite;
  if (!acceptanceWrite) throw new Error("acceptance pull request write token is required");
  await disableAutoMerge(ctx, acceptanceWrite, pull.number);
  const afterDisarm = await pullFacts(ctx.server, ctx.repository, pull.number);
  if (afterDisarm.merged) {
    await postExternalMergeReceipt(ctx, pull.number, comment.id, afterDisarm.headSha);
    return { kind: "external-merge" };
  }
  if (afterDisarm.state !== "open" || afterDisarm.repositoryId !== pull.repositoryId || afterDisarm.nodeId !== pull.nodeId || afterDisarm.headSha !== pull.headSha || afterDisarm.baseRef !== pull.baseRef) {
    throw new Rejection(`pull request #${pull.number} changed while disabling GitHub auto-merge; retry /merge after reviewing the current pull request`);
  }
  const autoMerge = await fetchAutoMergeRequest(ctx.server, ctx.repository, pull.number);
  if (autoMerge) throw new Rejection(`GitHub auto-merge is still enabled for pull request #${pull.number}; csm-ci could not safely accept the request`);
  const acceptedAt = ctx.now();
  const parsedPayload = ReservationPayloadSchema.parse({
    version: 1,
    repository_id: pull.repositoryId,
    repository: ctx.repository,
    pull_number: pull.number,
    pull_node_id: pull.nodeId,
    base_ref: pull.baseRef,
    merger: { id: merger.id, login: merger.login, type: mode === "bot" ? "Bot" : "User" },
    mode,
    command_comment_id: comment.id,
    accepted_head: pull.headSha,
    accepted_at: acceptedAt.toISOString(),
    expires_at: new Date(acceptedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
  });
  if (parsedPayload.version !== 1) throw new Error("human merge reservation produced an invalid payload kind");
  const payload = parsedPayload;
  const { data: serverRepo } = await ctx.deployments.rest.repos.get(splitRepository(ctx.serverRepository));
  let displayCommit: string | undefined;
  let displayFailure: string | undefined;
  if (ctx.displayCommit) {
    try {
      displayCommit = await createAutomergeDisplayCommit({ server: ctx.displayCommit, serverRepository: ctx.serverRepository, defaultBranch: serverRepo.default_branch, serverBotId: ctx.config.apps.server_bot_id, payload });
    } catch (error) {
      displayFailure = error instanceof Error ? error.message : String(error);
    }
  } else displayFailure = "display commit token unavailable";
  const record = await createReservation({ server: ctx.deployments, serverRepository: ctx.serverRepository, defaultBranch: serverRepo.default_branch, ...(displayCommit ? { displayCommit } : {}), serverBotId: ctx.config.apps.server_bot_id, payload });
  try {
    await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, ctx.repository, pull.number), state: "queued", description: `waiting for approval of ${pull.headSha.slice(0, 7)}` });
    await ctx.notify.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: comment.id, content: "rocket" });
    await postAutomergeComment(ctx, record, "accepted", `Merge reserved until ${payload.expires_at}. It follows head changes and requires approval and checks for the current head. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, pull.headSha);
    await setLabel(ctx, pull.number, true);
  } catch (error) {
    await ctx.onAcceptanceFailure?.(record, Boolean(displayFailure));
    throw error;
  }
  return { kind: "accepted", reservation: record, ...(displayFailure ? { displayFailure } : {}) };
}

function authorizeCancellation(args: { author: CommentFacts["user"]; trustedMergerIds: readonly number[]; records: readonly ReservationRecord[]; commentId: number }): { author: NonNullable<CommentFacts["user"]>; active?: ReservationRecord; previous?: ReservationRecord; cancelledByThisComment?: ReservationRecord } {
  const { author } = args;
  if (!author || author.type !== "User") throw new Rejection("only the reserving User or a trusted merger can cancel a merge reservation");
  const active = args.records.find((record) => record.state.kind === "active");
  if (active) {
    const allowed = active.payload.version === 2
      ? args.trustedMergerIds.includes(author.id)
      : canCancelReservation({ commenterId: author.id, trustedMergerIds: args.trustedMergerIds, reservationMergerId: active.payload.merger.id });
    if (!allowed) throw new Rejection(`${author.login} cannot cancel this merge reservation`);
    return { author, active };
  }
  const previous = args.records.find((record) => record.payload.version === 1 && record.payload.merger.id === author.id);
  const cancelledByThisComment = args.records.find((record) => record.state.kind === "terminal" && record.state.reason === "cancelled" && cancellationCommandId(record) === args.commentId);
  const replayingOwnCancellation = cancelledByThisComment !== undefined && cancellationAuthorId(cancelledByThisComment) === author.id;
  if (!args.trustedMergerIds.includes(author.id) && !previous && !replayingOwnCancellation) throw new Rejection(`${author.login} is not one of the mergers`);
  return { author, ...(previous ? { previous } : {}), ...(cancelledByThisComment ? { cancelledByThisComment } : {}) };
}

async function cancelReservation(ctx: MergeContext, pull: Awaited<ReturnType<typeof pullFacts>>, comment: CommentFacts, args: MergeArgs): Promise<{ kind: "cancelled" | "cancel-noop"; reservation?: ReservationRecord }> {
  const trusted = ctx.config.trust.mergers;
  const records = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: pull.repositoryId, pullNumber: pull.number, now: ctx.now() });
  const { author, active, previous, cancelledByThisComment } = authorizeCancellation({ author: comment.user, trustedMergerIds: trusted.map((item) => item.id), records, commentId: args.comment_id });
  if (!active) {
    const receipt = `<!-- csm-ci:automerge:cancel:${args.comment_id} -->`;
    const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
    if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return { kind: "cancel-noop", ...(previous ? { reservation: previous } : {}) };
    if (cancelledByThisComment) {
      const cancellingLogin = cancelledByThisComment.state.kind === "terminal" ? cancelledByThisComment.state.description?.match(/\bcancelled by @([^;|]+)/)?.[1]?.trim() : undefined;
      await postCancelReceipt(ctx, cancelledByThisComment, args.comment_id, `Merge reservation cancelled by @${cancellingLogin ?? author.login}.`);
      await setLabel(ctx, pull.number, false);
      return { kind: "cancelled", reservation: cancelledByThisComment };
    }
    if (pull.merged) {
      if (!hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) {
        const body = `${receipt}\ncsm-ci: pull request #${pull.number} has already merged.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: args.comment_id, head: pull.headSha, serverRun: ctx.serverRun })}`;
        await postResult(ctx.notify, ctx.repository, pull.number, receipt, body);
      }
      return { kind: "cancel-noop" };
    }
    await ctx.notify.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: args.comment_id, content: "rocket" });
    await postCancelNoop(ctx, pull.number, args.comment_id, pull.headSha);
    return { kind: "cancel-noop" };
  }
  const receipt = `<!-- csm-ci:automerge:cancel:${args.comment_id} -->`;
  const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return { kind: "cancelled", reservation: active };
  if (pull.merged) {
    await postCancelReceipt(ctx, active, args.comment_id, `csm-ci: pull request #${pull.number} has already merged.`);
    return { kind: "cancel-noop", reservation: active };
  }
  await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: active.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, ctx.repository, pull.number), state: "inactive", description: terminalDescription("cancelled", `cancelled by @${author.login}; cancelled_by_id=${author.id}; cancel_comment_id=${args.comment_id}`) });
  await ctx.notify.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: args.comment_id, content: "rocket" });
  await postCancelReceipt(ctx, active, args.comment_id, `Merge reservation cancelled by @${author.login}.`);
  await setLabel(ctx, pull.number, false);
  return { kind: "cancelled", reservation: active };
}

export async function evaluateReservation(ctx: MergeContext, record: ReservationRecord): Promise<Evaluation> {
  ctx.config = await ctx.reloadConfig();
  const current = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: record.payload.repository_id, pullNumber: record.payload.pull_number, now: ctx.now() });
  const latest = current.find((item) => item.deploymentId === record.deploymentId);
  if (!latest) throw new Rejection("merge reservation no longer exists");
  if (latest.state.kind === "active" && ctx.now().getTime() >= Date.parse(latest.payload.expires_at)) {
    const decision: Decision = { kind: "terminal", state: "inactive", reason: "expired", description: "expired", comment: "complete" };
    return persistTerminal(ctx, latest, ctx.repository, decision, current);
  }
  let targetRepo: { full_name: string };
  try {
    ({ data: targetRepo } = await ctx.server.request("GET /repositories/{repository_id}", { repository_id: record.payload.repository_id }));
  } catch (error) {
    if (status(error) !== 404) throw error;
    const decision = latest.state.kind === "terminal" ? terminalDecision(latest) : { kind: "terminal" as const, state: "inactive" as const, reason: "invalidated" as const, description: "reservation target is unavailable", comment: "complete" as const };
    return persistTerminal(ctx, latest, ctx.repository, decision, current, true);
  }
  const targetContext = { ...ctx, repository: targetRepo.full_name };
  const entry = repositoryEntry(ctx.config, targetContext.repository);
  let pull: MergePullFacts;
  try {
    pull = await pullFacts(ctx.server, targetContext.repository, record.payload.pull_number);
  } catch (error) {
    if (status(error) !== 404) throw error;
    const decision = latest.state.kind === "terminal" ? terminalDecision(latest) : { kind: "terminal" as const, state: "inactive" as const, reason: "invalidated" as const, description: "reservation target is unavailable", comment: "complete" as const };
    return persistTerminal(ctx, latest, targetContext.repository, decision, current, true);
  }
  if (pull.repositoryId !== record.payload.repository_id || pull.nodeId !== record.payload.pull_node_id) {
    const decision = latest.state.kind === "terminal" ? terminalDecision(latest) : { kind: "terminal" as const, state: "inactive" as const, reason: "invalidated" as const, description: "reservation identity changed", comment: "complete" as const };
    return persistTerminal(ctx, latest, targetContext.repository, decision, current, true);
  }
  if (latest.payload.version === 2 && pull.merged && latest.state.kind === "active") {
    if (!ctx.verifyManagedMerge || !pull.mergeCommitSha) throw new Rejection("managed merge result verifier is unavailable for the already-merged pull request");
    const verification = await ctx.verifyManagedMerge({ repository: targetContext.repository, pullNumber: pull.number, mergeCommit: pull.mergeCommitSha, reservation: latest.payload });
    const decision: Extract<Decision, { kind: "terminal" }> = verification.matches
      ? { kind: "terminal", state: "success", reason: "merged", description: `merged as ${pull.mergeCommitSha.slice(0, 7)}`, comment: "complete" }
      : { kind: "terminal", state: "failure", reason: "rejected", description: `merged, but managed files drifted: ${verification.reason ?? "the merged tree does not match the current desired manifest"}; run repo-settings again`, comment: "complete" };
    return persistTerminal(ctx, latest, targetContext.repository, decision, current);
  }
  if (record.payload.version === 2) {
    const managedReservation = latest.payload;
    if (managedReservation.version !== 2) throw new Rejection("managed reservation changed during evaluation");
    if (!ctx.attestManagedPull || !ctx.managedPolicySource || !ctx.verifyManagedMerge) {
      throw new Rejection("managed-file reservation evaluator is not connected to current configuration, manifest, policy, and merge-result verification");
    }
    let attestation: ManagedPullAttestation | undefined;
    try {
      attestation = await ctx.attestManagedPull({ repository: targetContext.repository, pullNumber: pull.number, reservation: managedReservation });
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      const decision: Decision = { kind: "terminal", state: "inactive", reason: "invalidated", description: error.message, comment: "complete" };
      return persistTerminal(ctx, latest, targetContext.repository, decision, current);
    }
    if (!attestation || !matchesManagedAttestation(latest, attestation, pull)) {
      const decision: Decision = { kind: "terminal", state: "inactive", reason: "invalidated", description: "managed-file provenance does not match the current reservation", comment: "complete" };
      return persistTerminal(ctx, latest, targetContext.repository, decision, current);
    }
    const entry = repositoryEntry(ctx.config, targetContext.repository);
    const baseBranchAllowed = pull.baseRef === pull.defaultBranch || entry?.integration_branches?.includes(pull.baseRef) === true;
    const managedSource = await ctx.managedPolicySource({ repository: targetContext.repository, pull, reservation: managedReservation });
    const readinessResult = await evaluateManagedMergeReadiness(targetContext, pull, managedSource, attestation);
    const decision = decide({
      reservation: { state: latest.state, payload: latest.payload }, pull, now: ctx.now(), trustValid: true,
      mergeEnabled: entry?.ops.includes("merge") === true, baseBranchAllowed, allowBotRequests: true, botCommitsValid: true, readiness: readinessResult,
    });
    if (latest.state.kind === "active") {
      await postAutomergeComment(targetContext, latest, "accepted", `Managed-file merge reserved until ${latest.payload.expires_at}. It requires the current managed manifest, approval, policies, and checks. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, latest.payload.accepted_head);
    }
    if (decision.kind !== "merge" && (decision.kind === "terminal" || latest.state.kind !== "active" || latest.state.waitingReason !== decision.reason)) {
      const statusDescription = decision.kind === "terminal" ? terminalDescription(decision.reason, decision.description) : decision.reason;
      await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: latest.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, targetContext.repository, pull.number), state: decision.kind === "terminal" ? decision.state : "queued", description: statusDescription });
    }
    if (decision.kind === "terminal" && decision.comment === "complete") {
      await postAutomergeComment(targetContext, latest, eventFor(decision), humanTerminalDescription(decision.description), pull.headSha);
    }
    const newerActive = current.some((item) => item.deploymentId !== latest.deploymentId && item.state.kind === "active" && Date.parse(item.createdAt) > Date.parse(latest.createdAt));
    await setLabel(targetContext, pull.number, newerActive || decision.kind !== "terminal" || decision.state === "success");
    return { decision, ready: decision.kind === "merge", head: decision.kind === "merge" ? decision.head : pull.headSha, reservation: latest, repository: targetContext.repository, ...(decision.kind === "merge" ? { commit: commitText(pull) } : {}) };
  }
  const humanPayload = record.payload;
  if (humanPayload.version !== 1) throw new Rejection("managed reservation changed during evaluation");
  const mergerStillTrusted = humanPayload.mode === "bot"
    ? ctx.config.trust.bot_mergers.some((item) => item.id === humanPayload.merger.id)
    : ctx.config.trust.mergers.some((item) => item.id === humanPayload.merger.id);
  const baseBranchAllowed = pull.baseRef === pull.defaultBranch || entry?.integration_branches?.includes(pull.baseRef) === true;
  const botCheckRequired = humanPayload.mode === "bot" && latest.state.kind === "active" && pull.state === "open" &&
    ctx.now().getTime() < Date.parse(humanPayload.expires_at) && mergerStillTrusted && entry?.ops.includes("merge") === true && baseBranchAllowed &&
    entry.merge?.allow_bot_requests !== false && pull.baseRef === humanPayload.base_ref;
  const botCommitsValid = !botCheckRequired || await verifyBotCommits(targetContext, pull, humanPayload.merger);
  let ready: { kind: "ready" } | { kind: "waiting"; reason: string } = { kind: "waiting", reason: "not evaluated" };
  const preflight = decide({ reservation: { state: latest.state, payload: latest.payload }, pull, now: ctx.now(), trustValid: mergerStillTrusted, mergeEnabled: entry?.ops.includes("merge") === true, baseBranchAllowed, allowBotRequests: entry?.merge?.allow_bot_requests !== false, botCommitsValid, readiness: ready });
  if (preflight.kind === "wait" && preflight.reason === "not evaluated") ready = await readiness(targetContext, pull);
  const decision = decide({ reservation: { state: latest.state, payload: latest.payload }, pull, now: ctx.now(), trustValid: mergerStillTrusted, mergeEnabled: entry?.ops.includes("merge") === true, baseBranchAllowed, allowBotRequests: entry?.merge?.allow_bot_requests !== false, botCommitsValid, readiness: ready });
  if (latest.state.kind === "active") {
    await postAutomergeComment(targetContext, latest, "accepted", `Merge reserved until ${latest.payload.expires_at}. It follows head changes and requires approval and checks for the current head. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, latest.payload.accepted_head);
  }
  const statusValue = decision.kind === "terminal" ? decision.state : "queued";
  const description = decision.kind === "terminal" ? decision.description : decision.kind === "wait" ? decision.reason : undefined;
  if (latest.state.kind === "active" && decision.kind !== "merge" && (statusValue !== "queued" || latest.state.waitingReason !== description)) {
    const statusDescription = decision.kind === "terminal" ? terminalDescription(decision.reason, description ?? "") : description ?? "";
    await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: latest.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, targetContext.repository, pull.number), state: statusValue, description: statusDescription });
  }
  if (decision.kind === "terminal" && decision.comment === "complete") {
    const event = eventFor(decision);
    await postAutomergeComment(targetContext, latest, event, humanTerminalDescription(decision.description), pull.headSha);
  }
  const newerActive = current.some((item) => item.deploymentId !== latest.deploymentId && item.state.kind === "active" && Date.parse(item.createdAt) > Date.parse(latest.createdAt));
  await setLabel(targetContext, pull.number, newerActive || decision.kind !== "terminal" || decision.state === "success");
  return { decision, ready: decision.kind === "merge", head: decision.kind === "merge" ? decision.head : pull.headSha, reservation: latest, repository: targetContext.repository, ...(decision.kind === "merge" ? { commit: commitText(pull) } : {}) };
}

async function persistTerminal(ctx: MergeContext, record: ReservationRecord, repository: string, decision: Extract<Decision, { kind: "terminal" }>, current: readonly ReservationRecord[], suppressClientWrites = false): Promise<Evaluation> {
  const targetContext = { ...ctx, repository };
  if (record.state.kind === "active") {
    await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, repository, record.payload.pull_number), state: decision.state, description: terminalDescription(decision.reason, decision.description) });
  }
  if (!suppressClientWrites && decision.comment === "complete") {
    await postAutomergeComment(targetContext, record, eventFor(decision), humanTerminalDescription(decision.description), record.payload.accepted_head);
  }
  const newerActive = current.some((item) => item.deploymentId !== record.deploymentId && item.state.kind === "active" && Date.parse(item.createdAt) > Date.parse(record.createdAt));
  if (!suppressClientWrites) {
    await setLabel(targetContext, record.payload.pull_number, newerActive || decision.state === "success");
  }
  return { decision, ready: false, head: record.payload.accepted_head, reservation: record, repository };
}

function cancellationCommandId(record: ReservationRecord): number | undefined {
  if (record.state.kind !== "terminal") return undefined;
  const match = record.state.description?.match(/\bcancel_comment_id=(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function cancellationAuthorId(record: ReservationRecord): number | undefined {
  if (record.state.kind !== "terminal") return undefined;
  const match = record.state.description?.match(/\bcancelled_by_id=(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function terminalDecision(record: ReservationRecord): Extract<Decision, { kind: "terminal" }> {
  if (record.state.kind !== "terminal") throw new Error("reservation is not terminal");
  const description = humanTerminalDescription(record.state.description ?? "");
  return { kind: "terminal", state: record.state.state, reason: record.state.reason, description, comment: record.state.reason === "external-merge" || record.state.reason === "closed" ? "none" : "complete" };
}

function humanTerminalDescription(description: string): string {
  return description
    .replace(/^csm-ci:automerge:reason=[a-z-]+\|\s*/, "")
    .replace(/; (?:cancelled_by_id=\d+; )?cancel_comment_id=\d+$/, "");
}

export async function mergeReservation(ctx: MergeContext, record: ReservationRecord, head: string): Promise<MergeOutcome> {
  if (!ctx.write) throw new Error("write token is required to merge");
  const evaluated = await evaluateReservation(ctx, record);
  if (evaluated.decision.kind !== "merge" || evaluated.decision.head !== head) throw new Rejection("merge readiness changed before the final write");
  const targetContext = { ...ctx, repository: evaluated.repository };
  const pull = await pullFacts(ctx.server, evaluated.repository, record.payload.pull_number);
  await disableAutoMerge(targetContext, ctx.write, pull.number);
  const afterDisarm = await pullFacts(ctx.server, evaluated.repository, pull.number);
  if (afterDisarm.merged) {
    await evaluateReservation(targetContext, record);
    throw new Rejection(`pull request #${pull.number} was merged outside csm-ci`);
  }
  if (await fetchAutoMergeRequest(ctx.server, evaluated.repository, pull.number)) throw new Rejection(`GitHub auto-merge is still enabled for pull request #${pull.number}`);
  const latest = await evaluateReservation(targetContext, record);
  if (latest.decision.kind !== "merge" || latest.decision.head !== head || !latest.commit) throw new Rejection("merge readiness changed after disabling auto-merge");
  let { title, message } = latest.commit;
  let mergedSha: string | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await ctx.write.rest.pulls.merge({ ...splitRepository(evaluated.repository), pull_number: pull.number, sha: head, merge_method: "squash", commit_title: title, commit_message: message });
      if (!data.merged || !data.sha) throw new Rejection(`GitHub did not merge pull request #${pull.number}`);
      mergedSha = data.sha;
      break;
    } catch (error) {
      const code = status(error);
      if (code === 409) {
        const current = await pullFacts(ctx.server, evaluated.repository, pull.number);
        if (current.state !== "open" || current.merged || current.repositoryId !== record.payload.repository_id || current.nodeId !== record.payload.pull_node_id) {
          await evaluateReservation(targetContext, record);
          throw new Rejection("pull request state changed after the merge conflict");
        }
        if (current.headSha !== head) {
          const reason = `head changed; waiting for evaluation of ${current.headSha.slice(0, 7)}`;
          await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, evaluated.repository, pull.number), state: "queued", description: reason });
          throw new Rejection(reason);
        }
        const message = `pull request #${pull.number} cannot merge because its base changed`;
        await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, evaluated.repository, pull.number), state: "failure", description: terminalDescription("rejected", message) });
        await postAutomergeComment(targetContext, evaluated.reservation, "rejected", message, head);
        await setLabel(targetContext, pull.number, false);
        throw new Rejection(message);
      }
      if ([502, 503, 504].includes(code ?? 0) || isNetworkFailure(error)) {
        const after = await pullFacts(ctx.server, evaluated.repository, pull.number);
        if (after.merged) {
          const { data: merged } = await ctx.server.rest.pulls.get({ ...splitRepository(evaluated.repository), pull_number: pull.number });
          mergedSha = merged.merge_commit_sha ?? undefined;
          if (!mergedSha) throw error;
          break;
        }
      }
      if (![405, 422, 503].includes(code ?? 0) || attempt >= 2) throw error;
      const check = await evaluateReservation(targetContext, record);
      if (check.decision.kind !== "merge" || check.decision.head !== head || !check.commit) throw new Rejection("merge readiness changed before retry");
      ({ title, message } = check.commit);
    }
  }
  if (!mergedSha) throw new Error("merge completed without a commit SHA");
  if (record.payload.version === 2) {
    if (!ctx.verifyManagedMerge) throw new Rejection("managed merge completed, but its result verifier is unavailable");
    const verification = await ctx.verifyManagedMerge({ repository: evaluated.repository, pullNumber: pull.number, mergeCommit: mergedSha, reservation: record.payload });
    if (!verification.matches) {
      const message = `merged, but managed files drifted: ${verification.reason ?? "the merged tree does not match the current desired manifest"}; run repo-settings again`;
      await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, evaluated.repository, pull.number), state: "failure", description: terminalDescription("rejected", message) });
      await postAutomergeComment(targetContext, record, "rejected", message, head);
      await setLabel(targetContext, pull.number, false);
      throw new Rejection(message);
    }
  }
  await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, evaluated.repository, pull.number), state: "success", description: terminalDescription("merged", `merged as ${mergedSha.slice(0, 7)}`) });
  await postAutomergeComment(targetContext, record, "merged", `Pull request squash-merged as ${mergedSha}.`, head);
  await setLabel(targetContext, pull.number, true);
  return { result: "merged", head, mergeCommit: mergedSha };
}

async function fetchAutoMergeRequest(server: GitHub, repository: string, pullNumber: number): Promise<unknown | null> {
  const { owner, repo } = splitRepository(repository);
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){autoMergeRequest{mergeMethod enabledBy{__typename ... on Bot{databaseId}}}}}}";
  const state = await server.graphql<{ repository: { pullRequest: { autoMergeRequest: unknown | null } | null } }>(query, { owner, name: repo, number: pullNumber });
  const pull = state.repository.pullRequest;
  if (!pull) throw new Rejection(`pull request #${pullNumber} no longer exists`);
  return pull.autoMergeRequest;
}

async function disableAutoMerge(ctx: MergeContext, write: GitHub | undefined, pullNumber: number): Promise<void> {
  if (!write) throw new Error("pull request write token is required to disable GitHub auto-merge");
  const { owner, repo } = splitRepository(ctx.repository);
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id autoMergeRequest{mergeMethod enabledBy{__typename ... on Bot{databaseId}}}}}}";
  const state = await ctx.server.graphql<{ repository: { pullRequest: { id: string; autoMergeRequest: unknown | null } } }>(query, { owner, name: repo, number: pullNumber });
  const request = state.repository.pullRequest.autoMergeRequest;
  if (!request) return;
  try {
    await write.graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}", { id: state.repository.pullRequest.id });
  } catch (error) {
    const current = await pullFacts(ctx.server, ctx.repository, pullNumber);
    if (current.merged) return;
    if (await fetchAutoMergeRequest(ctx.server, ctx.repository, pullNumber)) throw error;
  }
}

function commitText(pull: MergePullFacts): { title: string; message: string } {
  const seen = new Set<string>();
  const message = (pull.body ?? "").split(/\r?\n/).filter((line) => {
    if (!/^Co-authored-by:\s*.+$/i.test(line)) return true;
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n");
  return { title: `${pull.title} (#${pull.number})`, message };
}

function eventFor(decision: Extract<Decision, { kind: "terminal" }>): Parameters<typeof automergeMarker>[1] {
  if (decision.reason === "merged" || decision.reason === "external-merge") return "merged";
  if (decision.reason === "cancelled") return "cancelled";
  if (decision.reason === "expired") return "expired";
  if (decision.reason === "rejected") return "rejected";
  return "invalidated";
}

function runUrl(run: ServerRun): string { return `${run.serverUrl}/${run.repository}/actions/runs/${run.id}/attempts/${run.attempt}`; }
function pullUrl(serverUrl: string, repository: string, number: number): string { return `${serverUrl}/${repository}/pull/${number}`; }
