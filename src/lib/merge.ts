import { type CommentFacts, checkPullState, type PullFacts, validateComment } from "./command.ts";
import { type Config, type Principal, repositoryEntry } from "./config.ts";
import { approverApprovedHead, evaluatePullPolicies } from "./policy-check.ts";
import { fetchComment } from "./approve.ts";
import { escapeHtml, hasServerMarker, marker, postResult, receiptFooter, type ServerRun } from "./notify.ts";
import { Rejection } from "./request.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";
import { AUTOMERGE_LABEL, automergeMarker, canCancelReservation, decide, ReservationPayloadSchema, terminalDescription, type Decision, type ReservationPayload } from "./automerge.ts";
import { createReservation, createReservationStatus, findReservationsForPull, type ReservationRecord } from "./automerge-github.ts";
import { type GitHub, isNetworkFailure, splitRepository } from "./github.ts";

export type MergeArgs = { pull_number: number; comment_id: number };
export type MergeContext = {
  server: GitHub;
  deployments: GitHub;
  notify: GitHub;
  write?: GitHub;
  config: Config;
  reloadConfig: () => Promise<Config>;
  repository: string;
  serverRepository: string;
  serverRun: ServerRun;
  now: () => Date;
};
export type Evaluation = { decision: Decision; ready: boolean; head: string; reservation: ReservationRecord; repository: string };
export type MergeOutcome = { result: "merged"; head: string; mergeCommit: string };

type MergePullFacts = Omit<PullFacts, "state"> & { state: "open" | "closed"; merged: boolean; repositoryId: number; nodeId: string };

async function pullFacts(server: GitHub, repository: string, number: number): Promise<MergePullFacts> {
  const { data: p } = await server.rest.pulls.get({ ...splitRepository(repository), pull_number: number });
  return {
    number: p.number,
    state: p.state === "closed" ? "closed" : "open",
    merged: p.merged === true,
    draft: p.draft === true,
    headSha: p.head.sha,
    headRepository: p.head.repo?.full_name ?? null,
    baseRepository: p.base.repo.full_name,
    baseRef: p.base.ref,
    defaultBranch: p.base.repo.default_branch,
    authorId: Number(p.user.id),
    repositoryId: Number(p.base.repo.id),
    nodeId: p.node_id,
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
  const body = `csm-ci: ${escapeHtml(text)}\n\n${receiptFooter({ repository: ctx.repository, pullNumber: record.payload.pull_number, commentId: record.payload.command_comment_id, head, serverRun: ctx.serverRun })}\n\n<a href="https://github.com/${ctx.serverRepository}/deployments/${record.deploymentId}">Automerge deployment ${record.deploymentId}</a>`;
  try {
    await postResult(ctx.notify, ctx.repository, record.payload.pull_number, markerText, body);
  } catch (error) {
    if (![502, 503, 504].includes(status(error) ?? 0) && !isNetworkFailure(error)) throw error;
    const after = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: record.payload.pull_number, per_page: 100 });
    if (!hasServerMarker(after, markerText, ctx.config.apps.server_bot_id)) throw error;
  }
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
  const body = `${receipt}\n${eventMarker}\n${message}\n\n${receiptFooter({ repository: ctx.repository, pullNumber: record.payload.pull_number, commentId, head: record.payload.accepted_head, serverRun: ctx.serverRun })}`;
  await postResult(ctx.notify, ctx.repository, record.payload.pull_number, receipt, body);
}

async function requiredChecks(ctx: MergeContext, pull: PullFacts): Promise<{ ok: boolean; problems: string[] }> {
  const runs = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { ...splitRepository(ctx.repository), ref: pull.headSha, per_page: 100 });
  const problems: string[] = [];
  for (const required of ctx.config.merge.required_checks) {
    const latest = runs.filter((run) => run.name === required.name && run.app?.id === required.app_id)
      .reduce<(typeof runs)[number] | undefined>((current, run) => !current || String(run.started_at ?? "") > String(current.started_at ?? "") || (run.started_at === current.started_at && run.id > current.id) ? run : current, undefined);
    if (!latest || latest.status !== "completed" || !["success", "skipped"].includes(latest.conclusion ?? "")) problems.push(`${required.name} from app ${required.app_id} is not success or skipped`);
  }
  return { ok: problems.length === 0, problems };
}

async function readiness(ctx: MergeContext, pull: PullFacts): Promise<{ kind: "ready" } | { kind: "waiting"; reason: string }> {
  const facts = await evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull });
  const failures = facts.filter((result) => !result.ok).flatMap((result) => result.problems.map((problem) => `${result.type}: ${problem}`));
  if (failures.length) return { kind: "waiting", reason: `policies failed: ${failures.join("; ")}` };
  if (!(await approverApprovedHead(ctx.server, ctx.config, ctx.repository, pull))) return { kind: "waiting", reason: `waiting for approval of ${pull.headSha.slice(0, 7)}` };
  const checks = await requiredChecks(ctx, pull);
  if (!checks.ok) return { kind: "waiting", reason: `waiting for check ${checks.problems[0]}` };
  return { kind: "ready" };
}

