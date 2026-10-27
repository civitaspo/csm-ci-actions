import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type ApproveContext, runApprove } from "./approve.ts";
import { github } from "./github.ts";
import { marker } from "./notify.ts";
import { Rejection } from "./request.ts";
import { APPROVER_BOT_ID, config, CONFIG_YAML, fakeFetch, SERVER_BOT_ID } from "./testing.ts";
import { parseConfig } from "./config.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const P = "/repos/owner/repo";
const NOW = new Date("2026-10-24T12:00:00Z");
const alice = { id: 10, login: "alice", type: "User" };
const mallory = { id: 66, login: "mallory", type: "User" };

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

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 12,
    state: "open",
    draft: false,
    user: { id: 10, login: "alice" },
    head: { sha: HEAD, repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo", default_branch: "main" } },
    ...over,
  };
}
function commit(sha: string, over: Record<string, unknown> = {}) {
  return { sha, commit: { verification: { verified: true } }, author: alice, committer: alice, ...over };
}
function comment(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    body: "/approve",
    issue_url: `https://api.github.com${P}/issues/12`,
    created_at: "2026-10-24T11:30:00Z",
    updated_at: "2026-10-24T11:30:00Z",
    node_id: "comment-node",
    user: alice,
    ...over,
  };
}

type Setup = {
  pull?: unknown;
  pullAfter?: unknown;
  commits?: unknown[];
  reviews?: unknown[];
  comment?: unknown;
  commentAfter?: unknown;
  issueComments?: unknown[];
  reviewer?: unknown;
  headDate?: string;
  timeline?: unknown[];
  editNode?: unknown;
  editNodeAfter?: unknown;
  editStatus?: number;
  files?: unknown[];
  config?: ReturnType<typeof config>;
};

