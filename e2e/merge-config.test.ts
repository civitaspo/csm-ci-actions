import { testMetadata } from "./test-metadata.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseConfig } from "../src/lib/config.ts";
import { github, splitRepository } from "../src/lib/github.ts";
import { CLIENT, SERVER } from "./harness.ts";
import { deleteOwnedIntegrationBase, withPendingRequiredCheck, withTestBotConfigured } from "./merge.ts";
import { withRepositoryPolicy } from "./repository-policy.ts";

const original = readFileSync(new URL("./fixtures/testing-csm-ci-server/csm-ci.yaml", import.meta.url), "utf8");
test.each([false, true])("nested Bot policy fixture restores original bytes after failure=%s with stale mutable content", async (fail) => {
  let text = original;
  let writes = 0;
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/repos/${SERVER}/git/ref/heads%2Fmain`) return Response.json({ object: { sha: `head-${writes}` } });
    if (url.pathname !== `/repos/${SERVER}/contents/csm-ci.yaml`) throw new Error(`unexpected request: ${url.pathname}`);
    if (init?.method === "PUT") {
      const body = z.object({ sha: z.string(), content: z.string() }).parse(JSON.parse(String(init.body)));
      expect(body.sha).toBe(`blob-${writes}`);
      text = Buffer.from(body.content, "base64").toString("utf8");
      writes += 1;
      return Response.json({ content: { sha: `blob-${writes}` } });
    }
    const content = url.searchParams.get("ref") === "main" ? original : text;
    return Response.json({ type: "file", sha: `blob-${writes}`, content: Buffer.from(content).toString("base64") });
  }, { preconnect() {} });
  const ctx = { ...testMetadata, gh: github("test", fetch), urls: [], untrusted: undefined };
  const run = withTestBotConfigured(ctx, async () => {
    await withRepositoryPolicy(ctx, { sensitive_paths: { paths: [] }, merge: { allow_bot_requests: true } }, async () => {
      expect(parseConfig(text).trust.bot_mergers).toContainEqual({ id: 347402450, login: "testing-csm-ci-untrusted-committer[bot]" });
      if (fail) throw new Error("scenario failed");
    });
    expect(parseConfig(text).trust.bot_mergers).toHaveLength(1);
  });
  if (fail) await expect(run).rejects.toThrow("scenario failed");
  else await run;
  expect(writes).toBe(4);
  expect(text).toBe(original);
});

function pendingGateContext(options: { nativeMerge: boolean; disarmStatus?: number }) {
  const requests: { method: string; path: string; body?: string }[] = [];
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.pathname === `/repos/${CLIENT}`) return Response.json({ default_branch: "main" });
    if (url.pathname === `/repos/${CLIENT}/rulesets` && method === "POST") return Response.json({ id: 712, name: "csm-ci-e2e-pending-33" });
    if (url.pathname === `/repos/${CLIENT}/rulesets/712` && method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/graphql") {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.startsWith("mutation")) {
        if (options.disarmStatus) return Response.json({ message: "auto-merge disable rejected" }, { status: options.disarmStatus });
        return Response.json({ data: { disablePullRequestAutoMerge: { clientMutationId: null } } });
      }
      return Response.json({ data: { repository: { pullRequest: { id: "PR_33", merged: false, autoMergeRequest: options.nativeMerge ? { enabledAt: "2026-11-13T00:00:00Z" } : null } } } });
    }
    throw new Error(`unexpected mocked GitHub request: ${method} ${url.pathname}`);
  }, { preconnect() {} });
  const ctx = { ...testMetadata, gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined };
  return { ctx, requests };
}

describe("pending required-check gate scope and cleanup", () => {
  test("failed disarm retains a gate scoped to the isolated base, never the default branch", async () => {
    const { ctx, requests } = pendingGateContext({ nativeMerge: true, disarmStatus: 403 });
    const pr = { number: 33, head: "head", branch: "e2e-head", baseRef: "e2e-merge-gate-unique" };
    await expect(withPendingRequiredCheck(ctx, pr, async () => { throw new Error("simulated acceptance failure"); }))
      .rejects.toThrow("leaving owned ruleset 712 (csm-ci-e2e-pending-33) on refs/heads/e2e-merge-gate-unique active because native auto-merge could not be confirmed off");
    const created = requests.find((request) => request.method === "POST" && request.path === `/repos/${CLIENT}/rulesets`);
    expect(created).toBeDefined();
    const ruleset = JSON.parse(created!.body!) as { conditions: { ref_name: { include: string[] } } };
    expect(ruleset.conditions.ref_name.include).toEqual(["refs/heads/e2e-merge-gate-unique"]);
    expect(requests.filter((request) => request.method === "POST" && request.path === "/graphql")).toHaveLength(3);
    expect(requests.some((request) => request.method === "DELETE" && request.path.endsWith("/rulesets/712"))).toBe(false);
  });

  test("normal release removes only the exact fixture ruleset", async () => {
    const { ctx, requests } = pendingGateContext({ nativeMerge: false });
    const pr = { number: 33, head: "head", branch: "e2e-head", baseRef: "e2e-merge-gate-unique" };
    await withPendingRequiredCheck(ctx, pr, async (release) => release());
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([{ method: "DELETE", path: `/repos/${CLIENT}/rulesets/712` }]);
  });

  test("refuses to create a pending gate for the repository default branch", async () => {
    const { ctx, requests } = pendingGateContext({ nativeMerge: false });
    const pr = { number: 33, head: "head", branch: "e2e-head", baseRef: "main" };
    await expect(withPendingRequiredCheck(ctx, pr, async () => undefined)).rejects.toThrow("pending required-check gate requires an isolated base branch; refusing to target default branch main");
    expect(requests.some((request) => request.method === "POST" && request.path === `/repos/${CLIENT}/rulesets`)).toBe(false);
  });
});

function integrationBaseCleanupContext(options: { pullState: "open" | "closed"; refSha: string }) {
  const requests: { method: string; path: string }[] = [];
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (url.pathname === `/repos/${CLIENT}/pulls/33`) return Response.json({ state: options.pullState, merged: false });
    if (url.pathname === `/repos/${CLIENT}/git/ref/heads%2Fe2e-merge-gate-unique` && method === "GET") return Response.json({ object: { sha: options.refSha } });
    if (url.pathname === `/repos/${CLIENT}/git/refs/heads%2Fe2e-merge-gate-unique` && method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected mocked GitHub request: ${method} ${url.pathname}`);
  }, { preconnect() {} });
  const ctx = { ...testMetadata, gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined };
  return { ctx, requests };
}

describe("owned integration base cleanup", () => {
  const baseRef = "e2e-merge-gate-unique";
  const baseSha = "base-sha";
  const pr = { number: 33, head: "head", branch: "e2e-head", baseRef };

  test("retains the owned base while its fixture PR is open", async () => {
    const { ctx, requests } = integrationBaseCleanupContext({ pullState: "open", refSha: baseSha });
    await expect(deleteOwnedIntegrationBase(ctx, splitRepository(CLIENT), baseRef, baseSha, pr))
      .rejects.toThrow("retaining owned integration branch e2e-merge-gate-unique because fixture pull request #33 is still open");
    expect(requests).toEqual([{ method: "GET", path: `/repos/${CLIENT}/pulls/33` }]);
  });

  test("retains the owned base when its ref moved unexpectedly", async () => {
    const { ctx, requests } = integrationBaseCleanupContext({ pullState: "closed", refSha: "unexpected-sha" });
    await expect(deleteOwnedIntegrationBase(ctx, splitRepository(CLIENT), baseRef, baseSha, pr))
      .rejects.toThrow("retaining owned integration branch e2e-merge-gate-unique; expected base-sha, found unexpected-sha");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });
});
