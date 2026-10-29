import { describe, expect, test } from "bun:test";
import { acceptMerge, evaluateReservation, mergeReservation, type MergeContext } from "./merge.ts";
import { github } from "./github.ts";
import { marker } from "./notify.ts";
import { config, fakeFetch } from "./testing.ts";

const P = "/repos/owner/repo";
const now = new Date("2026-10-24T11:30:01Z");
const sha = "a".repeat(40);
const nextSha = "b".repeat(40);

function pull() {
  return { number: 12, state: "open", merged: false, merged_by: null, merge_commit_sha: null, draft: false, node_id: "PR_node", title: "Example (#12)", body: "Description", user: { id: 10, login: "alice", type: "User" }, head: { sha, repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { id: 123, full_name: "owner/repo", default_branch: "main" } } };
}

function setup(body: string, author = { id: 10, login: "alice", type: "User" }, activeReservation = false, options: { pull?: Record<string, unknown>; pullThen?: unknown[]; commentId?: number; editedAt?: string | null; payload?: Record<string, unknown>; headDate?: string; timeline?: unknown[]; reviews?: unknown[]; reviewsThen?: unknown[]; checks?: unknown[]; checksThen?: unknown[]; commits?: unknown[]; legacyReceipt?: "server" | "forged"; statuses?: unknown[] } = {}) {
  const comment = { id: 9, node_id: "IC_node", body, issue_url: "https://api.github.com/repos/owner/repo/issues/12", created_at: "2026-10-24T11:30:00Z", updated_at: "2026-10-24T11:30:00Z", user: author };
  const payload = { version: 1, repository_id: 123, repository: "owner/repo", pull_number: 12, pull_node_id: "PR_node", base_ref: "main", merger: { id: 10, login: "alice", type: "User" }, mode: "human", command_comment_id: options.commentId ?? 88, accepted_head: sha, accepted_at: "2026-10-20T00:00:00.000Z", expires_at: "2026-10-27T00:00:00.000Z", ...options.payload };
  const deploymentNodes = activeReservation ? [{ id: "D_node", databaseId: 77, task: "csm-ci:automerge", payload, createdAt: "2026-10-20T00:00:00Z", creator: { __typename: "Bot", databaseId: 3000 } }] : [];
  const emptyDeployments = { data: { node: { databaseId: 9, lastEditedAt: options.editedAt ?? null }, repository: { deployments: { nodes: deploymentNodes, pageInfo: { hasNextPage: false, endCursor: null } }, pullRequest: { id: "PR_node", autoMergeRequest: null } } } };
  const serverFetch = fakeFetch([
    { method: "GET", path: `${P}/pulls/12`, body: { ...pull(), ...options.pull }, ...(options.pullThen ? { then: options.pullThen } : {}) },
    { method: "GET", path: "/repositories/123", body: { id: 123, full_name: "owner/repo" } },
    { method: "GET", path: `${P}/issues/comments/9`, body: comment },
    { method: "GET", path: `${P}/issues/12/comments`, body: options.legacyReceipt ? [{ user: { id: options.legacyReceipt === "server" ? 3000 : 99, type: "Bot" }, body: marker("merge", 9) }] : [] },
    { method: "POST", path: "/graphql", body: emptyDeployments },
    { method: "GET", path: `${P}/commits/${sha}`, body: { sha, commit: { committer: { date: options.headDate ?? "2026-10-24T11:00:00Z" } } } },
    { method: "GET", path: `${P}/issues/12/timeline`, body: options.timeline ?? [] },
    { method: "GET", path: `${P}/pulls/12/commits`, body: options.commits ?? [{ sha, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }] },
    { method: "GET", path: `${P}/pulls/12/reviews`, body: options.reviews ?? [{ id: 4, user: { id: 4000 }, state: "APPROVED", commit_id: sha, submitted_at: "2026-10-24T11:20:00Z" }], ...(options.reviewsThen ? { then: options.reviewsThen } : {}) },
    { method: "GET", path: `${P}/commits/${sha}/check-runs`, body: options.checks ?? [{ id: 7, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }], ...(options.checksThen ? { then: options.checksThen } : {}) },
  ]);
  const notifyFetch = fakeFetch([
    { method: "POST", path: `${P}/issues/comments/9/reactions`, status: 201, body: { id: 1 } },
    { method: "GET", path: `${P}/issues/12/comments`, body: [] },
    { method: "POST", path: `${P}/issues/12/comments`, status: 201, body: { id: 90 } },
    { method: "GET", path: `${P}/issues/12/labels`, body: [] },
    { method: "POST", path: `${P}/issues/12/labels`, status: 200, body: [{ name: "csm-ci/automerge" }] },
  ]);
  const deploymentsFetch = fakeFetch([
    { method: "POST", path: "/graphql", body: emptyDeployments },
    { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
    { method: "POST", path: "/repos/owner/server/deployments", status: 201, body: { id: 77, node_id: "D_node", task: "csm-ci:automerge", creator: { id: 3000, type: "Bot" }, created_at: "2026-10-24T11:30:00Z" } },
    { method: "GET", path: "/repos/owner/server/deployments/77/statuses", body: options.statuses ?? [] },
    { method: "POST", path: "/repos/owner/server/deployments/77/statuses", status: 201, body: { id: 99 } },
  ]);
  const configValue = config();
  const ctx: MergeContext = {
    server: github("server", serverFetch), deployments: github("deployments", deploymentsFetch), notify: github("notify", notifyFetch),
    config: configValue, reloadConfig: async () => configValue, repository: "owner/repo", serverRepository: "owner/server",
    serverRun: { serverUrl: "https://github.com", repository: "owner/server", id: "1", attempt: "1" }, now: () => now,
  };
  return { ctx, serverFetch, notifyFetch, deploymentsFetch, payload };
}

describe("acceptMerge", () => {
  test("accepts /merge into a deployment and posts its durable receipt", async () => {
    const { ctx, deploymentsFetch, notifyFetch } = setup("/merge");
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toMatchObject({ kind: "accepted", reservation: { deploymentId: 77 } });
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments");
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments/77/statuses");
    expect(notifyFetch.calls).toContain("POST /repos/owner/repo/issues/12/comments");
  });

  test("replays the same command after a head change without applying the old-head freshness rule", async () => {
    const { ctx, serverFetch, notifyFetch } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, { commentId: 9, pull: { head: { sha: nextSha, repo: { full_name: "owner/repo" } } }, payload: { merger: { id: 10, login: "alice", type: "User" } } });
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toMatchObject({ kind: "replay", reservation: { deploymentId: 77 } });
    expect(serverFetch.calls).not.toContain(`GET ${P}/commits/${sha}`);
    expect(notifyFetch.calls).toContain(`POST ${P}/issues/12/comments`);
  });

  test("rejects an existing legacy Server Bot receipt before creating a new reservation", async () => {
    const { ctx, deploymentsFetch } = setup("/merge", { id: 10, login: "alice", type: "User" }, false, { legacyReceipt: "server" });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("comment 9 was already handled");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test("ignores a forged legacy receipt marker from another account", async () => {
    const { ctx, deploymentsFetch } = setup("/merge", { id: 10, login: "alice", type: "User" }, false, { legacyReceipt: "forged" });
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toMatchObject({ kind: "accepted" });
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments");
  });

  test("routes cancellation from the refetched comment body and receipts a no-op", async () => {
    const { ctx, serverFetch, notifyFetch } = setup("/merge cancel");
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toEqual({ kind: "cancel-noop" });
    expect(serverFetch.calls).toContain("GET /repos/owner/repo/issues/comments/9");
    expect(notifyFetch.calls).toContain("POST /repos/owner/repo/issues/comments/9/reactions");
  });

  test("an unauthorized no-op cancellation receives no reaction or receipt", async () => {
    const { ctx, notifyFetch } = setup("/merge cancel", { id: 99, login: "stranger", type: "User" });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("stranger is not one of the mergers");
    expect(notifyFetch.calls).toEqual([]);
  });

  test.each([
    ["comment body is not a command", "hello", /not exactly/],
    ["different command", "/approve", /comment 9 is not \/merge/],
  ])("rejects invalid command evidence: %s", async (_name, body, expected) => {
    const { ctx } = setup(body);
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(expected);
  });

  test("requires merge to remain enabled in the refreshed configuration", async () => {
    const { ctx, deploymentsFetch } = setup("/merge");
    ctx.reloadConfig = async () => ({ ...ctx.config, repositories: [] });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("repository owner/repo no longer enables merge");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test("rejects Bot requests disabled for this repository", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, deploymentsFetch } = setup("/merge", bot, false, { pull: { user: bot } });
    ctx.config.repositories = [{ name: "owner/repo", ops: ["merge"], merge: { allow_bot_requests: false } }];
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("bot merge requests are disabled for repository owner/repo");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test("rejects a second active reservation for the same pull request", async () => {
    const { ctx, deploymentsFetch } = setup("/merge", { id: 10, login: "alice", type: "User" }, true);
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("pull request #12 already has an active merge reservation");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test.each([
    ["untrusted merger", { author: { id: 99, login: "stranger", type: "User" } }, /stranger is not one of the mergers/],
    ["unsupported account type", { author: { id: 99, login: "team", type: "Organization" } }, /unsupported account type Organization/],
    ["draft pull request", { pull: { draft: true } }, /#12 is a draft/],
    ["fork pull request", { pull: { head: { sha, repo: { full_name: "fork/repo" } } } }, /comes from a fork/],
    ["non-default base", { pull: { base: { ref: "release", repo: { id: 123, full_name: "owner/repo", default_branch: "main" } } } }, /targets release, not the default branch/],
    ["head newer than command", { headDate: "2026-10-24T11:31:00Z" }, /head .* is newer than comment/],
    ["force-push after command", { timeline: [{ event: "head_ref_force_pushed", created_at: "2026-10-24T11:30:00Z" }] }, /was force-pushed after comment/],
    ["edited command", { editedAt: "2026-10-24T11:30:01Z" }, /was edited/],
  ] as const)("rejects %s before creating a reservation", async (_name, options, expected) => {
    const author = "author" in options ? options.author : undefined;
    const setupOptions = "author" in options ? {} : options;
    const { ctx, deploymentsFetch } = setup("/merge", author, false, setupOptions);
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(expected);
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test("accepts a Bot request only when the trusted Bot owns the pull request and each commit", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, deploymentsFetch } = setup("/merge", bot, false, {
      pull: { user: bot },
      commits: [{ sha, commit: { verification: { verified: true } }, author: bot, committer: bot }],
    });
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toMatchObject({ kind: "accepted", reservation: { payload: { mode: "bot", merger: { id: 20 } } } });
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments");
  });

  test("rejects a Bot merger whose commit is owned by another account", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, deploymentsFetch } = setup("/merge", bot, false, {
      pull: { user: bot },
      commits: [{ sha, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }],
    });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("can merge only its own pull request and commits");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments");
  });

  test("allows the original User reserver to cancel without global merger trust", async () => {
    const { ctx, notifyFetch, deploymentsFetch } = setup("/merge cancel", { id: 20, login: "original", type: "User" }, true, { payload: { merger: { id: 20, login: "original", type: "User" } } });
    ctx.config.trust.mergers = [];
    expect(await acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).toMatchObject({ kind: "cancelled", reservation: { deploymentId: 77 } });
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments/77/statuses");
    expect(notifyFetch.calls).toContain("POST /repos/owner/repo/issues/comments/9/reactions");
  });

  test.each([
    ["unrelated User", { id: 99, login: "stranger", type: "User" }, { merged: false }, "stranger cannot cancel this merge reservation"],
    ["reservation owner after merge", { id: 10, login: "alice", type: "User" }, { merged: true }, "pull request #12 has already merged"],
  ] as const)("rejects cancellation by %s", async (_case, author, pullUpdate, message) => {
    const { ctx, deploymentsFetch } = setup("/merge cancel", author, true, { pull: pullUpdate });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow(message);
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments/77/statuses");
  });

  test("rejects cancellation explicitly when the reserved pull is already merged", async () => {
    const { ctx, deploymentsFetch, notifyFetch } = setup("/merge cancel", { id: 10, login: "alice", type: "User" }, true, { pull: { merged: true, state: "closed" } });
    await expect(acceptMerge(ctx, { pull_number: 12, comment_id: 9 })).rejects.toThrow("pull request #12 has already merged");
    expect(deploymentsFetch.calls).not.toContain("POST /repos/owner/server/deployments/77/statuses");
    expect(notifyFetch.calls).toEqual([]);
  });
});

describe("evaluateReservation", () => {
  test("expires an overdue Bot reservation without reading Bot commits", async () => {
    const bot = { id: 20, login: "renovate[bot]", type: "Bot" };
    const { ctx, serverFetch, deploymentsFetch, payload } = setup("/merge", bot, true, {
      pull: { user: bot },
      payload: { mode: "bot", merger: bot, accepted_at: "2026-10-15T00:00:00.000Z", expires_at: "2026-10-22T00:00:00.000Z" },
    });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "terminal", state: "inactive", description: "expired", comment: "complete" });
    expect(serverFetch.calls).not.toContain(`GET ${P}/pulls/12/commits`);
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments/77/statuses");
  });

  test("keeps an active reservation queued while the current head lacks approval", async () => {
    const { ctx, deploymentsFetch, notifyFetch, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, { reviews: [] });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "wait", reason: `waiting for approval of ${sha.slice(0, 7)}` });
    expect(result.ready).toBe(false);
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments/77/statuses");
    expect(notifyFetch.calls).toContain(`POST ${P}/issues/12/comments`);
  });

  test.each([
    ["approval for an older head", { reviews: [{ id: 5, user: { id: 4000 }, state: "APPROVED", commit_id: nextSha, submitted_at: "2026-10-24T11:20:00Z" }] }, "waiting for approval of aaaaaaa"],
    ["required check from an untrusted producer", { checks: [{ id: 7, name: "status-check", app: { id: 999 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" }] }, "waiting for check status-check from app 15368 is not success or skipped"],
    ["latest required check failure", { checks: [
      { id: 7, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" },
      { id: 8, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "failure", started_at: "2026-10-24T11:11:00Z" },
    ] }, "waiting for check status-check from app 15368 is not success or skipped"],
  ] as const)("keeps readiness waiting for %s", async (_case, options, reason) => {
    const { ctx, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, options as unknown as Parameters<typeof setup>[3]);
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "wait", reason });
  });

  test("invalidates a reservation when current configuration removes merge", async () => {
    const { ctx, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true);
    ctx.reloadConfig = async () => ({ ...ctx.config, repositories: [] });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "terminal", state: "inactive", description: "merge is disabled", comment: "complete" });
  });

  test("does not add a result comment for an external merge, including on later sweeps", async () => {
    const externalStatus = { id: 98, state: "success", description: "merged outside csm-ci", created_at: "2026-10-24T11:00:00Z", creator: { id: 3000, type: "Bot" } };
    const { ctx, notifyFetch, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, {
      pull: { state: "closed", merged: true }, statuses: [externalStatus],
    });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "terminal", state: "success", comment: "none" });
    expect(notifyFetch.calls).not.toContain(`POST ${P}/issues/12/comments`);
  });

  test("does not add a result comment for an already-terminal closed pull request", async () => {
    const closedStatus = { id: 98, state: "inactive", description: "pull request closed", created_at: "2026-10-24T11:00:00Z", creator: { id: 3000, type: "Bot" } };
    const { ctx, notifyFetch, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, {
      pull: { state: "closed" }, statuses: [closedStatus],
    });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    const result = await evaluateReservation(ctx, record);
    expect(result.decision).toMatchObject({ kind: "terminal", state: "inactive", description: "pull request closed", comment: "none" });
    expect(notifyFetch.calls).not.toContain(`POST ${P}/issues/12/comments`);
  });

  test.each([
    ["repository ID", { base: { ref: "main", repo: { id: 999, full_name: "owner/repo", default_branch: "main" } } }],
    ["pull node ID", { node_id: "different-node" }],
  ])("rejects changed immutable %s identity", async (_label, pullUpdate) => {
    const { ctx, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, { pull: pullUpdate });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    await expect(evaluateReservation(ctx, record)).rejects.toThrow("reservation repository or pull request identity changed");
  });

  test("rejects a reservation missing from current server state", async () => {
    const { ctx, payload } = setup("/merge", { id: 10, login: "alice", type: "User" });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    await expect(evaluateReservation(ctx, record)).rejects.toThrow("merge reservation no longer exists");
  });
});

describe("mergeReservation", () => {
  function readyReservation(options: Parameters<typeof setup>[3] = {}) {
    const { ctx, deploymentsFetch, serverFetch, payload } = setup("/merge", { id: 10, login: "alice", type: "User" }, true, {
      ...options,
      commentId: 9,
      payload: { merger: { id: 10, login: "alice", type: "User" }, ...(options.payload ?? {}) },
    });
    const record = { deploymentId: 77, nodeId: "D_node", createdAt: "2026-10-20T00:00:00Z", payload: payload as never, statuses: [], state: { kind: "active" as const } };
    return { ctx, deploymentsFetch, serverFetch, record };
  }

  test("final revalidation passes current approval, policy and required check before squash merge", async () => {
    const { ctx, deploymentsFetch, record } = readyReservation();
    const writeFetch = fakeFetch([{ method: "PUT", path: `${P}/pulls/12/merge`, status: 200, body: { merged: true, sha: "c".repeat(40) } }]);
    ctx.write = github("write", writeFetch);
    expect(await mergeReservation(ctx, record, sha)).toEqual({ result: "merged", head: sha, mergeCommit: "c".repeat(40) });
    expect(writeFetch.calls).toEqual([`PUT ${P}/pulls/12/merge`]);
    expect(deploymentsFetch.calls).toContain("POST /repos/owner/server/deployments/77/statuses");
  });

  test("fails HTTP 409 without retrying the protected merge write", async () => {
    const { ctx, record } = readyReservation();
    const writeFetch = fakeFetch([{ method: "PUT", path: `${P}/pulls/12/merge`, status: 409, body: { message: "Conflict" } }]);
    ctx.write = github("write", writeFetch);
    await expect(mergeReservation(ctx, record, sha)).rejects.toThrow("base changed");
    expect(writeFetch.calls).toEqual([`PUT ${P}/pulls/12/merge`]);
  });

  test.each([
    ["not ready", { reviews: [] }, sha, "merge readiness changed before the final write"],
    ["different head", { pull: { head: { sha: nextSha, repo: { full_name: "owner/repo" } } } }, sha, "merge readiness changed before the final write"],
  ] as const)("rejects the final write when readiness is %s", async (_case, options, expectedHead, message) => {
    const { ctx, record } = readyReservation(options as unknown as Parameters<typeof setup>[3]);
    const writeFetch = fakeFetch([{ method: "PUT", path: `${P}/pulls/12/merge`, status: 200, body: { merged: true, sha: "c".repeat(40) } }]);
    ctx.write = github("write", writeFetch);
    await expect(mergeReservation(ctx, record, expectedHead)).rejects.toThrow(message);
    expect(writeFetch.calls).toEqual([]);
  });

  test("revalidates after disabling auto-merge and refuses a moved head", async () => {
    const changed = { ...pull(), head: { sha: nextSha, repo: { full_name: "owner/repo" } } };
    const { ctx, record } = readyReservation({ pullThen: [pull(), changed] });
    const writeFetch = fakeFetch([{ method: "PUT", path: `${P}/pulls/12/merge`, status: 200, body: { merged: true, sha: "c".repeat(40) } }]);
    ctx.write = github("write", writeFetch);
    await expect(mergeReservation(ctx, record, sha)).rejects.toThrow("merge readiness changed after disabling auto-merge");
    expect(writeFetch.calls).toEqual([]);
  });

  test("revalidates readiness before retrying a retryable merge response", async () => {
    const successCheck = { id: 7, name: "status-check", app: { id: 15368 }, status: "completed", conclusion: "success", started_at: "2026-10-24T11:10:00Z" };
    const failedCheck = { ...successCheck, id: 8, conclusion: "failure", started_at: "2026-10-24T11:11:00Z" };
    const { ctx, record } = readyReservation({ checks: [successCheck], checksThen: [[successCheck], [failedCheck]] });
    const writeFetch = fakeFetch([{ method: "PUT", path: `${P}/pulls/12/merge`, status: 405, body: { message: "not mergeable" } }]);
    ctx.write = github("write", writeFetch);
    await expect(mergeReservation(ctx, record, sha)).rejects.toThrow("merge readiness changed before retry");
    expect(writeFetch.calls).toEqual([`PUT ${P}/pulls/12/merge`]);
  });

  test("reconciles an ambiguous merge response from GitHub state without a second merge write", async () => {
    const merged = { ...pull(), state: "closed", merged: true, merge_commit_sha: "c".repeat(40) };
    const { ctx, serverFetch, record } = readyReservation({ pullThen: [pull(), pull(), pull(), merged] });
    let mergeWrites = 0;
    const writeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === `${P}/pulls/12/merge`) {
        mergeWrites += 1;
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    ctx.write = github("write", writeFetch);
    expect(await mergeReservation(ctx, record, sha)).toEqual({ result: "merged", head: sha, mergeCommit: "c".repeat(40) });
    expect(mergeWrites).toBe(1);
    expect(serverFetch.calls.filter((call) => call === `GET ${P}/pulls/12`)).toHaveLength(6);
  });
});
