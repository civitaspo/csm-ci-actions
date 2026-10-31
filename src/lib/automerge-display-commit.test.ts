import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { createAutomergeDisplayCommit } from "./automerge-display-commit.ts";

const base = "a".repeat(40);
const first = "b".repeat(40);
const second = "c".repeat(40);
const payload = { version: 1 as const, repository_id: 42, repository: "owner/client", pull_number: 12, pull_node_id: "PR_12", base_ref: "main", merger: { id: 5, login: "operator", type: "User" as const }, mode: "human" as const, command_comment_id: 90, accepted_head: base, accepted_at: "2026-10-29T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z" };

function harness(options: { initial?: string; prior?: Record<string, unknown>; created?: Record<string, unknown>; conflicts?: number; failOnce?: boolean; baseComparison?: "identical" | "ahead" } = {}) {
  let head = options.initial;
  let conflicts = options.conflicts ?? 0;
  let failOnce = options.failOnce ?? false;
  const requests: { expectedHeadOid: string; message: { headline: string; body: string } }[] = [];
  const commit = (oid: string, parent: string, overrides: Record<string, unknown> = {}) => ({ oid, messageHeadline: "csm-ci: automerge owner/client#12", messageBody: "csm-ci:automerge-display:v1\nignored", changedFilesIfAvailable: 0, parents: { nodes: [{ oid: parent }] }, author: { user: { databaseId: 3000 } }, signature: { isValid: true, wasSignedByGitHub: true }, ...overrides });
  const commits = new Map([[base, commit(base, base, { author: null })], [first, commit(first, base, options.prior)], [second, commit(second, first)]]);
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (decodeURIComponent(url.pathname).endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: base } });
    if (decodeURIComponent(url.pathname).endsWith("/git/ref/heads/csm-ci/automerge")) return head ? Response.json({ object: { sha: head } }) : Response.json({ message: "Not Found" }, { status: 404 });
    if (url.pathname.endsWith("/git/refs") && method === "POST") { head = base; return Response.json({ ref: "refs/heads/csm-ci/automerge", object: { sha: base } }, { status: 201 }); }
    if (url.pathname.includes("/compare/")) return Response.json({ status: decodeURIComponent(url.pathname).includes(`${base}...main`) ? options.baseComparison ?? "identical" : "diverged" });
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { oid?: string; input?: { expectedHeadOid: string; message: { headline: string; body: string } } } };
      if (body.variables.oid) return Response.json({ data: { repository: { object: commits.get(body.variables.oid) } } });
      const mutation = body.variables.input;
      if (!mutation) throw new Error("missing mutation input");
      requests.push(mutation);
      if (failOnce) { failOnce = false; return Response.json({ errors: [{ message: "temporary failure" }] }); }
      if (conflicts-- > 0) { head = head === first ? second : first; return Response.json({ errors: [{ message: "head changed" }] }); }
      const parent = mutation.expectedHeadOid;
      head = second;
      commits.set(second, commit(second, parent, options.created));
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: second } } } });
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  }, { preconnect: globalThis.fetch.preconnect });
  return { server: github("token", fetch), requests };
}

test("bootstraps and creates a signed empty display commit against the observed head", async () => {
  const h = harness();
  expect(await createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload })).toBe(second);
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.expectedHeadOid).toBe(base);
  expect(h.requests[0]?.message).toEqual({ headline: "csm-ci: automerge owner/client#12", body: "csm-ci:automerge-display:v1\nrepository_id=42\ncommand_comment_id=90" });
});

test("retries a concurrent branch update without overwriting it", async () => {
  const h = harness({ conflicts: 1 });
  expect(await createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload })).toBe(second);
  expect(h.requests.map((request) => request.expectedHeadOid)).toEqual([base, first]);
});

test.each(["identical", "ahead"] as const)("recovers after bootstrap failure when default branch is %s", async (baseComparison) => {
  const h = harness({ failOnce: true, baseComparison });
  const args = { server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload };
  await expect(createAutomergeDisplayCommit(args)).rejects.toThrow("temporary failure");
  expect(await createAutomergeDisplayCommit(args)).toBe(second);
  expect(h.requests.map((request) => request.expectedHeadOid)).toEqual([base, base]);
});

test("stops after three concurrent branch updates", async () => {
  const h = harness({ conflicts: 3 });
  await expect(createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload })).rejects.toThrow("head changed");
  expect(h.requests.map((request) => request.expectedHeadOid)).toEqual([base, first, second]);
});

test.each([
  ["foreign author", { author: { user: { databaseId: 9 } } }],
  ["invalid signature", { signature: { isValid: false, wasSignedByGitHub: true } }],
  ["unsigned by GitHub", { signature: { isValid: true, wasSignedByGitHub: false } }],
  ["changed files", { changedFilesIfAvailable: 1 }],
  ["multiple parents", { parents: { nodes: [{ oid: base }, { oid: second }] } }],
  ["unrelated subject", { messageHeadline: "unrelated" }],
  ["missing display identity", { messageBody: "another feature" }],
  ["different object ID", { oid: second }],
])("does not update an existing branch with %s", async (_name, prior) => {
  const h = harness({ initial: first, prior });
  await expect(createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload })).rejects.toThrow("display branch tip is not an owned display commit");
  expect(h.requests).toHaveLength(0);
});

test.each([
  ["repository name", "not/a/valid/repository", "display commit repository name is invalid"],
  ["subject length", `owner/${"a".repeat(256)}`, "display commit subject is too long"],
])("rejects invalid %s", async (_name, repository, message) => {
  const h = harness();
  await expect(createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload: { ...payload, repository } })).rejects.toThrow(message);
  expect(h.requests).toHaveLength(0);
});

test.each([
  ["wrong author", { author: { user: { databaseId: 9 } } }],
  ["wrong parent", { parents: { nodes: [{ oid: first }] } }],
  ["wrong subject", { messageHeadline: "csm-ci: automerge owner/other#12" }],
  ["changed files", { changedFilesIfAvailable: 1 }],
  ["wrong object ID", { oid: first }],
])("rejects a created commit with %s", async (_name, created) => {
  const h = harness({ created });
  await expect(createAutomergeDisplayCommit({ server: h.server, serverRepository: "owner/server", defaultBranch: "main", serverBotId: 3000, payload })).rejects.toThrow("display commit verification failed");
});
