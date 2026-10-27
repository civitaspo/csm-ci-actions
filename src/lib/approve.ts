import { type CommentFacts, checkPullState, type PullFacts, requirePrincipal, validateComment } from "./command.ts";
import type { Config } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { escapeHtml, hasServerMarker, marker, postResult, receiptFooter, type ServerRun } from "./notify.ts";
import { evaluatePullPolicies, updatePolicyCheck } from "./policy-check.ts";
import { Rejection } from "./request.ts";
import { fetchComment } from "./github-comment.ts";
export { fetchComment } from "./github-comment.ts";

export type ApproveContext = { server: GitHub; approver: GitHub; config: Config; repository: string; serverRun: ServerRun; now: () => Date; requestCommentId?: number };
export type ApproveOutcome = { result: "approved" | "already-approved" | "declined" | "dismissed"; head: string; problems: string[] };

export async function fetchPull(gh: GitHub, repository: string, pullNumber: number): Promise<PullFacts> {
  const { data: p } = await gh.rest.pulls.get({ ...splitRepository(repository), pull_number: pullNumber });
  return {
    number: p.number,
    state: p.state,
    draft: p.draft === true,
    headSha: p.head.sha,
    headRepository: p.head.repo?.full_name ?? null,
    baseRepository: p.base.repo.full_name,
    baseRef: p.base.ref,
    defaultBranch: p.base.repo.default_branch,
    authorId: Number(p.user.id),
  };
}

// The review pins commit_id to the head the checks ran on. A push in between would leave an
// approval that no push dismisses, so the head is read again and a moved head dismisses it.
async function approveHead(ctx: ApproveContext, pull: PullFacts, body: string, forceMarker = false): Promise<ApproveOutcome> {
  const repo = splitRepository(ctx.repository);
  const head = pull.headSha;
  if (pull.authorId === ctx.config.approver.id) throw new Rejection(`the approver authored #${pull.number}`);
  const reviews = await ctx.server.paginate(ctx.server.rest.pulls.listReviews, { ...repo, pull_number: pull.number, per_page: 100 });
  if (!forceMarker && reviews.some((r) => Number(r.user?.id) === ctx.config.approver.id && r.state === "APPROVED" && r.commit_id === head)) {
    return { result: "already-approved", head, problems: [] };
  }
  const { data: review } = await ctx.approver.rest.pulls.createReview({ ...repo, pull_number: pull.number, event: "APPROVE", commit_id: head, body });
  const dismiss = (message: string) => ctx.approver.rest.pulls.dismissReview({ ...repo, pull_number: pull.number, review_id: Number(review.id), message });
  if (Number(review.user?.id) !== ctx.config.approver.id) {
    await dismiss("csm-ci: the approver token does not belong to the configured approver");
    throw new Error(`the approver token belongs to ${review.user?.login}, not ${ctx.config.approver.login}`);
  }
  const after = await fetchPull(ctx.server, ctx.repository, pull.number);
  if (after.headSha !== head) {
    await dismiss(`csm-ci: the head moved from ${head} to ${after.headSha} while approving`);
    return { result: "dismissed", head, problems: [`head moved to ${after.headSha}`] };
  }
  return { result: "approved", head, problems: [] };
}

async function policyProblems(ctx: ApproveContext, pull: PullFacts): Promise<string[]> {
  const results = await evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull });
  return results.flatMap((r) => r.problems.map((p) => `${r.type}: ${p}`));
}

async function refreshPolicy(ctx: ApproveContext, pull: PullFacts): Promise<void> {
  await updatePolicyCheck({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull, serverRun: ctx.serverRun, requestKind: "approve", ...(ctx.requestCommentId === undefined ? {} : { requestCommentId: ctx.requestCommentId }) });
}

export async function autoApprove(ctx: ApproveContext, pull: PullFacts): Promise<ApproveOutcome> {
  const problems = await policyProblems(ctx, pull);
  if (problems.length > 0) {
    await refreshPolicy(ctx, pull);
    return { result: "declined", head: pull.headSha, problems };
  }
  const outcome = await approveHead(ctx, pull, "");
  await refreshPolicy(ctx, outcome.result === "dismissed" ? await fetchPull(ctx.server, ctx.repository, pull.number) : pull);
  return outcome;
}

