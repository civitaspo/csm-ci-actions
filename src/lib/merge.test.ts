import { describe, expect, test } from "bun:test";
import { github } from "./github.ts";
import { marker } from "./notify.ts";
import { Rejection } from "./request.ts";
import { config, fakeFetch, SERVER_BOT_ID } from "./testing.ts";
import { runMerge, waitForMerge, type MergeContext } from "./merge.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const P = "/repos/owner/repo";
const alice = { id: 10, login: "alice", type: "User" };

function pull(over: Record<string, unknown> = {}) {
  return { number: 12, state: "open", draft: false, user: alice, head: { sha: HEAD, repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { full_name: "owner/repo", default_branch: "main" } }, ...over };
}
function comment(over: Record<string, unknown> = {}) {
  return { id: 9, body: "/merge", issue_url: `https://api.github.com${P}/issues/12`, created_at: "2026-10-24T11:30:00Z", updated_at: "2026-10-24T11:30:00Z", node_id: "comment-node", user: alice, ...over };
}
type Setup = { pull?: unknown; pullAfter?: unknown; pullThen?: unknown[]; comment?: unknown; commentStatus?: number; commentAfter?: unknown; lastEditedAt?: string | null; comments?: unknown[]; timeline?: unknown[]; headDate?: string; commits?: unknown[]; reviews?: unknown[]; checks?: unknown[]; protectedServerRepo?: boolean };
function context(s: Setup = {}) {
  const server = fakeFetch([
    { method: "GET", path: `${P}/pulls/12`, body: s.pull ?? pull(), then: s.pullThen ?? [s.pullAfter ?? s.pull ?? pull()] },
    { method: "GET", path: `${P}/issues/comments/9`, status: s.commentStatus ?? 200, body: s.comment ?? comment(), then: [s.commentAfter ?? s.comment ?? comment()] },
    { method: "POST", path: "/graphql", body: { data: { node: { databaseId: 9, lastEditedAt: s.lastEditedAt ?? null } } } },
    { method: "GET", path: `${P}/issues/12/comments`, body: s.comments ?? [] },
    { method: "GET", path: `${P}/commits/${HEAD}`, body: { sha: HEAD, commit: { committer: { date: s.headDate ?? "2026-10-24T11:00:00Z" } } } },
    { method: "GET", path: `${P}/issues/12/timeline`, body: s.timeline ?? [] },
    { method: "GET", path: `${P}/pulls/12/commits`, body: s.commits ?? [{ sha: HEAD, commit: { verification: { verified: true } }, author: alice, committer: alice }] },
    { method: "GET", path: `${P}/pulls/12/reviews`, body: s.reviews ?? [{ user: { id: 4000 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }] },
    { method: "GET", path: `${P}/commits/${HEAD}/check-runs`, body: s.checks ?? [{ name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] },
  ]);
  let time = new Date("2026-10-24T11:30:01Z").getTime();
  const cfg = config();
  cfg.merge.deadline_minutes = 1;
  if (s.protectedServerRepo) cfg.server_repository = "owner/repo";
  const notify = fakeFetch([
    { method: "POST", path: `${P}/issues/comments/9/reactions`, status: 201, body: { id: 3 } },
    { method: "GET", path: `${P}/issues/12/comments`, body: [] },
    { method: "POST", path: `${P}/issues/12/comments`, status: 201, body: { id: 4 } },
  ]);
  const ctx: MergeContext = { server: github("s", server), notify: github("n", notify), config: cfg, repository: "owner/repo", now: () => new Date(time), sleep: async (ms) => { time += ms; } };
  return { ctx, server, notify };
}

describe("waitForMerge", () => {
  test("pins an authorized /merge to a ready head", async () => {
    const { ctx } = context();
    expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  const rejects: [string, Setup, RegExp][] = [
    ["a commenter outside the merger allowlist", { comment: comment({ user: { id: 66, login: "mallory", type: "User" } }) }, /mallory is not one of the mergers/],
    ["a non-command comment", { comment: comment({ body: "LGTM" }) }, /not exactly/],
    ["a draft pull request", { pull: pull({ draft: true }) }, /is a draft/],
    ["a replayed command", { comments: [{ user: { id: SERVER_BOT_ID }, body: `${marker("merge", 9)}\nmerged` }] }, /already handled/],
    ["a deleted command", { commentStatus: 404 }, /Unknown error/],
    ["a head newer than the command", { headDate: "2026-10-24T11:30:01Z" }, /newer than comment 9/],
    ["a force-push after the command", { timeline: [{ event: "head_ref_force_pushed", created_at: "2026-10-24T11:40:00Z" }] }, /force-pushed after comment 9/],
    ["an edited command", { comment: comment({ updated_at: "2026-10-24T11:31:00Z" }) }, /was edited/],
    ["a command edited in the same second", { lastEditedAt: "2026-10-24T11:30:00Z" }, /was edited/],
    ["a changed head while waiting", { pull: pull(), pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) }, /head changed from/],
    ["a bot merging another author's pull request", { pull: pull({ user: { id: 10, login: "alice" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }) }, /bot merger renovate\[bot\] can merge only its own/],
    ["a bot merger with another committer's commit", { pull: pull({ user: { id: 20, login: "renovate[bot]" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }), commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: alice, committer: alice }] }, /bot merger renovate\[bot\] can merge only commits by itself/],
    ["a bot merger targeting the server repository", { protectedServerRepo: true, pull: pull({ user: { id: 20, login: "renovate[bot]" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }) }, /bot mergers cannot merge pull requests in protected repository/],
    ["an unsigned commit", { commits: [{ sha: HEAD, commit: { verification: { verified: false } }, author: alice, committer: alice }] }, /trust failed: signed-commits: .*not signed/],
    ["a latest review that requests changes", { reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }, { user: { id: 4000 }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-10-24T11:40:00Z" }] }, /readiness deadline passed: the approver has not approved/],
    ["an untrusted check producer", { checks: [{ name: "status-check", app: { id: 999 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
  ];
  test.each(rejects)("rejects %s with an observable reason", async (_, setup, message) => {
    const { ctx, notify } = context(setup);
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(message);
    const accepted = !["a commenter outside the merger allowlist", "a non-command comment", "a draft pull request", "a replayed command", "a deleted command", "a head newer than the command", "a force-push after the command", "an edited command", "a command edited in the same second", "a bot merging another author's pull request", "a bot merger with another committer's commit", "a bot merger targeting the server repository"].includes(_);
    expect(notify.calls.includes(`POST ${P}/issues/comments/9/reactions`)).toBe(accepted);
    if (accepted) expect(notify.calls).toContain(`POST ${P}/issues/12/comments`);
  });
});

describe("runMerge", () => {
  function writableContext(mergeStatus: number, mergeBody: unknown = { merged: true, sha: "c".repeat(40) }, setup: Setup = {}) {
    const base = context(setup);
    const write = fakeFetch([
      { method: "PUT", path: `${P}/pulls/12/merge`, status: mergeStatus, body: mergeBody },
    ]);
    base.ctx.write = github("w", write);
    return { ...base, write, notify: base.notify };
  }

  test("squash merges the pinned head and posts one receipt", async () => {
    const { ctx, write, notify } = writableContext(200);
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("fails a 409 base conflict without retrying", async () => {
    const { ctx, write } = writableContext(409, { message: "Conflict" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/base changed/);
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
  });

  test("rejects a replay before reacting or merging", async () => {
    const { ctx, write, notify } = writableContext(200);
    ctx.server = github("s", fakeFetch([
      { method: "GET", path: `${P}/issues/12/comments`, body: [{ user: { id: SERVER_BOT_ID }, body: `${marker("merge", 9)} done` }] },
    ]));
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/already handled/);
    expect(write.calls).toEqual([]);
    expect(notify.calls).toEqual([]);
  });

  test.each([502, 504])("reconciles a %i merge response against the merged pull request", async (status) => {
    const merged = pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40) });
    const { ctx, write, notify } = writableContext(status, { message: "upstream error" }, { pullThen: [pull(), pull(), merged, merged] });
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("reconciles a timed out merge request without retrying or posting a failure receipt", async () => {
    const merged = pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40) });
    const { ctx, notify } = writableContext(200, undefined, { pullThen: [pull(), pull(), merged, merged] });
    const timedOutFetch = (async () => { throw new DOMException("GitHub request timed out", "TimeoutError"); }) as unknown as typeof globalThis.fetch;
    ctx.write = github("w", timedOutFetch);
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("does not retry an ambiguous 502 when the pull request remains open", async () => {
    const { ctx, write, notify } = writableContext(502, { message: "upstream error" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("revalidates readiness before retrying a 405", async () => {
    const { ctx, write, notify } = writableContext(405, { message: "not mergeable" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(3);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test.each([422, 503])("revalidates readiness before retrying a %i", async (status) => {
    const { ctx, write, notify } = writableContext(status, { message: "temporary blocker" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(3);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });
});
