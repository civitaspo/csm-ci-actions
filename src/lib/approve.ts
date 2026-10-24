import { type CommentFacts, checkPullState, type PullFacts, requirePrincipal, validateComment } from "./command.ts";
import type { Config, Policy } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { hasServerMarker, marker, postResult } from "./notify.ts";
import { evaluatePolicies } from "./policies/index.ts";
import { Rejection } from "./request.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";

export type ApproveContext = { server: GitHub; approver: GitHub; config: Config; repository: string; now: () => Date };
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

export async function fetchComment(gh: GitHub, repository: string, commentId: number): Promise<CommentFacts> {
  const { data: c } = await gh.rest.issues.getComment({ ...splitRepository(repository), comment_id: commentId });
  const node = await gh.graphql<{ node: { databaseId: number; lastEditedAt: string | null } | null }>(
    "query($id: ID!) { node(id: $id) { ... on IssueComment { databaseId lastEditedAt } } }",
    { id: c.node_id },
  );
  const issueComment = node.node;
  if (!issueComment || issueComment.databaseId !== commentId || issueComment.lastEditedAt === undefined) throw new Error(`comment ${commentId} has no matching GraphQL issue comment`);
  return {
    id: Number(c.id),
    body: c.body ?? "",
    issueUrl: c.issue_url,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    lastEditedAt: issueComment.lastEditedAt,
    user: c.user ? { id: Number(c.user.id), login: c.user.login, type: c.user.type } : null,
  };
}

async function trustFor(ctx: ApproveContext, pull: PullFacts) {
  return evaluateTrust(await fetchCommitFacts(ctx.server, ctx.repository, pull.number), pull.headSha, ctx.config);
}

// The review pins commit_id to the head the checks ran on. A push in between would leave an
// approval that no push dismisses, so the head is read again and a moved head dismisses it.
async function approveHead(ctx: ApproveContext, pull: PullFacts, body: string): Promise<ApproveOutcome> {
  const repo = splitRepository(ctx.repository);
  const head = pull.headSha;
  if (pull.authorId === ctx.config.approver.id) throw new Rejection(`the approver authored #${pull.number}`);
  const reviews = await ctx.server.paginate(ctx.server.rest.pulls.listReviews, { ...repo, pull_number: pull.number, per_page: 100 });
  if (reviews.some((r) => Number(r.user?.id) === ctx.config.approver.id && r.state === "APPROVED" && r.commit_id === head)) {
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

// Plan S3 holds whatever csm-ci.yaml lists, so the trust policies always run.
const ALWAYS: Policy[] = [{ type: "signed-commits" }, { type: "trusted-committers" }];

async function policyProblems(ctx: ApproveContext, pull: PullFacts): Promise<string[]> {
  const policies = [...ALWAYS, ...ctx.config.policies.filter((p) => !ALWAYS.some((a) => a.type === p.type))];
  const results = evaluatePolicies(policies, { trust: await trustFor(ctx, pull) });
  return results.flatMap((r) => r.problems.map((p) => `${r.type}: ${p}`));
}

export async function autoApprove(ctx: ApproveContext, pull: PullFacts): Promise<ApproveOutcome> {
  const problems = await policyProblems(ctx, pull);
  if (problems.length > 0) return { result: "declined", head: pull.headSha, problems };
  return approveHead(ctx, pull, "");
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
  const problems = await policyProblems(ctx, pull);
  if (problems.length > 0) throw new Rejection(`/approve needs every commit signed by a trusted committer: ${problems.join("; ")}`);
  await checkHeadPredatesComment(ctx, pull, comment);
  // Kill switch: the approver can stop the request by editing or deleting the comment.
  validateComment(await fetchComment(ctx.server, ctx.repository, comment.id), ctx.repository, pull.number, ctx.now());
  return approveHead(ctx, pull, marker("approve:command", comment.id));
}

async function react(ctx: ApproveContext, commentId: number): Promise<void> {
  await ctx.server.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: commentId, content: "rocket" });
}

export async function runApprove(ctx: ApproveContext, args: { pull_number: number; comment_id?: number }): Promise<ApproveOutcome> {
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
  // Replays and requests from non-approvers get neither a rocket nor a receipt, so a label
  // cannot make the server post on a pull request again and again.
  const receipt = marker("approve", comment.id);
  const comments = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${comment.id} was already handled`);
  requirePrincipal(comment.user, ctx.config.trust.approvers, "approvers");
  await react(ctx, comment.id);
  try {
    const outcome = await commandApprove(ctx, pull, comment);
    await postResult(ctx.server, ctx.repository, pull.number, receipt, `csm-ci: /approve of \`${outcome.head}\`: ${outcome.result}.`);
    return outcome;
  } catch (e) {
    await postResult(ctx.server, ctx.repository, pull.number, receipt, `csm-ci: /approve failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