// Plan S5 without a sha: the head the server observes is pinned, so a head pushed after the
// comment must not ride on it. A force-push after the comment, or a head commit dated after it,
// rejects the request. Only a trusted committer could fake the date, and their commits pass anyway.
async function checkHeadPredatesComment(ctx: ApproveContext, pull: PullFacts, comment: CommentFacts): Promise<void> {
  const repo = splitRepository(ctx.repository);
  const posted = new Date(comment.createdAt).getTime();
  const { data: head } = await ctx.server.rest.repos.getCommit({ ...repo, ref: pull.headSha });
  const dated = head.commit.committer?.date;
  if (!dated || new Date(dated).getTime() > posted) throw new Rejection(`the head ${pull.headSha} is newer than comment ${comment.id}`);
  const events = await ctx.server.paginate(ctx.server.rest.issues.listEventsForTimeline, { ...repo, issue_number: pull.number, per_page: 100 });
  const forced = events.some((e) => "event" in e && e.event === "head_ref_force_pushed" && "created_at" in e && new Date(String(e.created_at)).getTime() >= posted);
  if (forced) throw new Rejection(`#${pull.number} was force-pushed after comment ${comment.id}`);
}

async function commandApprove(ctx: ApproveContext, pull: PullFacts, comment: CommentFacts): Promise<ApproveOutcome> {
  checkPullState(pull);
  const results = await evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull }, { commentId: comment.id, authorId: comment.user?.id ?? -1, head: pull.headSha });
  const problems = results.flatMap((r) => r.problems.map((p) => `${r.type}: ${p}`));
  if (problems.length > 0) throw new Rejection(`/approve cannot proceed because policy checks failed: ${problems.join("; ")}`);
  await checkHeadPredatesComment(ctx, pull, comment);
  // Kill switch: the approver can stop the request by editing or deleting the comment.
  const currentCommand = validateComment(await fetchComment(ctx.server, ctx.repository, comment.id), ctx.repository, pull.number, ctx.now());
  if (currentCommand.name !== "approve") throw new Rejection(`comment ${comment.id} is no longer exactly /approve`);
  const outcome = await approveHead(ctx, pull, marker("approve:command", comment.id), true);
  await refreshPolicy(ctx, outcome.result === "dismissed" ? await fetchPull(ctx.server, ctx.repository, pull.number) : pull);
  return outcome;
}

async function react(ctx: ApproveContext, commentId: number): Promise<void> {
  await ctx.server.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: commentId, content: "rocket" });
}

export async function runApprove(ctx: ApproveContext, args: { pull_number: number; comment_id?: number }): Promise<ApproveOutcome> {
  ctx = { ...ctx, ...(args.comment_id === undefined ? {} : { requestCommentId: args.comment_id }) };
  const pull = await fetchPull(ctx.server, ctx.repository, args.pull_number);
  if (args.comment_id === undefined) {
    checkPullState(pull);
    return autoApprove(ctx, pull);
  }
  const comment = await fetchComment(ctx.server, ctx.repository, args.comment_id);
  const command = validateComment(comment, ctx.repository, pull.number, ctx.now());
  if (command.name === "recheck") {
    await react(ctx, comment.id);
    checkPullState(pull);
    return autoApprove(ctx, pull);
  }
  if (command.name !== "approve") throw new Rejection(`comment ${comment.id} is not exactly /approve`);
  // Replays and requests from non-approvers get neither a rocket nor a receipt, so a label
  // cannot make the server post on a pull request again and again.
  const receipt = marker("approve", comment.id);
  const comments = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${comment.id} was already handled`);
  requirePrincipal(comment.user, ctx.config.trust.approvers, "approvers");
  await react(ctx, comment.id);
  try {
    const outcome = await commandApprove(ctx, pull, comment);
    const message = outcome.result === "dismissed"
      ? `csm-ci: /approve was dismissed because ${escapeHtml(outcome.problems.join("; "))}. Review the current head and post a new exact \`/approve\` comment.`
      : "csm-ci: /approve succeeded. Approved the requested head.";
    await postResult(ctx.server, ctx.repository, pull.number, receipt, `${message}\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: comment.id, head: outcome.head, serverRun: ctx.serverRun })}`);
    return outcome;
  } catch (e) {
    await postResult(ctx.server, ctx.repository, pull.number, receipt, `csm-ci: /approve ${e instanceof Rejection ? "was declined" : "failed"}: ${escapeHtml(e instanceof Error ? e.message : String(e))}\n\nResolve the failure, review the current head, and post a new exact \`/approve\` comment.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: comment.id, head: pull.headSha, serverRun: ctx.serverRun })}`);
    throw e;
  }
}
