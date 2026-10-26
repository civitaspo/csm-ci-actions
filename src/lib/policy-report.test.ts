import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { github } from "./github.ts";
import { policyFailureContent, POLICY_FAILURE_MARKER, publishPolicyReport } from "./policy-report.ts";
import type { PolicyResult } from "./policies/index.ts";

const head = "a".repeat(40);
const success: PolicyResult[] = [{ type: "signed-commits", ok: true, problems: [] }];
const failure: PolicyResult[] = [{ type: "signed-commits", ok: false, problems: [`${head} is not signed and verified`] }];
const run = { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" };
type Report = { id: number; node_id: string; body: string; user: { id: number; type: string } | null; issue_url: string; isMinimized: boolean; minimizedReason: string | null };
const requestSchema = z.object({ query: z.string().optional(), variables: z.object({ id: z.string().optional(), classifier: z.string().optional() }).optional(), body: z.string().optional() });
function harness() {
  const comments: Report[] = [];
  const writes: { kind: string; classifier?: string | undefined; body?: string; id?: number }[] = [];
  const reads: string[] = [];
  let state = "open";
  let currentHead = head;
  let nextId = 1;
  let restPatch: Partial<Report> = {};
  let nodePatch: Record<string, unknown> = {};
  let graphError = false;
  let mutationError = false;
  let mutationResult: unknown;
  let errorPath = "";
  let errorStatus = 403;
  let lostCreate = false;
  let createFailure: number | undefined;
  let beforeCurrent: (() => void) | undefined;
  let pages = 0;
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const answer = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
    if (path === errorPath) return answer({ message: "policy API unavailable" }, errorStatus);
    if (method === "GET") reads.push(path);
    if (path === "/repos/owner/repo/pulls/12") {
      beforeCurrent?.();
      return answer({ state, head: { sha: currentHead } });
    }
    if (path === "/repos/owner/repo/issues/12/comments" && method === "GET") {
      pages++;
      const page = Number(url.searchParams.get("page") ?? "1");
      return answer(comments.slice((page - 1) * 100, page * 100), 200, page * 100 < comments.length ? { link: `<https://api.github.com${path}?page=${page + 1}&per_page=100>; rel="next"` } : {});
    }
    const payload = requestSchema.parse(JSON.parse(String(init?.body ?? "{}")));
    if (path === "/repos/owner/repo/issues/12/comments" && method === "POST") {
      const report = add(payload.body ?? "");
      writes.push({ kind: "create", body: report.body });
      if (createFailure) return answer({ message: "definitive creation failure" }, createFailure);
      if (lostCreate) { lostCreate = false; throw new TypeError("connection lost after creation"); }
      return answer(report, 201);
    }
    if (path.startsWith("/repos/owner/repo/issues/comments/")) {
      const id = Number(path.split("/").at(-1));
      const comment = comments.find((c) => c.id === id);
      return answer({ ...comment, ...restPatch });
    }
    if (path === "/graphql") {
      if (graphError) return answer({ errors: [{ message: "GraphQL policy failure" }] });
      const comment = comments.find((c) => c.node_id === payload.variables?.id);
      if (!comment) return answer({ data: { node: null } });
      if (payload.query?.startsWith("mutation")) {
        if (mutationError) return answer({ errors: [{ message: "GraphQL minimization failure" }] });
        writes.push({ kind: "minimize", id: comment.id, classifier: payload.variables?.classifier });
        comment.isMinimized = true;
        comment.minimizedReason = payload.variables?.classifier?.toLowerCase() ?? null;
        return answer({ data: mutationResult === undefined ? { minimizeComment: { minimizedComment: { isMinimized: comment.isMinimized, minimizedReason: comment.minimizedReason } } } : mutationResult });
      }
      return answer({ data: { node: { id: comment.node_id, databaseId: comment.id, body: comment.body, isMinimized: comment.isMinimized, minimizedReason: comment.minimizedReason, author: { __typename: comment.user?.type, databaseId: comment.user?.id }, issue: { number: 12, repository: { nameWithOwner: "owner/repo" } }, ...nodePatch } } });
    }
    return answer({ message: "Not Found" }, 404);
  }, { preconnect: () => {} });
  function add(body: string, changes: Partial<Report> = {}) {
    const id = nextId++;
    const report: Report = { id, node_id: `NODE_${id}`, body, user: { id: 3000, type: "Bot" }, issue_url: "https://api.github.com/repos/owner/repo/issues/12", isMinimized: false, minimizedReason: null, ...changes };
    comments.push(report);
    return report;
  }
  const server = github("token", fetch, { backoffMs: [] });
  const ctx = { server, repository: "owner/repo", pullNumber: 12, head, serverBotId: 3000, serverRun: run, requestCommentId: 9 };
  return { comments, writes, reads, ctx, add,
    publish: (results = failure, context = ctx) => publishPolicyReport(context, results),
    setCurrent: (sha: string, value = "open") => { currentHead = sha; state = value; },
    setBeforeCurrent: (fn: () => void) => { beforeCurrent = fn; },
    setRest: (patch: Partial<Report>) => { restPatch = patch; },
    setNode: (patch: Record<string, unknown>) => { nodePatch = patch; },
    setMutationError: () => { mutationError = true; },
    setGraphError: () => { graphError = true; },
    setMutation: (value: unknown) => { mutationResult = value; },
    setError: (path: string, status = 403) => { errorPath = path; errorStatus = status; },
    failCreateAfterWrite: (status: number) => { createFailure = status; },
    loseCreate: () => { lostCreate = true; },
    pages: () => pages,
  };
}