function context(s: Setup = {}) {
  const server = fakeFetch([
    { method: "POST", path: "/graphql", status: s.editStatus ?? 200, body: { data: { node: s.editNode === undefined ? { databaseId: 9, lastEditedAt: null } : s.editNode } }, then: [{ data: { node: s.editNodeAfter ?? s.editNode ?? { databaseId: 9, lastEditedAt: null } } }] },
    { method: "GET", path: `${P}/pulls/12`, body: s.pull ?? pull(), then: [s.pullAfter ?? s.pull ?? pull()] },
    { method: "GET", path: `${P}/pulls/12/commits`, body: s.commits ?? [commit(HEAD)] },
    { method: "GET", path: `${P}/pulls/12/reviews`, body: s.reviews ?? [] },
    ...(s.files ? [{ method: "GET", path: `${P}/pulls/12/files`, body: s.files }] : []),
    { method: "GET", path: `${P}/issues/comments/9`, body: s.comment ?? comment(), then: [s.commentAfter ?? s.comment ?? comment()] },
    { method: "POST", path: `${P}/issues/comments/9/reactions`, status: 201, body: { content: "rocket" } },
    { method: "GET", path: `${P}/issues/12/comments`, body: s.issueComments ?? [] },
    { method: "POST", path: `${P}/issues/12/comments`, status: 201, body: { id: 1 } },
    { method: "GET", path: `${P}/commits/${HEAD}`, body: { sha: HEAD, commit: { committer: { date: s.headDate ?? "2026-10-24T11:00:00Z" } } } },
    { method: "GET", path: `${P}/issues/12/timeline`, body: s.timeline ?? [] },
    { method: "GET", path: `${P}/commits/${HEAD}/check-runs`, body: [] },
    { method: "GET", path: `${P}/commits/${NEXT}/check-runs`, body: [] },
    { method: "POST", path: `${P}/check-runs`, status: 201, body: { id: 88 } },
  ]);
  const approver = fakeFetch([
    { method: "POST", path: `${P}/pulls/12/reviews`, body: { id: 77, user: s.reviewer ?? { id: APPROVER_BOT_ID, login: "approver[bot]" } } },
    { method: "PUT", path: `${P}/pulls/12/reviews/77/dismissals`, body: { id: 77 } },
  ]);
  const ctx: ApproveContext = { server: github("s", server), approver: github("a", approver), config: s.config ?? config(), repository: "owner/repo", serverRun: { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" }, now: () => NOW };
  return { ctx, server, approver };
}

describe("runApprove automatic", () => {
  test.each([
    ["approved", {}],
    ["declined", { commits: [commit(HEAD, { committer: mallory, author: mallory })] }],
    ["already-approved", { reviews: [{ user: { id: APPROVER_BOT_ID }, state: "APPROVED", commit_id: HEAD }] }],
    ["dismissed", { pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) }],
  ] satisfies [Awaited<ReturnType<typeof runApprove>>["result"], Setup][])("automatic %s does not emit a result comment", async (result, setup) => {
    const { ctx, server } = context(setup);
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe(result);
    expect(server.calls).not.toContain(`POST ${P}/issues/12/comments`);
  });

  test("approves a pull request whose commits are all trusted", async () => {
    const { ctx, approver } = context();
    expect(await runApprove(ctx, { pull_number: 12 })).toEqual({ result: "approved", head: HEAD, problems: [] });
    expect(approver.calls).toEqual([`POST ${P}/pulls/12/reviews`]);
  });

  test("declines without touching the approver when a commit is untrusted", async () => {
    const { ctx, approver } = context({ commits: [commit(HEAD, { committer: mallory, author: mallory })] });
    const outcome = await runApprove(ctx, { pull_number: 12 });
    expect(outcome.result).toBe("declined");
    expect(outcome.problems.join("\n")).toMatch(/trusted-committers: .* is by mallory/);
    expect(approver.calls).toEqual([]);
  });

  test("does nothing when the approver already approved this head", async () => {
    const { ctx, approver } = context({ reviews: [{ user: { id: APPROVER_BOT_ID }, state: "APPROVED", commit_id: HEAD }] });
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe("already-approved");
    expect(approver.calls).toEqual([]);
  });

  test("approves again when the earlier approval is for another head", async () => {
    const { ctx } = context({ reviews: [{ user: { id: APPROVER_BOT_ID }, state: "APPROVED", commit_id: NEXT }] });
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe("approved");
  });

  test("dismisses its approval when the head moved while approving", async () => {
    const { ctx, approver } = context({ pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) });
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe("dismissed");
    expect(approver.calls).toEqual([`POST ${P}/pulls/12/reviews`, `PUT ${P}/pulls/12/reviews/77/dismissals`]);
  });

  test("does not refresh the policy check after the PR closes while approving", async () => {
    const { ctx, server } = context({ pullAfter: pull({ state: "closed" }) });
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe("approved");
    expect(server.calls).not.toContain(`POST ${P}/check-runs`);
    expect(server.calls.some((call) => call.startsWith(`PATCH ${P}/check-runs/`))).toBe(false);
  });

  test("dismisses and fails when the approver token belongs to someone else", async () => {
    const { ctx, approver } = context({ reviewer: { id: 5, login: "other[bot]" } });
    await expect(runApprove(ctx, { pull_number: 12 })).rejects.toThrow(/belongs to other\[bot\]/);
    expect(approver.calls).toContain(`PUT ${P}/pulls/12/reviews/77/dismissals`);
  });

  const rejects: [string, Setup, RegExp][] = [
    ["a draft", { pull: pull({ draft: true }) }, /is a draft/],
    ["a fork", { pull: pull({ head: { sha: HEAD, repo: { full_name: "fork/repo" } } }) }, /from a fork/],
    ["the approver as author", { pull: pull({ user: { id: APPROVER_BOT_ID, login: "approver[bot]" } }) }, /approver authored/],
  ];
  test.each(rejects)("rejects %s", async (_, setup, message) => {
    const { ctx, approver } = context(setup);
    await expect(runApprove(ctx, { pull_number: 12 })).rejects.toThrow(message);
    expect(approver.calls).toEqual([]);
  });
});

