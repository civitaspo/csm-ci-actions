import { describe, expect, test } from "bun:test";
import { github } from "../github.ts";
import { fakeFetch } from "../testing.ts";
import type { TrustResult } from "../trust.ts";
import { config } from "../testing.ts";
import type { PolicyContext } from "./index.ts";
import { sensitivePaths } from "./sensitive-paths.ts";

const alice = { id: 10, login: "alice" };
const policy = { type: "sensitive-paths" as const, paths: ["Makefile"], exempt: [{ id: 10, login: "alice" }] };

type Overrides = Pick<Partial<PolicyContext>, "authorId" | "trust" | "commandApproval"> & { reviews?: unknown[]; sourceComment?: unknown; sourceStatus?: number; sourceNode?: unknown; graphqlStatus?: number; lastEditedAt?: string | null };
function context(files: unknown[], extra: Overrides = {}): PolicyContext {
  const sourceComment = { id: 9, body: "/approve", issue_url: "https://api.github.com/repos/owner/repo/issues/1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", user: { id: 10, type: "User" }, node_id: "comment-node" };
  const gh = github("token", fakeFetch([
    { method: "GET", path: "/repos/owner/repo/pulls/1/files", body: files },
    { method: "GET", path: "/repos/owner/repo/pulls/1/reviews", body: extra.reviews ?? [] },
    { method: "GET", path: "/repos/owner/repo/issues/comments/9", ...(extra.sourceStatus === undefined ? {} : { status: extra.sourceStatus }), body: extra.sourceComment ?? sourceComment },
    { method: "POST", path: "/graphql", ...(extra.graphqlStatus === undefined ? {} : { status: extra.graphqlStatus }), body: { data: { node: extra.sourceNode === undefined ? { databaseId: 9, lastEditedAt: extra.lastEditedAt ?? null } : extra.sourceNode } } },
  ]));
  const trust: TrustResult = { head: "head", problems: [], commits: [{ sha: "head", signed: true, identity: { kind: "user", principal: alice }, trusted: true }] };
  return { trust, gh, config: config(), repository: "owner/repo", pullNumber: 1, head: "head", authorId: 10, ...(extra.authorId === undefined ? {} : { authorId: extra.authorId }), ...(extra.trust ? { trust: extra.trust } : {}), ...(extra.commandApproval ? { commandApproval: extra.commandApproval } : {}) };
}

describe("sensitive-paths", () => {
  test.each([
    ["previous filename", [{ filename: "renamed.txt", previous_filename: "Makefile" }]],
  ])("matches %s", async (_, files) => {
    const ctx = context(files, { authorId: 66 });
    expect(await sensitivePaths(policy, ctx)).toHaveLength(1);
    expect((await sensitivePaths(policy, ctx))[0]).toMatch(/sensitive paths need a trusted approver/);
  });

  test("matches wildcard patterns through dot directories", async () => {
    const custom = { ...policy, paths: ["**/hidden.json"] };
    expect(await sensitivePaths(custom, context([{ filename: ".config/hidden.json" }], { authorId: 66 }))).toHaveLength(1);
  });

  test.each([
    ["mixed identities", { commits: [{ ...context([]).trust.commits[0]!, identity: { kind: "user" as const, principal: alice } }, { ...context([]).trust.commits[0]!, sha: "other", identity: { kind: "user" as const, principal: { id: 66, login: "mallory" } } }] }],
    ["no commits", { commits: [] }],
  ])("does not exempt %s", async (_name, trustOverride) => {
    const files = [{ filename: "Makefile" }];
    const trust = { ...context([]).trust, ...trustOverride } as TrustResult;
    expect(await sensitivePaths(policy, context(files, { trust }))).toEqual(["sensitive paths need a trusted approver's /approve: Makefile"]);
  });

  test("allows an exemption only when every commit matches the pull request author", async () => {
    expect(await sensitivePaths(policy, context([{ filename: "Makefile" }]))).toEqual([]);
  });

  test("fails closed at the file listing cap before accepting command evidence", async () => {
    const ctx = context(Array.from({ length: 3000 }, (_, i) => ({ filename: `safe-${i}.txt` })), {
      commandApproval: { commentId: 1, authorId: 10, head: "head" },
    });
    const result = await sensitivePaths(policy, ctx);
    expect(result).toEqual(["pull request changes 3000 or more files; sensitive-paths cannot verify every file"]);
  });

  test("accepts only current reviews with an unedited human source comment on this pull request", async () => {
    const files = [{ filename: "Makefile" }];
    const review = { user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" };
    const valid = context(files, { authorId: 66, reviews: [review] });
    expect(await sensitivePaths(policy, valid)).toEqual([]);
    const rejected: Array<[string, Overrides]> = [
      ["wrong PR", { sourceComment: { ...validSource(), issue_url: "https://api.github.com/repos/owner/repo/issues/2" } }],
      ["bot source user", { sourceComment: { ...validSource(), user: { id: 10, type: "Bot" } } }],
      ["edited source", { sourceComment: { ...validSource(), updated_at: "2026-01-01T00:01:00Z" } }],
      ["wrong reviewer", { reviews: [{ ...review, user: { id: 77 } }] }],
      ["wrong review state", { reviews: [{ ...review, state: "COMMENTED" }] }],
      ["stale head", { reviews: [{ ...review, commit_id: "old" }] }],
      ["edited approval comment", { lastEditedAt: "2026-10-24T11:30:00Z" }],
      ["missing source comment", { sourceStatus: 404 }],
      ["missing source node", { sourceNode: null }],
      ["node id resolves to another comment", { sourceNode: { databaseId: 10, lastEditedAt: null } }],
    ];
    for (const [reason, overrides] of rejected) {
      const problems = await sensitivePaths(policy, context(files, { authorId: 66, reviews: [review], ...overrides }));
      expect(problems, reason).toEqual(["sensitive paths need a trusted approver's /approve: Makefile"]);
    }
  });

  test("propagates non-404 source comment API errors", async () => {
    await expect(sensitivePaths(policy, context([{ filename: "Makefile" }], { authorId: 66, reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }], sourceStatus: 500 }))).rejects.toThrow();
  });

  test("propagates edit-history API errors", async () => {
    await expect(sensitivePaths(policy, context([{ filename: "Makefile" }], { authorId: 66, reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }], graphqlStatus: 500 }))).rejects.toMatchObject({ status: 500 });
  });
});

function validSource() {
  return { id: 9, body: "/approve", issue_url: "https://api.github.com/repos/owner/repo/issues/1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", user: { id: 10, type: "User" }, node_id: "comment-node" };
}