describe("policy failure rendering", () => {
  test.each([
    ["signed-commits", "abc is not signed and verified"],
    ["trusted-committers", "abc is by mallory (66), not a trusted committer"],
    ["sensitive-paths", "sensitive paths need a trusted approver's /approve: .github/workflows/build.yml"],
  ] satisfies [PolicyResult["type"], string][])("includes actual %s rejection and guidance", (type, problem) => {
    const content = policyFailureContent([{ type, ok: false, problems: [problem] }, { type: "trusted-committers", ok: true, problems: ["not a failure"] }]);
    expect(content).toContain(`- ${type}: <code>`);
    expect(content).toContain(type === "trusted-committers" ? "abc is by mallory &#40;66&#41;, not a trusted committer" : problem.replaceAll("'", "&#39;"));
    expect(content).not.toContain("not a failure");
    expect(content).toContain("approval cannot bypass");
    expect(content).toContain("after correcting the cause or a temporary issue");
    expect(content.includes("required trusted approver")).toBe(type === "sensitive-paths");
  });
  test("escapes hostile details and bounds all failed policy details without losing names", () => {
    const content = policyFailureContent((["signed-commits", "trusted-committers", "sensitive-paths"] satisfies PolicyResult["type"][]).map((type) => ({ type, ok: false, problems: ["<img>@alice `x` [link](x)\\\n".repeat(2000)] } satisfies PolicyResult)));
    expect(content.length).toBeLessThanOrEqual(6000);
    expect(content).toContain("&lt;img&gt;&#64;alice &#96;x&#96; &#91;link&#93;&#40;x&#41;&#92;");
    expect(content).not.toContain("<img>");
    expect(content).not.toContain("@alice");
    for (const type of ["signed-commits", "trusted-committers", "sensitive-paths"]) expect(content).toContain(`- ${type}:`);
    expect(content.match(/truncated; see server run/g)).toHaveLength(3);
  });
  test("normal size actionable content is separate from supplementary HTML links", async () => {
    const h = harness();
    await h.publish();
    const body = h.comments[0]?.body ?? "";
    expect(body.startsWith(POLICY_FAILURE_MARKER)).toBe(true);
    const [normal, small] = body.split("<sub>");
    expect(normal).toContain("Policy check failed");
    expect(normal).toContain("not signed and verified");
    expect(normal).toContain("Fix the reported violations");
    expect(small).not.toContain("Policy check failed");
    expect(small).toContain(`<a href="https://github.com/owner/repo/commit/${head}">Head aaaaaaa</a>`);
    expect(small).toContain('<a href="https://github.com/owner/server/actions/runs/345">Server run 345</a>');
    expect(small).toContain('<a href="https://github.com/owner/server/actions/runs/345/attempts/2">Attempt 2</a>');
    expect(small).toContain('Request policy-check owner/repo/12/9');
    expect(small).toContain('#issuecomment-9">Command</a>');
    expect(body.endsWith("</sub>")).toBe(true);
  });
});

