import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { github } from "./github.ts";
import { marker } from "./notify.ts";
import { Rejection } from "./request.ts";
import type { Config } from "./config.ts";
import { config, fakeFetch, SERVER_BOT_ID } from "./testing.ts";
import { postMergeFailureReceipt, runMerge, waitForMerge, type MergeContext } from "./merge.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const P = "/repos/owner/repo";
const alice = { id: 10, login: "alice", type: "User" };

function receiptBody(fetch: ReturnType<typeof fakeFetch>): string {
  const request = fetch.requests.find((request) => request.method === "POST" && request.path === `${P}/issues/12/comments`);
  return z.object({ body: z.string() }).parse(JSON.parse(request?.body ?? "{}")).body;
}
function expectReceipt(body: string, operation: string): void {
  expect(body.startsWith(`${marker(operation, 9)}\ncsm-ci: /${operation}`)).toBe(true);
  expect(body.split("<sub>")).toHaveLength(2);
  expect(body.endsWith("</sub>")).toBe(true);
  expect(body).toContain(`<a href="https://github.com/owner/repo/pull/12#issuecomment-9">Request</a>`);
  expect(body).toContain(`<a href="https://github.com/owner/repo/commit/${HEAD}">Head aaaaaaa</a>`);
  expect(body).toContain(`<a href="https://github.com/owner/server/actions/runs/345/attempts/2">Server run 345, attempt 2</a>`);
  expect(body.slice(0, body.indexOf("<sub>"))).not.toContain('<a href=');
}

