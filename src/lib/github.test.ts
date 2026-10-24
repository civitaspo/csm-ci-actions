import { describe, expect, test } from "bun:test";
import { github, loadConfig, splitRepository, verifyLiveLabel } from "./github.ts";
import { hasServerMarker, marker } from "./notify.ts";
import { CONFIG_YAML, fakeFetch, SERVER_BOT_ID } from "./testing.ts";
import { fetchCommitFacts } from "./trust.ts";

describe("splitRepository", () => {
  test.each(["owner", "owner/repo/extra", "/repo", "owner/"])("rejects %s", (name) => {
    expect(() => splitRepository(name)).toThrow(/is not owner\/repo/);
  });
});

describe("loadConfig", () => {
  test("reads the file at the given ref", async () => {
    const fetch = fakeFetch([{ method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML }]);
    const c = await loadConfig(github("t", fetch), "owner/server", "abc", "csm-ci.yaml");
    expect(c.server_repository).toBe("owner/server");
  });
});

describe("verifyLiveLabel", () => {
  const path = "/repos/owner/server/labels/csm-ci-approve-a";
  const cases: [string, number, unknown, RegExp | null][] = [
    ["label unchanged", 200, { name: "csm-ci-approve-a", description: "owner/repo/1" }, null],
    ["label deleted", 404, { message: "Not Found" }, /no longer exists/],
    ["description edited", 200, { name: "csm-ci-approve-a", description: "owner/repo/2" }, /description changed/],
    ["description removed", 200, { name: "csm-ci-approve-a", description: null }, /description changed/],
  ];
  test.each(cases)("%s", async (_, status, body, message) => {
    const gh = github("t", fakeFetch([{ method: "GET", path, status, body }]));
    const run = verifyLiveLabel(gh, "owner/server", "csm-ci-approve-a", "owner/repo/1");
    if (message) await expect(run).rejects.toThrow(message);
    else await expect(run).resolves.toBeUndefined();
  });

  test("other API errors are not turned into rejections", async () => {
    const gh = github("t", fakeFetch([{ method: "GET", path, status: 500, body: { message: "boom" } }]));
    await expect(verifyLiveLabel(gh, "owner/server", "csm-ci-approve-a", "owner/repo/1")).rejects.toThrow(/boom/);
  });
});

describe("fetchCommitFacts", () => {
  const sha = (c: string) => c.repeat(40);
  test("adds GraphQL facts only for web-flow commits", async () => {
    const fetch = fakeFetch([
      {
        method: "GET",
        path: "/repos/owner/repo/pulls/3/commits",
        body: [
          { sha: sha("a"), commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } },
          { sha: sha("b"), commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 1, login: "web-flow" } },
        ],
      },
      {
        method: "POST",
        path: "/graphql",
        body: { data: { repository: { c0: { committedViaWeb: true, signature: { isValid: true, wasSignedByGitHub: true }, author: { user: { login: "alice" } } } } } },
      },
    ]);
    const facts = await fetchCommitFacts(github("t", fetch), "owner/repo", 3);
    expect(facts[0]?.web).toBeUndefined();
    expect(facts[1]?.web).toEqual({ committedViaWeb: true, signatureValid: true, signedByGitHub: true, authorLogin: "alice" });
    expect(fetch.calls).toEqual(["GET /repos/owner/repo/pulls/3/commits", "POST /graphql"]);
  });

  test("a missing GraphQL node leaves every web fact false", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/pulls/3/commits", body: [{ sha: sha("b"), commit: { verification: { verified: true } }, author: null, committer: { id: 1, login: "web-flow" } }] },
      { method: "POST", path: "/graphql", body: { data: { repository: { c0: null } } } },
    ]);
    const [fact] = await fetchCommitFacts(github("t", fetch), "owner/repo", 3);
    expect(fact?.web).toEqual({ committedViaWeb: false, signatureValid: false, signedByGitHub: false, authorLogin: null });
  });

  test("refuses a sha that is not 40 hex characters before building the GraphQL query", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/pulls/3/commits", body: [{ sha: 'x") { id } }', commit: { verification: { verified: true } }, author: null, committer: { id: 1, login: "web-flow" } }] },
    ]);
    await expect(fetchCommitFacts(github("t", fetch), "owner/repo", 3)).rejects.toThrow(/not 40 hex/);
    expect(fetch.calls).toEqual(["GET /repos/owner/repo/pulls/3/commits"]);
  });

  test("skips GraphQL when no commit is web-flow", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/pulls/3/commits", body: [{ sha: sha("a"), commit: { verification: { verified: false } }, author: null, committer: null }] },
    ]);
    const facts = await fetchCommitFacts(github("t", fetch), "owner/repo", 3);
    expect(facts).toEqual([{ sha: sha("a"), verified: false, author: null, committer: null }]);
    expect(fetch.calls).toEqual(["GET /repos/owner/repo/pulls/3/commits"]);
  });
});

describe("hasServerMarker", () => {
  const m = marker("merge", 42);
  const cases: [string, { user: { id: number } | null; body: string | null }[], boolean][] = [
    ["server bot comment with marker", [{ user: { id: SERVER_BOT_ID }, body: `${m}\nmerged` }], true],
    ["marker pasted by someone else", [{ user: { id: 10 }, body: m }], false],
    ["server comment for another request", [{ user: { id: SERVER_BOT_ID }, body: marker("merge", 43) }], false],
    ["deleted user", [{ user: null, body: m }], false],
    ["empty body", [{ user: { id: SERVER_BOT_ID }, body: null }], false],
  ];
  test.each(cases)("%s", (_, comments, expected) => {
    expect(hasServerMarker(comments, m, SERVER_BOT_ID)).toBe(expected);
  });
});
