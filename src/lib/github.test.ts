import { describe, expect, test } from "bun:test";
import { type GitHub, github, loadConfig, loadCurrentServerConfig, splitRepository, verifyLiveLabel } from "./github.ts";
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

describe("loadCurrentServerConfig", () => {
  test("reads the current default-branch config only when it identifies this server", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
      { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML },
    ]);
    await expect(loadCurrentServerConfig(github("t", fetch), "owner/server", "csm-ci.yaml"))
      .resolves.toMatchObject({ server_repository: "owner/server" });

    const mismatch = fakeFetch([
      { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
      { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML.replace("Owner/Server", "Owner/Other") },
    ]);
    await expect(loadCurrentServerConfig(github("t", mismatch), "owner/server", "csm-ci.yaml"))
      .rejects.toThrow(/current server configuration identifies owner\/other, not owner\/server/);
  });
});

describe("github request retries", () => {
  const path = "/repos/owner/repo/commits/main";
  test.each([502, 503, 504])("retries HTTP %i and succeeds", async (status) => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return Response.json(calls === 1 ? { message: "unavailable" } : { sha: "ok" }, { status: calls === 1 ? status : 200 });
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 100, backoffMs: [0] }).request(`GET ${path}`)).resolves.toMatchObject({ data: { sha: "ok" } });
    expect(calls).toBe(2);
  });

  test.each([400, 401, 403, 404, 409, 422, 500])("does not retry HTTP %i", async (status) => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return Response.json({ message: "rejected" }, { status });
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 100, backoffMs: [0, 0] }).request(`GET ${path}`)).rejects.toThrow("rejected");
    expect(calls).toBe(1);
  });
  test("retries a network failure", async () => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      if (calls === 1) throw new TypeError("network disconnected");
      return Response.json({ sha: "ok" });
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 100, backoffMs: [0] }).request(`GET ${path}`)).resolves.toMatchObject({ data: { sha: "ok" } });
    expect(calls).toBe(2);
  });

  test("times out a stalled body and retries the whole read", async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (init?.signal) signals.push(init.signal);
      if (calls > 1) return Response.json({ sha: "ok" });
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
    }, { preconnect: () => undefined });
    const gh = github("t", fetch, { timeoutMs: 10, backoffMs: [0] });
    await expect(gh.request(`GET ${path}`)).resolves.toMatchObject({ data: { sha: "ok" } });
    expect(calls).toBe(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test("preserves the final retryable error after the attempt limit", async () => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return Response.json({ message: `failure ${calls}` }, { status: 502 });
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 100, backoffMs: [0, 0] }).request(`GET ${path}`)).rejects.toThrow(/failure 3/);
    expect(calls).toBe(3);
  });

  test("times out a stalled write without retrying", async () => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return await new Promise<Response>(() => {});
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 5, backoffMs: [0, 0] }).request(`POST ${path}`, { sha: "x" })).rejects.toThrow("GitHub request timed out");
    expect(calls).toBe(1);
  });

  test.each(["GET", "HEAD"])("bounds repeated stalled %s attempts", async (method) => {
    const signals: AbortSignal[] = [];
    const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return await new Promise<Response>(() => {});
    }, { preconnect: () => undefined });
    await expect(github("t", fetch, { timeoutMs: 5, backoffMs: [0, 0] }).request(`${method} ${path}`)).rejects.toThrow("GitHub request timed out");
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  const writes: { name: string; call: (gh: GitHub) => Promise<unknown> }[] = [
    { name: "review creation", call: (gh) => gh.rest.pulls.createReview({ owner: "owner", repo: "repo", pull_number: 1, event: "APPROVE" }) },
    { name: "merge", call: (gh) => gh.rest.pulls.merge({ owner: "owner", repo: "repo", pull_number: 1 }) },
    { name: "PATCH", call: (gh) => gh.request(`PATCH ${path}`, { sha: "x" }) },
    { name: "DELETE", call: (gh) => gh.request(`DELETE ${path}`) },
    { name: "GraphQL commit mutation", call: (gh) => gh.graphql("mutation { createCommitOnBranch(input: {}) { clientMutationId } }") },
    { name: "mixed query and mutation", call: (gh) => gh.graphql("query Viewer { viewer { login } } mutation Change { createCommitOnBranch(input: {}) { clientMutationId } }", { operationName: "Change" }) },
    { name: "encoded raw body", call: (gh) => gh.request("POST /graphql", { data: '{"query":"\\u006dutation { createCommitOnBranch(input: {}) { clientMutationId } }"}' }) },
    { name: "data overrides query", call: (gh) => gh.request("POST /graphql", { query: "query Viewer { viewer { login } }", data: { query: "mutation Change { createCommitOnBranch(input: {}) { clientMutationId } }" } }) },
    { name: "missing GraphQL query", call: (gh) => gh.request("POST /graphql", { variables: {} }) },
    { name: "multiple queries", call: (gh) => gh.graphql("query { viewer { login } } query Other { viewer { login } }") },
    { name: "subscription", call: (gh) => gh.graphql("subscription { viewer { login } }") },
  ];
  test.each(writes.flatMap((entry) => ["http", "network"].map((failure) => ({ ...entry, failure }))))("does not retry $name on $failure failure", async ({ call, failure }) => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      if (failure === "network") throw new TypeError("unavailable");
      return Response.json({ message: "unavailable" }, { status: 503 });
    }, { preconnect: () => undefined });
    await expect(call(github("t", fetch, { timeoutMs: 100, backoffMs: [0, 0] }))).rejects.toThrow("unavailable");
    expect(calls).toBe(1);
  });

  test.each(["query Viewer { viewer { login } }", "query($owner: String!) { viewer { login } }", "{ viewer { login } }"])("retries GraphQL %s", async (query) => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return Response.json(calls === 1 ? { message: "unavailable" } : { data: { viewer: { login: "alice" } } }, { status: calls === 1 ? 503 : 200 });
    }, { preconnect: () => undefined });
    const gh = github("t", fetch, { timeoutMs: 100, backoffMs: [0] });
    await expect(gh.graphql(query)).resolves.toEqual({ viewer: { login: "alice" } });
    expect(calls).toBe(2);
  });

  test("caller cancellation stops retrying", async () => {
    let calls = 0;
    const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }, { preconnect: () => undefined });
    const controller = new AbortController();
    const gh = github("t", fetch, { timeoutMs: 1_000, backoffMs: [0, 0] });
    const request = gh.request(`GET ${path}`, { request: { signal: controller.signal } });
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow(/operation was aborted/);
    expect(calls).toBe(1);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(gh.request(`GET ${path}`, { request: { signal: alreadyAborted.signal } })).rejects.toThrow(/operation was aborted/);
    expect(calls).toBe(1);
  });

  test("caller cancellation interrupts retry backoff", async () => {
    let calls = 0;
    const fetch = Object.assign(async () => {
      calls++;
      return Response.json({ message: "unavailable" }, { status: 503 });
    }, { preconnect: () => undefined });
    const controller = new AbortController();
    const request = github("t", fetch, { timeoutMs: 100, backoffMs: [1_000] }).request(`GET ${path}`, { request: { signal: controller.signal } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(request).rejects.toThrow(/operation was aborted/);
    expect(calls).toBe(1);
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