function pull(over: Record<string, unknown> = {}, repository = "owner/repo") {
  return { number: 12, state: "open", draft: false, user: alice, title: "Example title", body: "Description\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: alice <ALICE@example.com>\nCo-authored-by: Bob <bob@example.com>", head: { sha: HEAD, repo: { full_name: repository } }, base: { ref: "main", repo: { full_name: repository, default_branch: "main" } }, ...over };
}
function comment(over: Record<string, unknown> = {}, repository = "owner/repo") {
  return { id: 9, body: "/merge", issue_url: `https://api.github.com/repos/${repository}/issues/12`, created_at: "2026-10-24T11:30:00Z", updated_at: "2026-10-24T11:30:00Z", node_id: "comment-node", user: alice, ...over };
}
type Setup = { repository?: string; policies?: Config["policies"]; files?: unknown[]; pull?: unknown; pullAfter?: unknown; pullThen?: unknown[]; comment?: unknown; commentStatus?: number; commentAfter?: unknown; lastEditedAt?: string | null; comments?: unknown[]; timeline?: unknown[]; headDate?: string; commits?: unknown[]; reviews?: unknown[]; reviewThen?: unknown[]; checks?: unknown[]; protectedServerRepo?: boolean; receiptStatus?: number };
function context(s: Setup = {}) {
  const repository = s.repository ?? "owner/repo";
  const path = `/repos/${repository}`;
  const server = fakeFetch([
    { method: "GET", path: `${path}/pulls/12`, body: s.pull ?? pull({}, repository), then: s.pullThen ?? [s.pullAfter ?? s.pull ?? pull({}, repository)] },
    { method: "GET", path: `${path}/issues/comments/9`, status: s.commentStatus ?? 200, body: s.comment ?? comment({}, repository), then: [s.commentAfter ?? s.comment ?? comment({}, repository)] },
    { method: "POST", path: "/graphql", body: { data: { node: { databaseId: 9, lastEditedAt: s.lastEditedAt ?? null } } } },
    { method: "GET", path: `${path}/issues/12/comments`, body: s.comments ?? [] },
    { method: "GET", path: `${path}/commits/${HEAD}`, body: { sha: HEAD, commit: { committer: { date: s.headDate ?? "2026-10-24T11:00:00Z" } } } },
    { method: "GET", path: `${path}/issues/12/timeline`, body: s.timeline ?? [] },
    { method: "GET", path: `${path}/pulls/12/commits`, body: s.commits ?? [{ sha: HEAD, commit: { verification: { verified: true } }, author: alice, committer: alice }] },
    { method: "GET", path: `${path}/pulls/12/reviews`, body: s.reviews ?? [{ id: 40, user: { id: 4000 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }], ...(s.reviewThen ? { then: s.reviewThen } : {}) },
    { method: "GET", path: `${path}/commits/${HEAD}/check-runs`, body: s.checks ?? [{ id: 50, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] },
    { method: "GET", path: `${path}/pulls/12/files`, body: s.files ?? [] },
  ]);
  let time = new Date("2026-10-24T11:30:01Z").getTime();
  const cfg = config();
  cfg.merge.deadline_minutes = 1;
  if (s.policies) cfg.policies = s.policies;
  if (s.protectedServerRepo) cfg.server_repository = "owner/repo";
  const notify = fakeFetch([
    { method: "POST", path: `${P}/issues/comments/9/reactions`, status: 201, body: { id: 3 } },
    { method: "GET", path: `${path}/issues/12/comments`, body: [] },
    { method: "POST", path: `${path}/issues/12/comments`, status: s.receiptStatus ?? 201, body: { id: 4 } },
  ]);
  const ctx: MergeContext = { server: github("s", server), notify: github("n", notify), config: cfg, repository, serverRun: { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" }, now: () => new Date(time), sleep: async (ms) => { time += ms; } };
  return { ctx, server, notify };
}

describe("waitForMerge", () => {
  test("exports the pinned head at acceptance even if readiness later fails", async () => {
    const { ctx, notify } = context({ pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) });
    const accepted: string[] = [];
    ctx.onAccepted = (head) => { accepted.push(head); };
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/head changed/);
    expect(accepted).toEqual([HEAD]);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toContain(`the head changed from ${HEAD} to ${NEXT} while waiting`);
  });

  test("a readiness deadline keeps its reason and corrective command at normal size", async () => {
    const { ctx, notify } = context({ reviews: [] });
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/readiness deadline/);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toContain(`merge readiness deadline passed: the approver has not approved head ${HEAD}`);
    expect(body.split("<sub>")[0]).toContain("Resolve the failure, confirm approval and checks for the current head, and post a new exact `/merge` comment.");
    expect(body).not.toContain("rebase");
  });

  test("fresh-token failure receipt escapes the reason and preserves the supplied original head without reading client state", async () => {
    const { ctx, server, notify } = context({ commentStatus: 404, pullAfter: pull({ head: { sha: NEXT } }) });
    await postMergeFailureReceipt(ctx, { pull_number: 12, comment_id: 9 }, 'failed <sub>small</sub> & "unsafe"', HEAD);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toContain('failed &lt;sub&gt;small&lt;/sub&gt; &amp; &quot;unsafe&quot;');
    expect(server.calls).toEqual([]);
  });

  test("fresh-token failure receipt is silent when the server already recorded a result", async () => {
    const { ctx, notify } = context();
    const duplicate = fakeFetch([{ method: "GET", path: `${P}/issues/12/comments`, body: [{ user: { id: SERVER_BOT_ID }, body: marker("merge", 9) }] }]);
    ctx.notify = github("n", duplicate);
    await postMergeFailureReceipt(ctx, { pull_number: 12, comment_id: 9 }, "timeout", HEAD);
    expect(duplicate.calls).toEqual([`GET ${P}/issues/12/comments`]);
    expect(notify.calls).toEqual([]);
  });

  test("pins an authorized /merge to a ready head", async () => {
    const { ctx } = context();
    expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  test("rechecks the current server configuration without blocking a still-authorized merger", async () => {
    const { ctx } = context();
    const config = ctx.config;
    ctx.reloadConfig = async () => config;
    expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  test("rejects a merger removed from the current server configuration while waiting", async () => {
    const { ctx, notify } = context();
    const config = ctx.config;
    let reads = 0;
    ctx.reloadConfig = async () => {
      reads += 1;
      return reads === 1 ? config : { ...config, trust: { ...config.trust, mergers: [] } };
    };
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/alice is not one of the mergers/);
    expect(reads).toBe(2);
    expect(notify.calls).toContain(`POST ${P}/issues/comments/9/reactions`);
    expect(notify.calls).toContain(`POST ${P}/issues/12/comments`);
  });

  test("rejects merge when the current server configuration disables the operation", async () => {
    const { ctx } = context();
    const config = ctx.config;
    let reads = 0;
    ctx.reloadConfig = async () => {
      reads += 1;
      return reads === 1 ? config : {
        ...config,
        repositories: config.repositories.map((entry) => entry.name === "owner/*" ? { ...entry, ops: ["approve", "policy-check"] } : entry),
      };
    };
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/repository owner\/repo no longer enables merge/);
    expect(reads).toBe(2);
  });

  test("rejects merge when the current server configuration removes the repository", async () => {
    const { ctx } = context();
    const config = ctx.config;
    let reads = 0;
    ctx.reloadConfig = async () => reads++ === 0 ? config : { ...config, repositories: config.repositories.filter((entry) => entry.name !== "owner/*") };
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/repository owner\/repo is no longer managed by this server/);
    expect(reads).toBe(2);
  });

  test("posts an accepted-command failure receipt even after current config disables merge", async () => {
    const { ctx, notify } = context();
    ctx.reloadConfig = async () => ({ ...ctx.config, repositories: ctx.config.repositories.map((entry) => ({ ...entry, ops: ["approve", "policy-check"] })) });
    await postMergeFailureReceipt(ctx, { pull_number: 12, comment_id: 9 }, "merge retry window expired", HEAD);
    expect(notify.calls).toContain(`POST ${P}/issues/12/comments`);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toContain("merge retry window expired");
  });

  test("preserves the readiness error when posting its failure receipt also fails", async () => {
    const { ctx } = context({ pullAfter: pull({ state: "closed" }), receiptStatus: 500 });
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 }))
      .rejects.toThrow(/#12 is closed; additionally failed to post the merge failure receipt/);
  });

  test("allows a configured bot to merge its own pull request when every commit is by that bot", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx } = context({
      pull: pull({ user: bot }),
      comment: comment({ user: bot }),
      commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: bot, committer: bot }],
    });
    expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  test.each([undefined, {}, { allow_bot_requests: true }, { allow_bot_requests: false }] satisfies Array<Config["repositories"][number]["merge"]>)("repository Bot permission %j is independent of trust", async (merge) => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, notify } = context({ pull: pull({ user: bot }), comment: comment({ user: bot }), commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: bot, committer: bot }] });
    ctx.config.repositories = [{ name: "owner/repo", ops: ["merge"], ...(merge === undefined ? {} : { merge }) }, { name: "owner/*", ops: ["merge"], merge: { allow_bot_requests: false } }];
    if (merge?.allow_bot_requests === false) {
      await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("bot merge requests are disabled for repository owner/repo");
      expect(notify.calls).toEqual([]);
    } else expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  test.each(["owner/server", "civitaspo/csm-ci-actions"])("legacy protection rejects explicit Bot permission for %s", async (repository) => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, notify } = context({ repository, pull: pull({ user: bot }, repository), comment: comment({ user: bot }, repository) });
    ctx.config.owners.push("civitaspo");
    ctx.config.repositories = [{ name: repository, ops: ["merge"], merge: { allow_bot_requests: true }, sensitive_paths: { paths: [], exempt: [bot] } }];
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(`bot mergers cannot merge pull requests in protected repository ${repository}`);
    expect(notify.calls).toEqual([]);
  });

  test("repository Bot restriction does not reject an authorized human", async () => {
    const { ctx } = context();
    ctx.config.repositories = [{ name: "owner/repo", ops: ["merge"], merge: { allow_bot_requests: false } }];
    expect(await waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ head: HEAD });
  });

  test("revoking Bot permission during a readiness wait aborts the request", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx } = context({ pull: pull({ user: bot }), comment: comment({ user: bot }), commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: bot, committer: bot }], reviews: [] });
    const original = ctx.config;
    const sleep = ctx.sleep;
    ctx.sleep = async (ms) => { await sleep(ms); ctx.config = { ...original, repositories: [{ name: "owner/repo", ops: ["merge"], merge: { allow_bot_requests: false } }] }; };
    ctx.reloadConfig = async () => ctx.config;
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("bot merge requests are disabled for repository owner/repo");
  });

  const rejects: [string, Setup, RegExp][] = [
    ["a commenter outside the merger allowlist", { comment: comment({ user: { id: 66, login: "mallory", type: "User" } }) }, /mallory is not one of the mergers/],
    ["a non-command comment", { comment: comment({ body: "LGTM" }) }, /not exactly/],
    ["a draft pull request", { pull: pull({ draft: true }) }, /is a draft/],
    ["a replayed command", { comments: [{ user: { id: SERVER_BOT_ID }, body: `${marker("merge", 9)}\nmerged` }] }, /already handled/],
    ["a deleted comment author", { comment: comment({ user: null }) }, /merge comment author was deleted/],
    ["a deleted command", { commentStatus: 404 }, /Unknown error/],
    ["a wrong command routed to merge", { comment: comment({ body: "/approve" }) }, /comment 9 is not \/merge/],
    ["a command changed to another operation while waiting", { commentAfter: comment({ body: "/approve" }) }, /comment 9 is no longer \/merge/],
    ["a head newer than the command", { headDate: "2026-10-24T11:30:01Z" }, /newer than comment 9/],
    ["a force-push after the command", { timeline: [{ event: "head_ref_force_pushed", created_at: "2026-10-24T11:40:00Z" }] }, /force-pushed after comment 9/],
    ["an edited command", { comment: comment({ updated_at: "2026-10-24T11:31:00Z" }) }, /was edited/],
    ["a command edited in the same second", { lastEditedAt: "2026-10-24T11:30:00Z" }, /was edited/],
    ["a changed head while waiting", { pull: pull(), pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) }, /head changed from/],
    ["a bot merging another author's pull request", { pull: pull({ user: { id: 10, login: "alice" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }) }, /bot merger renovate\[bot\] can merge only its own/],
    ["a bot merger with another committer's commit", { pull: pull({ user: { id: 20, login: "renovate[bot]" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }), commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: alice, committer: alice }] }, /bot merger renovate\[bot\] can merge only commits by itself/],
    ["a bot merger targeting the server repository", { protectedServerRepo: true, pull: pull({ user: { id: 20, login: "renovate[bot]" } }), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }) }, /bot mergers cannot merge pull requests in protected repository/],
    ["a bot merger targeting csm-ci-actions", { repository: "civitaspo/csm-ci-actions", pull: pull({}, "civitaspo/csm-ci-actions"), comment: comment({ user: { id: 20, login: "renovate[bot]", type: "Bot" } }, "civitaspo/csm-ci-actions") }, /bot mergers cannot merge pull requests in protected repository/],
    ["an unsupported account type", { comment: comment({ user: { id: 20, login: "some-org", type: "Organization" } }) }, /some-org has unsupported account type Organization/],
    ["an unsigned commit", { commits: [{ sha: HEAD, commit: { verification: { verified: false } }, author: alice, committer: alice }] }, /trust failed: signed-commits: .*not signed/],
    ["a latest review that requests changes", { reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }, { user: { id: 4000 }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-10-24T11:40:00Z" }] }, /readiness deadline passed: the approver has not approved/],
    ["a latest review for another head", { reviews: [{ id: 40, user: { id: 4000 }, state: "APPROVED", commit_id: NEXT, submitted_at: "2026-10-24T11:20:00Z" }] }, /readiness deadline passed: the approver has not approved/],
    ["an approval from another reviewer", { reviews: [{ user: { id: 10 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }] }, /readiness deadline passed: the approver has not approved/],
    ["a later review ID at the same timestamp", { reviews: [{ id: 41, user: { id: 4000 }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }, { id: 40, user: { id: 4000 }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-24T11:20:00Z" }] }, /readiness deadline passed: the approver has not approved/],
    ["an untrusted check producer", { checks: [{ id: 50, name: "status-check", app: { id: 999 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
    ["a required check that is still running", { checks: [{ id: 50, name: "status-check", app: { id: 15368 }, status: "in_progress", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
    ["a missing required check name", { checks: [{ id: 50, name: "other-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
    ["a failed required check", { checks: [{ id: 50, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "failure", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
    ["a newer failed check run with the same timestamp", { checks: [{ id: 51, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "failure", started_at: "2026-10-24T11:10:00Z" }, { id: 50, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, /readiness deadline passed: status-check from app 15368/],
    ["a sensitive-path policy that is not yet approved", { policies: [{ type: "sensitive-paths", paths: ["protected/**"], exempt: [] }], files: [{ filename: "protected/file.txt" }] }, /merge readiness deadline passed: policies failed: sensitive-paths: .*need a trusted approver's \/approve/],
  ];
  test.each(rejects)("rejects %s with an observable reason", async (_, setup, message) => {
    const { ctx, notify } = context(setup);
    if (_ === "a bot merger targeting csm-ci-actions") {
      ctx.config.owners.push("civitaspo");
      ctx.config.repositories.push({ name: "civitaspo/csm-ci-actions", ops: ["merge"] });
    }
    await expect(waitForMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(message);
    const accepted = !["a commenter outside the merger allowlist", "a non-command comment", "a draft pull request", "a replayed command", "a deleted comment author", "a deleted command", "a wrong command routed to merge", "a head newer than the command", "a force-push after the command", "an edited command", "a command edited in the same second", "a bot merging another author's pull request", "a bot merger with another committer's commit", "a bot merger targeting the server repository", "a bot merger targeting csm-ci-actions", "an unsupported account type"].includes(_);
    expect(notify.calls.includes(`POST ${P}/issues/comments/9/reactions`)).toBe(accepted);
    if (accepted) {
      expect(notify.calls).toContain(`POST ${P}/issues/12/comments`);
      const body = receiptBody(notify);
      expectReceipt(body, "merge");
      expect(body.split("<sub>")[0]?.replaceAll("&#39;", "'")).toMatch(message);
      expect(body.split("<sub>")[0]).toContain("post a new exact `/merge` comment.");
    } else {
      expect(notify.calls).not.toContain(`POST ${P}/issues/12/comments`);
    }
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

  test.each(["Bot permission", "sensitive paths"])("final revalidation applies revoked %s without a merge write", async (rule) => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, write } = writableContext(200, undefined, { pull: pull({ user: bot }), comment: comment({ user: bot }), commits: [{ sha: HEAD, commit: { verification: { verified: true } }, author: bot, committer: bot }], files: [{ filename: "sensitive.txt" }] });
    ctx.config.repositories = [{ name: "owner/repo", ops: ["merge"], sensitive_paths: { paths: [] } }];
    const ready = await waitForMerge(ctx, { pull_number: 12, comment_id: 9 });
    ctx.reloadConfig = async () => ({ ...ctx.config, repositories: [{ name: "owner/repo", ops: ["merge"], ...(rule === "Bot permission" ? { merge: { allow_bot_requests: false } } : { sensitive_paths: { paths: ["**"], exempt: [] } }) }] });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, ready)).rejects.toThrow(rule === "Bot permission" ? "bot merge requests are disabled for repository owner/repo" : "policies failed: sensitive-paths: sensitive paths need a trusted approver's /approve: sensitive.txt");
    expect(write.calls).toEqual([]);
  });

  test("squash merges the pinned head and posts one receipt", async () => {
    const { ctx, write, notify } = writableContext(200);
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expectReceipt(receiptBody(notify), "merge");
    expect(receiptBody(notify)).toContain(`<a href="https://github.com/owner/repo/commit/${"c".repeat(40)}">Squash commit ccccccc</a>`);
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toBe(`${marker("merge", 9)}\ncsm-ci: /merge succeeded. Squash-merged this pull request.\n\n`);
    expect(body).toContain(`<a href="https://github.com/owner/repo/commit/${"c".repeat(40)}">Squash commit ccccccc</a>`);
  });


  test.each([
    [409, { message: "Conflict" }, /base changed/],
    [500, { message: "upstream failure" }, /upstream failure/],
    [200, { merged: false, sha: null }, /GitHub did not merge/],
  ] satisfies [number, unknown, RegExp][])("merge write failure %s keeps its reason and original pinned head", async (status, response, reason) => {
    const { ctx, notify } = writableContext(status, response);
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(reason);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toMatch(reason);
    expect(body.split("<sub>")[0]).toContain("post a new exact `/merge` comment.");
  });

  test("configuration failure before the merge write preserves request metadata", async () => {
    const { ctx, notify, write } = writableContext(200);
    ctx.reloadConfig = async () => ({ ...ctx.config, repositories: [] });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/no longer managed/);
    const body = receiptBody(notify);
    expectReceipt(body, "merge");
    expect(body.split("<sub>")[0]).toContain("repository owner/repo is no longer managed by this server");
    expect(write.calls).toEqual([]);
  });
  test("passes the pull request title and body with duplicate coauthor lines removed", async () => {
    const { ctx, write } = writableContext(200);
    await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD });
    const request = write.requests.find((item) => item.method === "PUT" && item.path === `${P}/pulls/12/merge`);
    expect(request?.body).toBeDefined();
    const payload = JSON.parse(request?.body ?? "{}");
    expect(payload.commit_title).toBe("Example title");
    expect(payload.commit_message).toBe("Description\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Bob <bob@example.com>");
  });

  test("rejects a successful HTTP response that does not report a merged pull request", async () => {
    const { ctx, write } = writableContext(200, { merged: false, sha: null });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/GitHub did not merge/);
    expect(write.calls.filter((call) => call === `PUT ${P}/pulls/12/merge`)).toHaveLength(1);
  });

  test("preserves the readiness error when posting the merge failure receipt also fails", async () => {
    const { ctx } = writableContext(200, undefined, { pull: pull({ state: "closed" }), receiptStatus: 500 });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/#12 is closed; additionally failed to post the merge failure receipt/);
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
    expectReceipt(receiptBody(notify), "merge");
    expect(receiptBody(notify)).toContain(`<a href="https://github.com/owner/repo/commit/${"c".repeat(40)}">Squash commit ccccccc</a>`);
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("reconciles a timed out merge request without retrying or posting a failure receipt", async () => {
    const merged = pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40) });
    const { ctx, notify } = writableContext(200, undefined, { pullThen: [pull(), pull(), merged, merged] });
    const timedOutFetch = (async () => { throw new DOMException("GitHub request timed out", "TimeoutError"); }) as unknown as typeof globalThis.fetch;
    ctx.write = github("w", timedOutFetch);
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expectReceipt(receiptBody(notify), "merge");
    expect(receiptBody(notify)).toContain(`<a href="https://github.com/owner/repo/commit/${"c".repeat(40)}">Squash commit ccccccc</a>`);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("reconciles a network failure after merge acceptance without retrying", async () => {
    const merged = pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40) });
    const { ctx, write, notify } = writableContext(200, undefined, { pullThen: [pull(), pull(), merged, merged] });
    let mergeRequests = 0;
    const failAfterAccept = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === `${P}/pulls/12/merge`) {
        mergeRequests += 1;
        throw new TypeError("fetch failed");
      }
      return write(input, init);
    }) as unknown as typeof globalThis.fetch;
    ctx.write = github("w", failAfterAccept);
    expect(await runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).toEqual({ result: "merged", head: HEAD, mergeCommit: "c".repeat(40) });
    expectReceipt(receiptBody(notify), "merge");
    expect(receiptBody(notify)).toContain(`<a href="https://github.com/owner/repo/commit/${"c".repeat(40)}">Squash commit ccccccc</a>`);
    expect(mergeRequests).toBe(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("does not retry an ambiguous 502 when the pull request remains open", async () => {
    const { ctx, write, notify } = writableContext(502, { message: "upstream error" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test.each([
    ["head", pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40), head: { sha: NEXT, repo: { full_name: "owner/repo" } } })],
    ["merger", pull({ state: "closed", merged: true, merged_by: { id: 10 }, merge_commit_sha: "c".repeat(40) })],
    ["merged state", pull({ state: "closed", merged: false, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: "c".repeat(40) })],
    ["merge commit SHA", pull({ state: "closed", merged: true, merged_by: { id: SERVER_BOT_ID }, merge_commit_sha: null })],
  ])("does not reconcile a 502 with a mismatched %s", async (_, snapshot) => {
    const { ctx, write, notify } = writableContext(502, { message: "upstream error" }, { pullThen: [pull(), pull(), snapshot] });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/upstream error/);
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(1);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
    const receipt = notify.requests.find((request) => request.method === "POST" && request.path === `${P}/issues/12/comments`);
    expect(receipt?.body).toContain("failed");
  });

  test("revalidates readiness before retrying a 405", async () => {
    const { ctx, write, notify } = writableContext(405, { message: "not mergeable" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(3);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });

  test("stops a retry after approval is withdrawn during the revalidation", async () => {
    const withdrawn = [{ id: 41, user: { id: 4000 }, state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: "2026-10-24T11:40:00Z" }];
    const { ctx, server, write } = writableContext(405, { message: "not mergeable" }, { reviewThen: [withdrawn] });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow(/approver has not approved/);
    expect(write.calls.filter((call) => call === `PUT ${P}/pulls/12/merge`)).toHaveLength(1);
    expect(server.calls.filter((call) => call === `GET ${P}/pulls/12/reviews`)).toHaveLength(2);
  });

  test.each([422, 503])("revalidates readiness before retrying a %i", async (status) => {
    const { ctx, write, notify } = writableContext(status, { message: "temporary blocker" });
    await expect(runMerge(ctx, { pull_number: 12, comment_id: 9 }, { head: HEAD })).rejects.toThrow();
    expect(write.calls.filter((call) => call === "PUT /repos/owner/repo/pulls/12/merge")).toHaveLength(3);
    expect(notify.calls.filter((call) => call === "POST /repos/owner/repo/issues/12/comments")).toHaveLength(1);
  });
});