describe("policy report lifecycle", () => {
  test("first failure, identical retry, changed failure, recovery, repeated recovery and failure after recovery", async () => {
    const h = harness();
    await h.publish();
    await h.publish(failure, { ...h.ctx, serverRun: { ...run, id: "999", attempt: "3" }, requestCommentId: 10 });
    expect(h.comments).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    const changed: PolicyResult[] = [{ type: "trusted-committers", ok: false, problems: ["not trusted"] }];
    await h.publish(changed);
    expect(h.comments).toHaveLength(2);
    expect(h.writes.at(-1)).toMatchObject({ kind: "minimize", classifier: "OUTDATED", id: 1 });
    await h.publish(success);
    expect(h.writes.slice(-2)).toEqual([{ kind: "minimize", id: 1, classifier: "RESOLVED" }, { kind: "minimize", id: 2, classifier: "RESOLVED" }]);
    const writes = h.writes.length;
    await h.publish(success);
    expect(h.writes).toHaveLength(writes);
    await h.publish(failure);
    expect(h.comments).toHaveLength(3);
    expect(h.comments[2]?.isMinimized).toBe(false);
  });
  test("new head creates a new failure report and supersedes old head", async () => {
    const h = harness();
    await h.publish();
    const next = "b".repeat(40);
    h.setCurrent(next);
    await h.publish(failure, { ...h.ctx, head: next });
    expect(h.comments).toHaveLength(2);
    expect(h.comments[0]).toMatchObject({ isMinimized: true, minimizedReason: "outdated" });
    expect(h.comments[1]?.body).toContain(`/commit/${next}`);
  });
  test("paginates all prior comments and resolves reports beyond page one", async () => {
    const h = harness();
    for (let i = 0; i < 101; i++) h.add("a user comment", { user: { id: 10, type: "User" } });
    const report = h.add(`${POLICY_FAILURE_MARKER}\nold failure`, { isMinimized: true, minimizedReason: "outdated" });
    await h.publish(success);
    expect(h.pages()).toBe(2);
    expect(h.writes).toEqual([{ kind: "minimize", id: report.id, classifier: "RESOLVED" }]);
  });
  test.each([
    ["user forged marker", { user: { id: 10, type: "User" } }, `${POLICY_FAILURE_MARKER}\nforged`],
    ["another bot", { user: { id: 4000, type: "Bot" } }, `${POLICY_FAILURE_MARKER}\nforged`],
    ["wrong type", { user: { id: 3000, type: "User" } }, `${POLICY_FAILURE_MARKER}\nforged`],
    ["null author", { user: null }, `${POLICY_FAILURE_MARKER}\nforged`],
    ["approval receipt", {}, "<!-- csm-ci:approve:9 -->\nreceipt"],
    ["merge receipt", {}, "<!-- csm-ci:merge:9 -->\nreceipt"],
    ["embedded marker", {}, `quoted ${POLICY_FAILURE_MARKER}\nforged`],
  ] satisfies [string, Partial<Report>, string][])("leaves %s untouched", async (_name, patch, body) => {
    const h = harness(); h.add(body, patch);
    await h.publish(success);
    expect(h.writes).toEqual([]);
    expect(h.reads.some((r) => r.includes("issues/comments/"))).toBe(false);
  });
  test("recovers a lost creation response by retaining the active owned report", async () => {
    const h = harness(); h.loseCreate();
    await h.publish();
    expect(h.comments).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
  });
  test.each(["failure", "success"])("a stale %s does not write or hide newer results", async (mode) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`);
    h.setCurrent("b".repeat(40));
    await h.publish(mode === "failure" ? failure : success);
    expect(h.writes).toEqual([]);
  });
  test.each(["closed", "open"])("checks PR %s and head immediately before each mutation", async (state) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`);
    h.setBeforeCurrent(() => h.setCurrent(state === "open" ? "b".repeat(40) : head, state));
    await h.publish(success);
    expect(h.writes).toEqual([]);
  });
});