describe("runApprove commands", () => {
  test.each([403, 500])("propagates edit-history API failure %s without approving", async (status) => {
    const { ctx, server, approver } = context({ editStatus: status });
    await expect(runApprove(ctx, { pull_number: 12, comment_id: 9 })).rejects.toMatchObject({ status });
    expect(approver.calls).toEqual([]);
    expect(server.calls).not.toContain(`POST ${P}/issues/comments/9/reactions`);
  });

  test("/approve by an approver reacts, marks the review and posts a receipt", async () => {
    const { ctx, server, approver } = context();
    expect((await runApprove(ctx, { pull_number: 12, comment_id: 9 })).result).toBe("approved");
    expect(server.calls).toContain(`POST ${P}/issues/comments/9/reactions`);
    expect(server.calls).toContain(`POST ${P}/issues/12/comments`);
    expect(approver.calls).toEqual([`POST ${P}/pulls/12/reviews`]);
    const body = receiptBody(server);
    expectReceipt(body, "approve");
    expect(body.split("<sub>")[0]).toBe(`${marker("approve", 9)}\ncsm-ci: /approve succeeded. Approved the requested head.\n\n`);
  });


  test("an operational approval failure reports its actual error and corrective command", async () => {
    const { ctx, server } = context({ reviewer: { id: 5, login: 'other<sub>[bot]' } });
    await expect(runApprove(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(/approver token belongs/);
    const body = receiptBody(server);
    expectReceipt(body, "approve");
    expect(body.split("<sub>")[0]).toContain('/approve failed: the approver token belongs to other&lt;sub&gt;[bot], not approver[bot]');
    expect(body.split("<sub>")[0]).toContain("Resolve the failure, review the current head, and post a new exact `/approve` comment.");
  });
  test("the review body carries the command marker", async () => {
    const seen: string[] = [];
    const { ctx } = context();
    const approver = fakeFetch([{ method: "POST", path: `${P}/pulls/12/reviews`, body: { id: 77, user: { id: APPROVER_BOT_ID } } }]);
    const capture = (async (input: Parameters<typeof approver>[0], init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      return approver(input, init);
    }) as typeof globalThis.fetch;
    await runApprove({ ...ctx, approver: github("a", capture) }, { pull_number: 12, comment_id: 9 });
    expect(seen.join("")).toContain(marker("approve:command", 9));
  });

  test("/recheck reruns the automatic path without a receipt", async () => {
    const { ctx, server } = context({ comment: comment({ body: "/recheck", user: mallory }) });
    expect((await runApprove(ctx, { pull_number: 12, comment_id: 9 })).result).toBe("approved");
    expect(server.calls).toContain(`POST ${P}/issues/comments/9/reactions`);
    expect(server.calls).not.toContain(`POST ${P}/issues/12/comments`);
  });

  // Each row: name, setup, error pattern, whether the request got as far as a receipt.
  const rejects: [string, Setup, RegExp, boolean][] = [
    ["an edited comment", { comment: comment({ updated_at: "2026-10-24T11:31:00Z" }) }, /was edited/, false],
    ["an expired comment", { comment: comment({ created_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T10:00:00Z" }) }, /older than 60 minutes/, false],
    ["a comment on another pull request", { comment: comment({ issue_url: `https://api.github.com${P}/issues/13` }) }, /not on owner\/repo#12/, false],
    ["a comment that is not a command", { comment: comment({ body: "LGTM" }) }, /not exactly/, false],
    ["a commenter who is not an approver", { comment: comment({ user: mallory }) }, /mallory is not one of the approvers/, false],
    ["/merge routed to approve", { comment: comment({ body: "/merge" }) }, /is not exactly \/approve/, false],
    ["/approve with an argument", { comment: comment({ body: `/approve ${HEAD}` }) }, /not exactly/, false],
    ["/approve on a draft", { pull: pull({ draft: true }) }, /is a draft/, true],
    ["/approve on an untrusted commit", { commits: [commit(HEAD, { committer: mallory, author: mallory })] }, /cannot proceed because policy checks failed: trusted-committers: .* is by mallory/, true],
    ["/approve on 3000 changed files", { files: Array.from({ length: 3000 }, (_, i) => ({ filename: `safe-${i}.txt` })), config: parseConfig(CONFIG_YAML.replace("  - { type: trusted-committers }", "  - { type: trusted-committers }\n  - { type: sensitive-paths, paths: [], exempt: [] }")) }, /cannot proceed because policy checks failed: sensitive-paths: pull request changes 3000 or more files/, true],
    ["a head dated after the comment", { headDate: "2026-10-24T11:30:01Z" }, /newer than comment 9/, true],
    ["a force-push after the comment", { timeline: [{ event: "head_ref_force_pushed", created_at: "2026-10-24T11:40:00Z" }] }, /force-pushed after comment 9/, true],
    ["an unsigned commit", { commits: [commit(HEAD, { commit: { verification: { verified: false } } })] }, /cannot proceed because policy checks failed: signed-commits: .* is not signed/, true],
    ["a replayed comment", { issueComments: [{ user: { id: SERVER_BOT_ID }, body: `${marker("approve", 9)}\ndone` }] }, /already handled/, false],
    ["a comment edited before approving", { commentAfter: comment({ updated_at: "2026-10-24T11:45:00Z" }) }, /was edited/, true],
    ["/approve edited to /merge before approving", { commentAfter: comment({ body: "/merge" }) }, /is no longer exactly \/approve/, true],
    ["a same-second comment edit", { editNode: { databaseId: 9, lastEditedAt: "2026-10-24T11:30:00Z" } }, /was edited/, false],
    ["missing edit evidence", { editNode: null }, /cannot verify the edit history/, false],
    ["wrong comment edit evidence", { editNode: { databaseId: 10, lastEditedAt: null } }, /cannot verify the edit history/, false],
    ["incomplete edit evidence", { editNode: { databaseId: 9 } }, /cannot verify the edit history/, false],
    ["same-second edit before approving", { editNodeAfter: { databaseId: 9, lastEditedAt: "2026-10-24T11:30:00Z" } }, /was edited/, true],
  ];
  test.each(rejects)("rejects %s", async (_, setup, message, receipt) => {
    const { ctx, server, approver } = context(setup);
    const run = runApprove(ctx, { pull_number: 12, comment_id: 9 });
    await expect(run).rejects.toThrow(message);
    await expect(run).rejects.toThrow(Rejection);
    expect(approver.calls).toEqual([]);
    expect(server.calls.includes(`POST ${P}/issues/12/comments`)).toBe(receipt);
    if (receipt) {
      const body = receiptBody(server);
      expectReceipt(body, "approve");
      const primary = body.split("<sub>")[0];
      expect(primary).toContain("/approve was declined:");
      expect(primary).toMatch(message);
      expect(primary).toContain("Resolve the failure, review the current head, and post a new exact `/approve` comment.");
    }
    // The rocket means accepted: only requests that got as far as a receipt were accepted.
    expect(server.calls.includes(`POST ${P}/issues/comments/9/reactions`)).toBe(receipt);
  });

  test("a force-push before the comment does not block /approve", async () => {
    const { ctx } = context({ timeline: [{ event: "head_ref_force_pushed", created_at: "2026-10-24T11:00:00Z" }, { event: "commented", created_at: "2026-10-24T11:40:00Z" }] });
    expect((await runApprove(ctx, { pull_number: 12, comment_id: 9 })).result).toBe("approved");
  });

  test("an /approve approval is dismissed when the head moves while approving", async () => {
    const { ctx, server, approver } = context({ pullAfter: pull({ head: { sha: NEXT, repo: { full_name: "owner/repo" } } }) });
    expect((await runApprove(ctx, { pull_number: 12, comment_id: 9 })).result).toBe("dismissed");
    expect(approver.calls).toContain(`PUT ${P}/pulls/12/reviews/77/dismissals`);
    const body = receiptBody(server);
    expectReceipt(body, "approve");
    expect(body.split("<sub>")[0]).toContain(`/approve was dismissed because head moved to ${NEXT}. Review the current head and post a new exact \`/approve\` comment.`);
    expect(body).not.toContain("/approve succeeded");
  });
});

describe("what approve sends", () => {
  function recording(base: ReturnType<typeof fakeFetch>, sent: { path: string; body: unknown }[]) {
    return (async (input: Parameters<typeof base>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (init?.body) sent.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return base(input, init);
    }) as typeof globalThis.fetch;
  }

  test("the review approves exactly the checked head and the reaction is a rocket", async () => {
    const sent: { path: string; body: unknown }[] = [];
    const { ctx } = context();
    const approver = fakeFetch([{ method: "POST", path: `${P}/pulls/12/reviews`, body: { id: 77, user: { id: APPROVER_BOT_ID } } }]);
    const server = fakeFetch([
      { method: "GET", path: `${P}/pulls/12`, body: pull() },
      { method: "GET", path: `${P}/pulls/12/commits`, body: [commit(HEAD)] },
      { method: "GET", path: `${P}/pulls/12/reviews`, body: [] },
      { method: "GET", path: `${P}/issues/comments/9`, body: comment({ body: "/recheck" }) },
      { method: "POST", path: "/graphql", body: { data: { node: { databaseId: 9, lastEditedAt: null } } } },
      { method: "POST", path: `${P}/issues/comments/9/reactions`, status: 201, body: {} },
      { method: "GET", path: `${P}/commits/${HEAD}/check-runs`, body: [] },
      { method: "POST", path: `${P}/check-runs`, status: 201, body: { id: 88 } },
    ]);
    await runApprove({ ...ctx, server: github("s", recording(server, sent)), approver: github("a", recording(approver, sent)) }, { pull_number: 12, comment_id: 9 });
    expect(sent).toContainEqual({ path: `${P}/pulls/12/reviews`, body: { event: "APPROVE", commit_id: HEAD, body: "" } });
    expect(sent).toContainEqual({ path: `${P}/issues/comments/9/reactions`, body: { content: "rocket" } });
  });

  const notApprovals: [string, unknown][] = [
    ["a dismissed approval of the head", { user: { id: APPROVER_BOT_ID }, state: "DISMISSED", commit_id: HEAD }],
    ["a person's approval of the head", { user: { id: 10 }, state: "APPROVED", commit_id: HEAD }],
  ];
  test.each(notApprovals)("%s does not count as already approved", async (_, review) => {
    const { ctx, approver } = context({ reviews: [review] });
    expect((await runApprove(ctx, { pull_number: 12 })).result).toBe("approved");
    expect(approver.calls).toEqual([`POST ${P}/pulls/12/reviews`]);
  });

  test("the trust policies hold even when csm-ci.yaml lists none", async () => {
    const { ctx, approver } = context({ commits: [commit(HEAD, { committer: mallory, author: mallory })] });
    const outcome = await runApprove({ ...ctx, config: { ...ctx.config, policies: [] } }, { pull_number: 12 });
    expect(outcome.result).toBe("declined");
    expect(approver.calls).toEqual([]);
  });
});


describe("approval repository policy overrides", () => {
  test.each(["automatic", "/recheck", "/approve"])("%s uses the same effective sensitive paths", async (mode) => {
    const cfg = config();
    cfg.policies = [{ type: "sensitive-paths", paths: ["global/**"], exempt: [] }];
    cfg.repositories = [{ name: "owner/repo", ops: ["approve"], sensitive_paths: { paths: ["local/**"] } }];
    const { ctx, approver } = context({ config: cfg, files: [{ filename: "global/file" }], ...(mode === "/recheck" ? { comment: comment({ body: "/recheck" }) } : {}) });
    expect((await runApprove(ctx, { pull_number: 12, ...(mode === "automatic" ? {} : { comment_id: 9 }) })).result).toBe("approved");
    expect(approver.calls).toContain(`POST ${P}/pulls/12/reviews`);
  });

  test.each(["automatic", "/recheck"])("%s reports an overridden sensitive path rejection", async (mode) => {
    const cfg = config();
    cfg.repositories = [{ name: "owner/repo", ops: ["approve"], sensitive_paths: { paths: ["local/**"] } }];
    const { ctx, approver } = context({ config: cfg, files: [{ filename: "local/file" }], ...(mode === "/recheck" ? { comment: comment({ body: "/recheck" }) } : {}) });
    expect(await runApprove(ctx, { pull_number: 12, ...(mode === "automatic" ? {} : { comment_id: 9 }) })).toEqual({ result: "declined", head: HEAD, problems: ["sensitive-paths: sensitive paths need a trusted approver's /approve: local/file"] });
    expect(approver.calls).toEqual([]);
  });

  test("/approve can supply current trusted command evidence for repository sensitivity", async () => {
    const cfg = config();
    cfg.repositories = [{ name: "owner/repo", ops: ["approve"], sensitive_paths: { paths: ["local/**"], exempt: [] } }];
    const { ctx } = context({ config: cfg, files: [{ filename: "local/file" }] });
    expect((await runApprove(ctx, { pull_number: 12, comment_id: 9 })).result).toBe("approved");
  });

  test.each([
    ["unsigned commit", { commit: { verification: { verified: false } } }, /signed-commits: .*not signed and verified/],
    ["untrusted identity", { committer: mallory, author: mallory }, /trusted-committers: .*mallory/],
  ] satisfies [string, Record<string, unknown>, RegExp][])("repository exemption cannot authorize %s", async (_name, changes, message) => {
    const cfg = config();
    cfg.repositories = [{ name: "owner/repo", ops: ["approve"], sensitive_paths: { paths: ["**"], exempt: [alice, mallory] } }];
    const { ctx, approver } = context({ config: cfg, files: [{ filename: "local/file" }], commits: [commit(HEAD, changes)] });
    const outcome = await runApprove(ctx, { pull_number: 12 });
    expect(outcome.result).toBe("declined");
    expect(outcome.problems.join("; ")).toMatch(message);
    expect(approver.calls).toEqual([]);
  });
});
