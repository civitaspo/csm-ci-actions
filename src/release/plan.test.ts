import { describe, expect, test } from "bun:test";
import { github } from "../lib/github.ts";
import { fakeFetch } from "../lib/testing.ts";
import { planRelease, type ReleasePlanInput } from "./plan.ts";

const mergeSha = "0123456789abcdef0123456789abcdef01234567";
const input: ReleasePlanInput = {
  repository: "owner/repo",
  pullNumber: 12,
  serverBotId: 3000,
  release: { build_type: "none" },
};
const repository = { default_branch: "main", private: false };
const pull = {
  merged_at: "2026-10-25T00:00:00Z",
  merged_by: { id: 3000, login: "server[bot]" },
  head: { ref: "release/next", repo: { full_name: "owner/repo" } },
  base: { ref: "main", repo: { full_name: "owner/repo" } },
  merge_commit_sha: mergeSha,
};
const routes = (options: { repository?: unknown; pull?: unknown; version?: unknown; ref?: unknown; tag?: unknown; release?: unknown; releases?: unknown } = {}) => fakeFetch([
  { method: "GET", path: "/repos/owner/repo", body: options.repository ?? repository },
  { method: "GET", path: "/repos/owner/repo/pulls/12", body: options.pull ?? pull },
  { method: "GET", path: `/repos/owner/repo/contents/.release-version`, body: options.version ?? "1.2.3\n" },
  { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", status: options.ref === undefined ? 404 : 200, body: options.ref ?? { message: "Not Found" } },
  { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: options.tag ?? { message: "Not Found" } },
  { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: options.release === undefined ? 404 : 200, body: options.release ?? { message: "Not Found" } },
  { method: "GET", path: "/repos/owner/repo/releases", body: options.releases ?? [] },
]);

describe("planRelease", () => {
  test("validates a release PR and treats a missing tag as work for the write step", async () => {
    const fetch = routes();
    await expect(planRelease(github("t", fetch), input)).resolves.toEqual({
      ...input,
      mergeSha,
      tag: "v1.2.3",
      version: "1.2.3",
      serverBotLogin: "server[bot]",
      privateRepository: false,
      makeLatest: true,
      prerelease: false,
    });
  });

  const rejects: [string, unknown, unknown, RegExp][] = [
    ["unmerged PR", undefined, { ...pull, merged_at: null }, /is not merged/],
    ["wrong merger", undefined, { ...pull, merged_by: { id: 5, login: "alice" } }, /not merged by the Server bot/],
    ["fork head", undefined, { ...pull, head: { ...pull.head, repo: { full_name: "attacker/repo" } } }, /head repository is not the managed repository/],
    ["wrong head branch", undefined, { ...pull, head: { ...pull.head, ref: "main" } }, /not release\/next/],
    ["wrong base", undefined, { ...pull, base: { ...pull.base, ref: "release/next" } }, /not the default branch/],
    ["missing merge commit", undefined, { ...pull, merge_commit_sha: null }, /has no merge commit/],
    ["invalid version", "v1.2.3", pull, /is not semver/],
    ["foreign release", undefined, pull, /release v1.2.3 already exists and was not created by the Server bot/],
  ];
  test.each(rejects)("rejects %s", async (name, version, pullValue, message) => {
    const release = name === "foreign release" ? { tag_name: "v1.2.3", author: { id: 4000 } } : undefined;
    await expect(planRelease(github("t", routes({ version, pull: pullValue, release })), input)).rejects.toThrow(message);
  });

  test("rejects an existing tag from another identity even when it points to the merge commit", async () => {
    const fetch = routes({
      ref: { object: { type: "tag", sha: "tag-sha" } },
      tag: { tag: "v1.2.3", tagger: { name: "alice", email: "alice@example.com" }, object: { type: "commit", sha: mergeSha } },
    });
    await expect(planRelease(github("t", fetch), input)).rejects.toThrow("tag v1.2.3 was not created by the Server bot");
  });

  test("rejects a server-made tag that points to another commit", async () => {
    const fetch = routes({
      ref: { object: { type: "tag", sha: "tag-sha" } },
      tag: { tag: "v1.2.3", tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" }, object: { type: "commit", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    await expect(planRelease(github("t", fetch), input)).rejects.toThrow("tag v1.2.3 points to a different commit");
  });

  test("propagates API failures that do not mean a missing tag or release", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo", body: repository },
      { method: "GET", path: "/repos/owner/repo/pulls/12", body: pull },
      { method: "GET", path: "/repos/owner/repo/contents/.release-version", body: "1.2.3\n" },
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", status: 500, body: { message: "server error" } },
    ]);
    await expect(planRelease(github("t", fetch), input)).rejects.toThrow("server error");
  });
});