export async function acceptMerge(ctx: MergeContext, args: MergeArgs): Promise<{ kind: "accepted" | "replay" | "cancelled" | "cancel-noop"; reservation?: ReservationRecord }> {
  await refreshConfig(ctx);
  const pull = await pullFacts(ctx.server, ctx.repository, args.pull_number);
  const comment = await fetchComment(ctx.server, ctx.repository, args.comment_id);
  const command = validateComment(comment, ctx.repository, pull.number, ctx.now());
  if (command.name === "merge-cancel") return cancelReservation(ctx, pull, comment, args);
  if (command.name !== "merge") throw new Rejection(`comment ${comment.id} is not /merge`);
  const existing = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: pull.repositoryId, pullNumber: pull.number, now: ctx.now() });
  const replay = existing.find((record) => record.payload.command_comment_id === comment.id);
  if (replay) {
    if (replay.state.kind === "active") {
      await postAutomergeComment(ctx, replay, "accepted", `Merge reserved until ${replay.payload.expires_at}. It follows head changes and requires approval and checks for the current head. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, replay.payload.accepted_head);
      await setLabel(ctx, pull.number, true);
    }
    return { kind: "replay", reservation: replay };
  }
  const oldReceipts = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(oldReceipts, marker("merge", comment.id), ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${comment.id} was already handled`);
  requireMergeEnabled(ctx);
  checkPullState(pull, true);
  await validateHeadBeforeComment(ctx, pull, comment);
  const author = comment.user;
  if (!author) throw new Rejection("the merge comment author was deleted");
  let merger: Principal;
  let mode: ReservationPayload["mode"];
  if (author.type === "Bot") {
    merger = principal(author, ctx.config.trust.bot_mergers, "bot mergers");
    if (repositoryEntry(ctx.config, ctx.repository)?.merge?.allow_bot_requests === false) throw new Rejection(`bot merge requests are disabled for repository ${ctx.repository}`);
    if (!(await verifyBotCommits(ctx, pull, merger))) throw new Rejection(`bot merger ${merger.login} can merge only its own pull request and commits`);
    mode = "bot";
  } else if (author.type === "User") {
    merger = principal(author, ctx.config.trust.mergers, "mergers");
    mode = "human";
  } else throw new Rejection(`${author.login} has unsupported account type ${author.type}`);

  const active = existing.find((record) => record.state.kind === "active");
  if (active) {
    const markerText = `<!-- csm-ci:automerge:merge:${comment.id}:rejected -->`;
    const comments = await ctx.notify.paginate(ctx.notify.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
    if (!hasServerMarker(comments, markerText, ctx.config.apps.server_bot_id)) {
      const body = `${markerText}\nPull request is already reserved by ${active.payload.merger.login}.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: comment.id, head: pull.headSha, serverRun: ctx.serverRun })}`;
      await postResult(ctx.notify, ctx.repository, pull.number, markerText, body);
    }
    throw new Rejection(`pull request #${pull.number} already has an active merge reservation`);
  }
  const acceptedAt = ctx.now();
  const payload = ReservationPayloadSchema.parse({
    version: 1,
    repository_id: pull.repositoryId,
    repository: ctx.repository,
    pull_number: pull.number,
    pull_node_id: pull.nodeId,
    base_ref: pull.baseRef,
    merger: { id: merger.id, login: merger.login, type: author.type },
    mode,
    command_comment_id: comment.id,
    accepted_head: pull.headSha,
    accepted_at: acceptedAt.toISOString(),
    expires_at: new Date(acceptedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
  });
  const { data: serverRepo } = await ctx.deployments.rest.repos.get(splitRepository(ctx.serverRepository));
  const record = await createReservation({ server: ctx.deployments, serverRepository: ctx.serverRepository, defaultBranch: serverRepo.default_branch, serverBotId: ctx.config.apps.server_bot_id, payload });
  await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, ctx.repository, pull.number), state: "queued", description: `waiting for approval of ${pull.headSha.slice(0, 7)}` });
  await ctx.notify.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: comment.id, content: "rocket" });
  await postAutomergeComment(ctx, record, "accepted", `Merge reserved until ${payload.expires_at}. It follows head changes and requires approval and checks for the current head. Cancel with /merge cancel. The ${AUTOMERGE_LABEL} label shows the reservation state.`, pull.headSha);
  await setLabel(ctx, pull.number, true);
  return { kind: "accepted", reservation: record };
}