describe("policy report trust boundary errors", () => {
  test.each([
    ["author id", { user: { id: 4000, type: "Bot" } }],
    ["author type", { user: { id: 3000, type: "User" } }],
    ["null author", { user: null }],
    ["marker", { body: "edited ordinary comment" }],
    ["wrong PR", { issue_url: "https://api.github.com/repos/owner/repo/issues/13" }],
    ["wrong repository", { issue_url: "https://api.github.com/repos/other/repo/issues/12" }],
    ["missing node id", { node_id: "" }],
    ["wrong REST id", { id: 9 }],
  ] satisfies [string, Partial<Report>][])("rejects changed %s before minimizing", async (_name, patch) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setRest(patch);
    await expect(h.publish(success)).rejects.toThrow("cannot verify policy report 1 ownership");
    expect(h.writes).toEqual([]);
  });
  test.each([
    ["node id", { id: "OTHER" }], ["database id", { databaseId: 9 }],
    ["author id", { author: { __typename: "Bot", databaseId: 4000 } }],
    ["author type", { author: { __typename: "User", databaseId: 3000 } }],
    ["missing identity", { author: null }],
    ["PR number", { issue: { number: 13, repository: { nameWithOwner: "owner/repo" } } }],
    ["repository", { issue: { number: 12, repository: { nameWithOwner: "other/repo" } } }],
    ["body", { body: "edited" }], ["missing state", { isMinimized: null }],
  ] satisfies [string, Record<string, unknown>][])("rejects inconsistent GraphQL %s", async (_name, patch) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setNode(patch);
    await expect(h.publish(success)).rejects.toThrow("cannot verify policy report 1 node identity");
    expect(h.writes).toEqual([]);
  });
  test.each([
    ["list", "/repos/owner/repo/issues/12/comments"],
    ["reread", "/repos/owner/repo/issues/comments/1"],
    ["current PR", "/repos/owner/repo/pulls/12"],
  ])("propagates %s REST errors", async (_name, path) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setError(path ?? "");
    await expect(h.publish(success)).rejects.toThrow("policy API unavailable");
    expect(h.writes).toEqual([]);
  });
  test("propagates comment creation errors", async () => {
    const h = harness();
    // Listing succeeds, but the write fails with a definitive permission error.
    const server = github("token", Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ message: "comment permission denied" }), { status: 403, headers: { "content-type": "application/json" } });
      const url = String(input);
      return new Response(JSON.stringify(url.includes("/pulls/") ? { state: "open", head: { sha: head } } : []), { headers: { "content-type": "application/json" } });
    }, { preconnect: () => {} }));
    await expect(publishPolicyReport({ ...h.ctx, server }, failure)).rejects.toThrow("comment permission denied");
  });
  test("surfaces GraphQL errors", async () => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setGraphError();
    await expect(h.publish(success)).rejects.toThrow("GraphQL policy failure");
    expect(h.writes).toEqual([]);
  });
  test.each([
    null, {}, { minimizeComment: null },
    { minimizeComment: { minimizedComment: { isMinimized: false, minimizedReason: "resolved" } } },
    { minimizeComment: { minimizedComment: { isMinimized: true, minimizedReason: "outdated" } } },
  ])("rejects unsuccessful minimization %j", async (value) => {
    const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setMutation(value);
    await expect(h.publish(success)).rejects.toThrow("policy report 1 was not minimized as RESOLVED");
  });
});

// Even if an equivalent report becomes visible, a definite authorization failure is not an uncertain write.
test.each([401, 403, 404, 422])("does not conceal definitive creation error %s behind a newly visible report", async (status) => {
  const h = harness(); h.failCreateAfterWrite(status);
  await expect(h.publish()).rejects.toThrow("definitive creation failure");
});

test("surfaces GraphQL mutation errors without reporting cleanup complete", async () => {
  const h = harness(); h.add(`${POLICY_FAILURE_MARKER}\nold failure`); h.setMutationError();
  await expect(h.publish(success)).rejects.toThrow("GraphQL minimization failure");
});
