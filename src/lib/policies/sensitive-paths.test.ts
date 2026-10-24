import { describe, expect, test } from "bun:test";
import { github } from "../github.ts";
import { fakeFetch } from "../testing.ts";
import type { TrustResult } from "../trust.ts";
import { config } from "../testing.ts";
import { sensitivePaths } from "./sensitive-paths.ts";

const alice = { id: 10, login: "alice" };
const policy = { type: "sensitive-paths" as const, paths: [], exempt: [{ id: 10, login: "alice" }] };

function context(files: unknown[], extra: Record<string, unknown> = {}) {
  const sourceComment = { id: 9, body: "/approve", user: { id: 10 }, node_id: "comment-node" };
  const gh = github("token", fakeFetch([
    { method: "GET", path: "/repos/owner/repo/pulls/1/files", body: files },
    { method: "GET", path: "/repos/owner/repo/pulls/1/reviews", body: (extra.reviews as unknown[]) ?? [] },
    { method: "GET", path: "/repos/owner/repo/issues/comments/9", body: (extra.sourceComment as unknown) ?? sourceComment },
    { method: "POST", path: "/graphql", body: { data: { node: { lastEditedAt: (extra.lastEditedAt as string | null | undefined) ?? null } } } },
  ]));
  const trust: TrustResult = { head: "head", problems: [], commits: [{ sha: "head", signed: true, identity: { kind: "user", principal: alice }, trusted: true }] };
  return { trust, gh, config: config(), repository: "owner/repo", pullNumber: 1, head: "head", authorId: 10, ...extra };
}

describe("sensitive-paths", () => {
  test.each([
    ["previous filename", [{ filename: "renamed.txt", previous_filename: "Makefile" }]],
  ])("matches %s", async (_, files) => {
    const ctx = context(files, { authorId: 66 });
    expect(await sensitivePaths(policy, ctx as never)).toHaveLength(1);
    expect((await sensitivePaths(policy, ctx as never))[0]).toMatch(/sensitive paths need a trusted approver/);
  });

  test("matches wildcard patterns through dot directories", async () => {
    const custom = { ...policy, paths: ["**/hidden.json"] };
    expect(await sensitivePaths(custom, context([{ filename: ".config/hidden.json" }], { authorId: 66 }) as never)).toHaveLength(1);
  });

  test("exempts only when every commit matches the pull request author", async () => {
    const files = [{ filename: "Makefile" }];
    const same = context(files);
    expect(await sensitivePaths(policy, same as never)).toEqual([]);
    const mixedTrust = { ...same, trust: { ...same.trust, commits: [...same.trust.commits, { ...same.trust.commits[0]!, sha: "other", identity: { kind: "user" as const, principal: { id: 66, login: "mallory" } } }] } };
    expect(await sensitivePaths(policy, mixedTrust as never)).toHaveLength(1);
  });

  test("fails closed at the file listing cap before accepting command evidence", async () => {
    const ctx = context(Array.from({ length: 3000 }, (_, i) => ({ filename: `safe-${i}.txt` })), {
      commandApproval: { commentId: 1, authorId: 10, head: "head" },
    });
    const result = await sensitivePaths(policy, ctx as never);
    expect(result).toEqual(["pull request changes 3000 or more files; sensitive-paths cannot verify every file"]);
  });

  test("accepts only a current approval review linked to a trusted source comment", async () => {
    const files = [{ filename: "Makefile" }];
    const valid = context(files, { authorId: 66, reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }] });
    expect(await sensitivePaths(policy, valid as never)).toEqual([]);
    const invalids = [
      [{ user: { id: 66 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }],
      [{ user: { id: 4000 }, state: "COMMENTED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }],
      [{ user: { id: 4000 }, state: "APPROVED", commit_id: "old", body: "<!-- csm-ci:approve:command:9 -->" }],
    ];
    for (const reviews of invalids) {
      const problems = await sensitivePaths(policy, context(files, { authorId: 66, reviews }) as never);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/sensitive paths need a trusted approver/);
    }
    const fakeAuthor = context(files, { authorId: 66, reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }], sourceComment: { id: 9, body: "/approve", user: { id: 66 } } });
    expect(await sensitivePaths(policy, fakeAuthor as never)).toEqual(["sensitive paths need a trusted approver's /approve: Makefile"]);
    const edited = context(files, { authorId: 66, reviews: [{ user: { id: 4000 }, state: "APPROVED", commit_id: "head", body: "<!-- csm-ci:approve:command:9 -->" }], lastEditedAt: "2026-10-24T11:30:00Z" });
    expect(await sensitivePaths(policy, edited as never)).toEqual(["sensitive paths need a trusted approver's /approve: Makefile"]);
  });
});