async function cancelReservation(ctx: MergeContext, pull: Awaited<ReturnType<typeof pullFacts>>, comment: CommentFacts, args: MergeArgs): Promise<{ kind: "cancelled" | "cancel-noop"; reservation?: ReservationRecord }> {
  const author = comment.user;
  if (!author || author.type !== "User") throw new Rejection("only the reserving User or a trusted merger can cancel a merge reservation");
  const trusted = ctx.config.trust.mergers;
  const records = await findReservationsForPull({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, repositoryId: pull.repositoryId, pullNumber: pull.number, now: ctx.now() });
  const active = records.find((record) => record.state.kind === "active");
  if (!active) {
    const previous = records.find((record) => record.payload.merger.id === author.id);
    const cancelledByThisComment = records.find((record) => record.state.kind === "terminal" && record.state.reason === "cancelled" && cancellationCommandId(record) === args.comment_id);
    const replayingOwnCancellation = cancelledByThisComment !== undefined && cancellationAuthorId(cancelledByThisComment) === author.id;
    if (!trusted.some((principal) => principal.id === author.id) && !previous && !replayingOwnCancellation) throw new Rejection(`${author.login} is not one of the mergers`);
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
  if (!canCancelReservation({ commenterId: author.id, trustedMergerIds: trusted.map((item) => item.id), reservationMergerId: active.payload.merger.id })) throw new Rejection(`${author.login} cannot cancel this merge reservation`);
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
  const mergerStillTrusted = record.payload.mode === "bot"
    ? ctx.config.trust.bot_mergers.some((item) => item.id === record.payload.merger.id)
    : ctx.config.trust.mergers.some((item) => item.id === record.payload.merger.id);
  const botCheckRequired = record.payload.mode === "bot" && latest.state.kind === "active" && pull.state === "open" &&
    ctx.now().getTime() < Date.parse(record.payload.expires_at) && mergerStillTrusted && entry?.ops.includes("merge") === true &&
    entry.merge?.allow_bot_requests !== false && pull.baseRef === record.payload.base_ref;
  const botCommitsValid = !botCheckRequired || await verifyBotCommits(targetContext, pull, record.payload.merger);
  let ready: { kind: "ready" } | { kind: "waiting"; reason: string } = { kind: "waiting", reason: "not evaluated" };
  const preflight = decide({ reservation: { state: latest.state, payload: latest.payload }, pull, now: ctx.now(), trustValid: mergerStillTrusted, mergeEnabled: entry?.ops.includes("merge") === true, allowBotRequests: entry?.merge?.allow_bot_requests !== false, botCommitsValid, readiness: ready });
  if (preflight.kind === "wait" && preflight.reason === "not evaluated") ready = await readiness(targetContext, pull);
  const decision = decide({ reservation: { state: latest.state, payload: latest.payload }, pull, now: ctx.now(), trustValid: mergerStillTrusted, mergeEnabled: entry?.ops.includes("merge") === true, allowBotRequests: entry?.merge?.allow_bot_requests !== false, botCommitsValid, readiness: ready });
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
  return { decision, ready: decision.kind === "merge", head: decision.kind === "merge" ? decision.head : pull.headSha, reservation: latest, repository: targetContext.repository };
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
  await disableAutoMerge(targetContext, pull.number);
  const latest = await evaluateReservation(targetContext, record);
  if (latest.decision.kind !== "merge" || latest.decision.head !== head) throw new Rejection("merge readiness changed after disabling auto-merge");
  const { title, message } = await commitText(targetContext, pull.number);
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
      if (check.decision.kind !== "merge" || check.decision.head !== head) throw new Rejection("merge readiness changed before retry");
    }
  }
  if (!mergedSha) throw new Error("merge completed without a commit SHA");
  await createReservationStatus({ server: ctx.deployments, serverRepository: ctx.serverRepository, serverBotId: ctx.config.apps.server_bot_id, deploymentId: record.deploymentId, serverRunUrl: runUrl(ctx.serverRun), pullUrl: pullUrl(ctx.serverRun.serverUrl, evaluated.repository, pull.number), state: "success", description: terminalDescription("merged", `merged as ${mergedSha.slice(0, 7)}`) });
  await postAutomergeComment(targetContext, record, "merged", `Pull request squash-merged as ${mergedSha}.`, head);
  await setLabel(targetContext, pull.number, true);
  return { result: "merged", head, mergeCommit: mergedSha };
}

async function disableAutoMerge(ctx: MergeContext, pullNumber: number): Promise<void> {
  const { owner, repo } = splitRepository(ctx.repository);
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id autoMergeRequest{mergeMethod enabledBy{__typename ... on Bot{databaseId}}}}}}";
  const state = await ctx.server.graphql<{ repository: { pullRequest: { id: string; autoMergeRequest: unknown | null } } }>(query, { owner, name: repo, number: pullNumber });
  const request = state.repository.pullRequest.autoMergeRequest;
  if (!request) return;
  try {
    await ctx.write?.graphql("mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}", { id: state.repository.pullRequest.id });
  } catch (error) {
    const verify = await ctx.server.graphql<{ repository: { pullRequest: { autoMergeRequest: unknown | null } } }>(query, { owner, name: repo, number: pullNumber });
    if (verify.repository.pullRequest.autoMergeRequest) throw error;
  }
}

async function commitText(ctx: MergeContext, number: number): Promise<{ title: string; message: string }> {
  const { data } = await ctx.server.rest.pulls.get({ ...splitRepository(ctx.repository), pull_number: number });
  const seen = new Set<string>();
  const message = (data.body ?? "").split(/\r?\n/).filter((line) => {
    if (!/^Co-authored-by:\s*.+$/i.test(line)) return true;
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n");
  return { title: `${data.title} (#${number})`, message };
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
