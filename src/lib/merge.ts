import { type CommentFacts, checkPullState, type PullFacts, validateComment } from "./command.ts";
import { repositoryEntry, type Config, type Principal } from "./config.ts";
import { isNetworkFailure, type GitHub, splitRepository } from "./github.ts";
import { fetchComment } from "./approve.ts";
import { escapeHtml, hasServerMarker, marker, postResult, receiptFooter, type ServerRun } from "./notify.ts";
import { approverApprovedHead, evaluatePullPolicies } from "./policy-check.ts";
import { Rejection } from "./request.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";

export type MergeContext = {
  server: GitHub;
  notify?: GitHub;
  write?: GitHub;
  config: Config;
  reloadConfig?: () => Promise<Config>;
  repository: string;
  serverRun: ServerRun;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  onAccepted?: (head: string) => void;
};
export type MergeArgs = { pull_number: number; comment_id: number };
export type MergeReady = { head: string; platform?: boolean };
export type MergeOutcome = { result: "merged"; head: string; mergeCommit: string } | { result: "auto-merge"; head: string };

const DEADLINE_MINUTES = 60;
const MERGEABLE = ["CLEAN", "UNSTABLE", "HAS_HOOKS"];

class NotReady extends Error {}

async function pullFacts(server: GitHub, repository: string, number: number): Promise<PullFacts> {
  const { data: p } = await server.rest.pulls.get({ ...splitRepository(repository), pull_number: number });
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

function principal(user: CommentFacts["user"], allowed: readonly Principal[], role: string): Principal {
  const match = user ? allowed.find((p) => p.id === user.id) : undefined;
  if (!match) throw new Rejection(`${user?.login ?? "a deleted user"} is not one of the ${role}`);
  return match;
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function timedOut(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.message === "GitHub request timed out" ||
    ("cause" in error && error.cause instanceof Error && error.cause.name === "TimeoutError");
}

async function reconcileMerge(ctx: MergeContext, pullNumber: number, head: string): Promise<MergeOutcome | undefined> {
  const { data: pull } = await ctx.server.rest.pulls.get({ ...splitRepository(ctx.repository), pull_number: pullNumber });
  if (pull.state !== "closed" || pull.head.sha !== head || !pull.merged || pull.merged_by?.id !== ctx.config.apps.server_bot_id || !pull.merge_commit_sha) return undefined;
  return { result: "merged", head, mergeCommit: pull.merge_commit_sha };
}

async function checkBotMerger(ctx: MergeContext, pull: PullFacts, merger: Principal): Promise<void> {
  if (pull.authorId !== merger.id) throw new Rejection(`bot merger ${merger.login} can merge only its own pull request`);
  const facts = await fetchCommitFacts(ctx.server, ctx.repository, pull.number);
  const trust = evaluateTrust(facts, pull.headSha, ctx.config);
  if (trust.problems.length) throw new Rejection(`pull request trust failed: ${trust.problems.join("; ")}`);
  for (const c of trust.commits) {
    if (c.identity.kind !== "user" || c.identity.principal.id !== merger.id) {
      throw new Rejection(`bot merger ${merger.login} can merge only commits by itself`);
    }
  }
}

async function verifyMerger(ctx: MergeContext, pull: PullFacts, comment: CommentFacts): Promise<void> {
  const author = comment.user;
  if (!author) throw new Rejection("the merge comment author was deleted");
  if (author.type === "Bot") {
    const bot = principal(author, ctx.config.trust.bot_mergers, "bot mergers");
    if (repositoryEntry(ctx.config, ctx.repository)?.merge?.allow_bot_requests === false) {
      throw new Rejection(`bot merge requests are disabled for repository ${ctx.repository}`);
    }
    await checkBotMerger(ctx, pull, bot);
  } else if (author.type === "User") {
    principal(author, ctx.config.trust.mergers, "mergers");
  } else {
    throw new Rejection(`${author.login} has unsupported account type ${author.type}`);
  }
}

async function pinAndValidate(ctx: MergeContext, args: MergeArgs, head: string): Promise<{ pull: PullFacts; comment: CommentFacts }> {
  const pull = await pullFacts(ctx.server, ctx.repository, args.pull_number);
  checkPullState(pull);
  if (pull.headSha !== head) throw new Rejection(`the head changed from ${head} to ${pull.headSha} while waiting`);
  const comment = await fetchComment(ctx.server, ctx.repository, args.comment_id);
  const command = validateComment(comment, ctx.repository, pull.number, ctx.now());
  if (command.name !== "merge") throw new Rejection(`comment ${comment.id} is no longer /merge`);
  await checkHeadPredatesComment(ctx, pull, comment);
  await verifyMerger(ctx, pull, comment);
  return { pull, comment };
}

async function checkHeadPredatesComment(ctx: MergeContext, pull: PullFacts, comment: CommentFacts): Promise<void> {
  const repo = splitRepository(ctx.repository);
  const posted = new Date(comment.createdAt).getTime();
  const { data: head } = await ctx.server.rest.repos.getCommit({ ...repo, ref: pull.headSha });
  const date = head.commit.committer?.date;
  if (!date || new Date(date).getTime() > posted) throw new Rejection(`the head ${pull.headSha} is newer than comment ${comment.id}`);
  const events = await ctx.server.paginate(ctx.server.rest.issues.listEventsForTimeline, { ...repo, issue_number: pull.number, per_page: 100 });
  const forced = events.some((e) => "event" in e && e.event === "head_ref_force_pushed" && "created_at" in e && new Date(String(e.created_at)).getTime() >= posted);
  if (forced) throw new Rejection(`#${pull.number} was force-pushed after comment ${comment.id}`);
}

async function requiredChecks(ctx: MergeContext, pull: PullFacts): Promise<{ ok: boolean; problems: string[] }> {
  const runs = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { ...splitRepository(ctx.repository), ref: pull.headSha, per_page: 100 });
  const problems: string[] = [];
  for (const required of ctx.config.merge.required_checks) {
    const latest = runs.filter((r) => r.name === required.name && r.app?.id === required.app_id)
      .reduce<(typeof runs)[number] | undefined>((current, run) => {
        if (!current || String(run.started_at ?? "") > String(current.started_at ?? "")) return run;
        return String(run.started_at ?? "") === String(current.started_at ?? "") && Number(run.id) > Number(current.id) ? run : current;
      }, undefined);
    if (!latest || latest.status !== "completed" || !["success", "skipped"].includes(latest.conclusion ?? "")) {
      problems.push(`${required.name} from app ${required.app_id} is not success or skipped`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function ready(ctx: MergeContext, args: MergeArgs, head: string): Promise<void> {
  await refreshConfig(ctx);
  const { pull } = await pinAndValidate(ctx, args, head);
  const results = await evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull });
  const trust = results.filter((r) => r.type === "signed-commits" || r.type === "trusted-committers");
  const failedTrust = trust.filter((r) => !r.ok).flatMap((r) => r.problems.map((p) => `${r.type}: ${p}`));
  if (failedTrust.length) throw new Rejection(`pull request trust failed: ${failedTrust.join("; ")}`);
  const policyErrors = results.filter((r) => !["signed-commits", "trusted-committers"].includes(r.type) && !r.ok)
    .flatMap((r) => r.problems.map((p) => `${r.type}: ${p}`));
  if (policyErrors.length) throw new NotReady(`policies failed: ${policyErrors.join("; ")}`);
  if (!(await approverApprovedHead(ctx.server, ctx.config, ctx.repository, pull))) throw new NotReady(`the approver has not approved head ${head}`);
  const checks = await requiredChecks(ctx, pull);
  if (!checks.ok) throw new NotReady(checks.problems.join("; "));
}

type BranchRule = { type: string; parameters?: { required_approving_review_count?: number; dismiss_stale_reviews_on_push?: boolean; required_status_checks?: { context: string; integration_id?: number }[] } };

// Platform auto-merge hands the merge-time checks to GitHub, so it is used only when the branch rules enforce them.
async function platformFallbackReason(ctx: MergeContext, pull: PullFacts): Promise<string | undefined> {
  if (repositoryEntry(ctx.config, ctx.repository)?.merge?.use_platform_automerge === false) return "use_platform_automerge is false for this repository";
  const { owner, repo } = splitRepository(ctx.repository);
  const { repository } = await ctx.server.graphql<{ repository: { autoMergeAllowed: boolean } }>("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed}}", { owner, name: repo });
  if (!repository.autoMergeAllowed) return "auto-merge is not allowed in this repository";
  const rules = await ctx.server.paginate(ctx.server.rest.repos.getBranchRules, { owner, repo, branch: pull.defaultBranch, per_page: 100 }) as BranchRule[];
  const review = rules.some((r) => r.type === "pull_request" && (r.parameters?.required_approving_review_count ?? 0) >= 1 && r.parameters?.dismiss_stale_reviews_on_push === true);
  if (!review) return `${pull.defaultBranch} does not require a fresh approval`;
  const checks = rules.flatMap((r) => r.type === "required_status_checks" ? r.parameters?.required_status_checks ?? [] : []);
  const missing = [{ name: "csm-ci/policy", app_id: ctx.config.apps.server_app_id }, ...ctx.config.merge.required_checks]
    .filter((required) => !checks.some((c) => c.context === required.name && c.integration_id === required.app_id));
  if (missing.length) return `${pull.defaultBranch} does not require ${missing.map((m) => m.name).join(", ")}`;
  return undefined;
}

type AutoMergeState = { id: string; mergeStateStatus: string; autoMergeRequest: { mergeMethod: string; enabledBy: { __typename: string; databaseId?: number } | null } | null };

async function autoMergeState(ctx: MergeContext, number: number): Promise<AutoMergeState> {
  const { owner, repo } = splitRepository(ctx.repository);
  const data = await ctx.server.graphql<{ repository: { pullRequest: AutoMergeState } }>("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeStateStatus autoMergeRequest{mergeMethod enabledBy{__typename ... on Bot{databaseId}}}}}}", { owner, name: repo, number });
  return data.repository.pullRequest;
}

function enabledByServer(ctx: MergeContext, state: AutoMergeState, number: number): boolean {
  const request = state.autoMergeRequest;
  if (!request) return false;
  if (request.enabledBy?.__typename === "Bot" && request.enabledBy.databaseId === ctx.config.apps.server_bot_id && request.mergeMethod === "SQUASH") return true;
  throw new Rejection(`auto-merge on #${number} was enabled by another actor or merge method`);
}

// Returns false when the pull request is already mergeable and should be merged directly.
async function enableAutoMerge(ctx: MergeContext, write: GitHub, args: MergeArgs, head: string): Promise<boolean> {
  const state = await autoMergeState(ctx, args.pull_number);
  if (enabledByServer(ctx, state, args.pull_number)) return true;
  if (MERGEABLE.includes(state.mergeStateStatus)) return false;
  await pinAndValidate(ctx, args, head);
  const { title, message } = await commitText(ctx, args.pull_number);
  try {
    await write.graphql("mutation($id:ID!,$head:GitObjectID!,$title:String!,$body:String!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$head,commitHeadline:$title,commitBody:$body}){clientMutationId}}", { id: state.id, head, title, body: message });
  } catch (error) {
    if (error instanceof Error && /\b(clean|unstable|has_hooks) status/i.test(error.message)) return false;
    // A lost response may still have enabled it; trust only the current state.
    if (!enabledByServer(ctx, await autoMergeState(ctx, args.pull_number), args.pull_number)) throw error;
  }
  return true;
}

async function commitText(ctx: MergeContext, number: number): Promise<{ title: string; message: string }> {
  const { data: raw } = await ctx.server.rest.pulls.get({ ...splitRepository(ctx.repository), pull_number: number });
  const seenCoauthors = new Set<string>();
  const message = (raw.body ?? "").split(/\r?\n/).filter((line) => {
    if (!/^Co-authored-by:\s*.+$/i.test(line)) return true;
    const key = line.toLowerCase();
    if (seenCoauthors.has(key)) return false;
    seenCoauthors.add(key);
    return true;
  }).join("\n");
  return { title: `${raw.title} (#${number})`, message };
}

async function refreshConfig(ctx: MergeContext): Promise<void> {
  if (ctx.reloadConfig) ctx.config = await ctx.reloadConfig();
  const entry = repositoryEntry(ctx.config, ctx.repository);
  if (!entry) throw new Rejection(`repository ${ctx.repository} is no longer managed by this server`);
  if (!entry.ops.includes("merge")) throw new Rejection(`repository ${ctx.repository} no longer enables merge`);
}

export async function waitForMerge(ctx: MergeContext, args: MergeArgs): Promise<MergeReady> {
  await refreshConfig(ctx);
  const pull = await pullFacts(ctx.server, ctx.repository, args.pull_number);
  checkPullState(pull);
  const comment = await fetchComment(ctx.server, ctx.repository, args.comment_id);
  const command = validateComment(comment, ctx.repository, pull.number, ctx.now());
  if (command.name !== "merge") throw new Rejection(`comment ${comment.id} is not /merge`);
  await verifyMerger(ctx, pull, comment);
  const receipt = marker("merge", comment.id);
  const comments = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: pull.number, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${comment.id} was already handled`);
  await checkHeadPredatesComment(ctx, pull, comment);
  const notify = ctx.notify ?? ctx.write;
  if (!notify) throw new Error("notification token is required after accepting a merge command");
  try {
    await notify.rest.reactions.createForIssueComment({ ...splitRepository(ctx.repository), comment_id: args.comment_id, content: "rocket" });
    ctx.onAccepted?.(pull.headSha);
    // The command comment is valid for 60 minutes, so the wait cannot outlive it.
    const deadline = new Date(comment.createdAt).getTime() + DEADLINE_MINUTES * 60_000;
    const fallback = await platformFallbackReason(ctx, pull);
    if (!fallback) return { head: pull.headSha, platform: true };
    await postReceipt(ctx, pull.number, marker("merge-wait", comment.id), `csm-ci: /merge is not using platform auto-merge because ${escapeHtml(fallback)}. csm-ci's own merge process is running: this pull request is squash-merged if approval and checks are ready by ${new Date(deadline).toISOString()}; otherwise /merge fails with a receipt.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: comment.id, head: pull.headSha, serverRun: ctx.serverRun })}`);
    let last: unknown;
    while (ctx.now().getTime() <= deadline) {
      try {
        await ready(ctx, args, pull.headSha);
        return { head: pull.headSha };
      } catch (error) {
        if (!(error instanceof NotReady)) throw error;
        last = error;
      }
      const remaining = deadline - ctx.now().getTime();
      if (remaining <= 0) break;
      await ctx.sleep(Math.min(30_000, remaining));
    }
    throw new Rejection(`merge readiness deadline passed: ${last instanceof Error ? last.message : "not ready"}`);
  } catch (error) {
    await postFailureReceipt(ctx, args, pull.headSha, error);
    throw error;
  }
}

async function postReceipt(ctx: MergeContext, issueNumber: number, receipt: string, body: string): Promise<void> {
  const write = ctx.notify ?? ctx.write;
  if (!write) throw new Error("write token is required to post a merge receipt");
  const comments = await write.paginate(write.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: issueNumber, per_page: 100 });
  if (hasServerMarker(comments, receipt, ctx.config.apps.server_bot_id)) return;
  try {
    await postResult(write, ctx.repository, issueNumber, receipt, body);
  } catch (error) {
    if (![502, 503, 504].includes(status(error) ?? 0)) throw error;
    const after = await write.paginate(write.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: issueNumber, per_page: 100 });
    if (!hasServerMarker(after, receipt, ctx.config.apps.server_bot_id)) throw error;
  }
}

async function postFailureReceipt(ctx: MergeContext, args: MergeArgs, head: string, failure: unknown): Promise<void> {
  const reason = failure instanceof Error ? failure.message : String(failure);
  try {
    await postMergeFailureReceipt(ctx, args, reason, head);
  } catch (receiptError) {
    const receiptReason = receiptError instanceof Error ? receiptError.message : String(receiptError);
    throw new AggregateError([failure, receiptError], `${reason}; additionally failed to post the merge failure receipt: ${receiptReason}`);
  }
}

export async function postMergeFailureReceipt(ctx: MergeContext, args: MergeArgs, message: string, head: string): Promise<void> {
  await postReceipt(ctx, args.pull_number, marker("merge", args.comment_id), `csm-ci: /merge failed: ${escapeHtml(message)}\n\nResolve the failure, confirm approval and checks for the current head, and post a new exact \`/merge\` comment.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: args.pull_number, commentId: args.comment_id, head, serverRun: ctx.serverRun })}`);
}

export async function runMerge(ctx: MergeContext, args: MergeArgs, expected: MergeReady): Promise<MergeOutcome> {
  const receipt = marker("merge", args.comment_id);
  const write = ctx.write;
  if (!write) throw new Error("write token is required to merge");
  try {
    await refreshConfig(ctx);
  } catch (error) {
    await postFailureReceipt(ctx, args, expected.head, error);
    throw error;
  }
  const existing = await ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: args.pull_number, per_page: 100 });
  if (hasServerMarker(existing, receipt, ctx.config.apps.server_bot_id)) throw new Rejection(`comment ${args.comment_id} was already handled`);
  let outcome: MergeOutcome | undefined;
  let uncertain = false;
  try {
    const optedOut = repositoryEntry(ctx.config, ctx.repository)?.merge?.use_platform_automerge === false;
    if (expected.platform && !optedOut && await enableAutoMerge(ctx, write, args, expected.head)) {
      outcome = { result: "auto-merge", head: expected.head };
      await postReceipt(ctx, args.pull_number, receipt, `csm-ci: /merge enabled platform auto-merge for the pinned head. GitHub squash-merges it once approval and required checks pass; this is not a merge result.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: args.pull_number, commentId: args.comment_id, head: expected.head, serverRun: ctx.serverRun })}`);
      return outcome;
    }
    await ready(ctx, args, expected.head);
    const pull = await pullFacts(ctx.server, ctx.repository, args.pull_number);
    const { title, message: commitMessage } = await commitText(ctx, pull.number);
    for (let attempt = 0; ; attempt++) {
      let data: Awaited<ReturnType<typeof write.rest.pulls.merge>>["data"];
      try {
        ({ data } = await write.rest.pulls.merge({ ...splitRepository(ctx.repository), pull_number: pull.number, sha: expected.head, merge_method: "squash", commit_title: title, commit_message: commitMessage }));
      } catch (error) {
        if (status(error) === 409) throw new Rejection(`pull request #${pull.number} cannot merge because its base changed`);
        const code = status(error);
        const retryable = [405, 422, 503].includes(code ?? 0);
        if (!retryable && code !== 502 && code !== 504 && !timedOut(error) && !isNetworkFailure(error)) throw error;
        uncertain = true;
        try {
          outcome = await reconcileMerge(ctx, pull.number, expected.head);
        } catch (reconcileError) {
          throw new AggregateError([error, reconcileError], "merge response was ambiguous and GitHub state could not be reconciled");
        }
        uncertain = false;
        if (outcome) break;
        if (!retryable || attempt >= 2) throw error;
        await ready(ctx, args, expected.head);
        continue;
      }
      if (!data.merged || !data.sha) throw new Rejection(`GitHub did not merge pull request #${pull.number}`);
      outcome = { result: "merged", head: expected.head, mergeCommit: data.sha };
      break;
    }
    const mergeCommit = outcome.result === "merged" ? outcome.mergeCommit : "";
    await postReceipt(ctx, pull.number, receipt, `csm-ci: /merge succeeded. Squash-merged this pull request.\n\n${receiptFooter({ repository: ctx.repository, pullNumber: pull.number, commentId: args.comment_id, head: expected.head, serverRun: ctx.serverRun, mergeCommit })}`);
    return outcome;
  } catch (error) {
    if (!outcome && !uncertain) await postFailureReceipt(ctx, args, expected.head, error);
    throw error;
  }
}
