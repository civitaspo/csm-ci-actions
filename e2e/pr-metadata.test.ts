import { describe, expect, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { CLIENT, type Ctx, openPr, openReleasePr, prCase } from "./harness.ts";
import { annotatedBody, annotatePr, assertGeneratedMetadata, assertManagedMetadata, ensureLabels, FEATURES, LABEL_CATALOG, ownedAnnotationNumber, prBody, prLabels, prTitle } from "./pr-metadata.ts";
import { SCENARIOS } from "./scenarios.ts";
import { testIntent, testMetadata, testRun } from "./test-metadata.ts";
import { MANAGED_FILES_TITLE } from "../src/lib/managed-files.ts";

const repo = `/repos/${CLIENT}`;
const scenario = (feature: keyof typeof SCENARIOS, id: string) => {
  const found = SCENARIOS[feature].find((item) => item.id === `${feature}.${id}`);
  expect(found).toBeDefined();
  return found!;
};

describe("PR intent catalog", () => {
  test("all scenarios, including second-identity skips, have unique qualified IDs and complete declarations", () => {
    const ids = new Set<string>();
    const catalog = new Set(LABEL_CATALOG.map((label) => label.name));
    let skippedCases = 0;
    for (const feature of FEATURES) {
      const scenarios = SCENARIOS[feature];
      for (const item of scenarios) {
        expect(item.id.startsWith(`${feature}.`)).toBe(true);
        expect(ids.has(item.id)).toBe(false);
        ids.add(item.id);
        const caseIds = new Set<string>();
        for (const intent of Object.values(item.cases)) {
          expect(intent.id.length).toBeGreaterThan(0);
          expect(caseIds.has(intent.id)).toBe(false);
          caseIds.add(intent.id);
          expect(intent.title.length).toBeGreaterThan(0);
          expect(intent.identity.length).toBeGreaterThan(0);
          expect(intent.checks.length).toBeGreaterThan(0);
          const outcomes = new Set(intent.steps.map((step) => step.outcome));
          if (intent.classification === "positive") expect([...outcomes]).toEqual(["permitted"]);
          if (intent.classification === "negative") expect(outcomes.has("rejected")).toBe(true);
          if (intent.classification === "mixed") expect(outcomes.size).toBe(2);
          for (const step of intent.steps) {
            expect(step.operation.length).toBeGreaterThan(0);
            expect(step.expected.length).toBeGreaterThan(0);
          }
          for (const name of prLabels(feature, intent)) expect(catalog.has(name)).toBe(true);
          if (item.needsUntrusted) skippedCases++;
        }
      }
    }
    expect(skippedCases).toBeGreaterThan(0);
    expect(catalog.size).toBe(LABEL_CATALOG.length);
  });

  test("PR-producing paths stay declared and no-PR scenarios remain empty", () => {
    expect(Object.fromEntries(Object.entries(SCENARIOS).map(([feature, scenarios]) => [feature, scenarios.filter((item) => Object.keys(item.cases).length > 0).map((item) => item.id)]))).toEqual({
      smoke: [],
      approve: ["repository-paths", "trusted-auto", "unsigned-auto", "command", "replay", "unsigned-command", "edited-command", "recheck", "forged-author", "untrusted-commit", "untrusted-requester", "prefilter"].map((id) => `approve.${id}`),
      merge: ["authorized", "workflow-change", "notification-scope", "non-merger", "disabled-review-rule", "changed-head", "edited-command", "deleted-command", "approval-timeout", "configured-bot-ownership"].map((id) => `merge.${id}`),
      "policy-check": ["repository-sensitivity", "trusted", "closed-shared-sha", "unsigned", "untrusted", "sensitive-approval", "recheck", "non-approver-marker", "comment-marker"].map((id) => `policy-check.${id}`),
      securefix: ["pr-write", ...["unsafe-path", "symlink", "file-limit", "single-file-size-limit", "total-size-limit"].map((mode) => `client-${mode}`), "workflow-disabled", "forged-run", "target-event", "route-refresh", "alternate-base"].map((id) => `securefix.${id}`),
      release: ["publish-none", "publish-js-action", "publish-goreleaser", "publish-cargo", "publish-cargo-raw", "terraform-replay", "none-replay", "stale-dist", "tag-collision", "foreign-release", "invalid-version", "wrong-merger"].map((id) => `release.${id}`),
      "release-pr": ["root-updates-disabled", "explicit-refresh", "inferred-version"].map((id) => `release-pr.${id}`),
      "repo-settings": ["funding-true", "funding-false", "funding-managed-files-only", "reconciliation"].map((id) => `repo-settings.${id}`),
    });
  });

  test("repository policy fixtures declare each setup and result", () => {
    const approval = scenario("approve", "repository-paths").cases.fixture!;
    expect(approval.classification).toBe("positive");
    expect(approval.steps.map((step) => step.operation)).toEqual(["approve", "recheck"]);
    expect(prBody({ ...testRun, feature: "approve" }, approval)).toContain("Empty repository paths");
    const policy = scenario("policy-check", "repository-sensitivity").cases.fixture!;
    expect(policy.classification).toBe("mixed");
    expect(policy.steps.map((step) => step.outcome)).toEqual(["rejected", "permitted"]);
    const denied = scenario("merge", "configured-bot-ownership").cases["repository-denied"]!;
    expect(denied.classification).toBe("negative");
    expect(denied.steps.map((step) => step.outcome)).toEqual(["permitted", "rejected"]);
    expect(prBody({ ...testRun, feature: "merge" }, denied)).toContain("merge.allow\\_bot\\_requests to false");
  });

  test("configured Bot has four distinct PR expectations and describes temporary immutable trust", () => {
    const cases = scenario("merge", "configured-bot-ownership").cases;
    expect(Object.keys(cases)).toEqual(["repository-denied", "other-author", "mixed-commits", "own-pr"]);
    expect(Object.values(cases).map((intent) => intent.classification)).toEqual(["negative", "negative", "negative", "positive"]);
    for (const intent of Object.values(cases)) {
      const body = prBody({ ...testRun, feature: "merge" }, intent);
      expect(body).toContain("347402450");
      expect(body).toContain("trust.committers and trust.bot");
      expect(body).toContain("attempts to restore");
    }
    expect(cases["other-author"]?.identity.join(" ")).toContain("PR author and effective commit identity: civitaspo");
    expect(cases["mixed-commits"]?.identity.join(" ")).toContain("Later effective commit identity: civitaspo");
  });

  test.each([
    ["approve", "replay"], ["securefix", "pr-write"], ["policy-check", "sensitive-approval"],
  ] as const)("%s %s describes ordered mixed outcomes", (feature, id) => {
    const intent = scenario(feature, id).cases.fixture!;
    expect(intent.classification).toBe("mixed");
    expect(new Set(intent.steps.map((step) => step.outcome)).size).toBe(2);
    expect(prLabels(feature, intent).filter((label) => label.startsWith("case:"))).toEqual(["case:mixed"]);
  });

  test("negative release metadata explains deliberately successful setup merges", () => {
    const intent = scenario("release", "stale-dist").cases.fixture!;
    expect(intent.classification).toBe("negative");
    expect(prBody(testRun, intent)).toContain("intentionally successful Server App setup merge");
    expect(scenario("release", "tag-collision").cases["seed-release"]?.classification).toBe("positive");
  });

  test("local and CI execution preserve distinct candidate and harness revisions", () => {
    const local = prBody(testRun, testIntent);
    expect(local).toContain(`Candidate SHA: ${"1".repeat(40)}`);
    expect(local).toContain(`Harness SHA: ${"2".repeat(40)}`);
    expect(local).toContain("Local invocation local-test");
    expect(local).not.toContain("actions/runs");
    expect(local).toContain("not observed results or authorization evidence");
    const ci = prBody({ ...testRun, runner: { kind: "ci", url: "https://github.com/owner/repo/actions/runs/123", attempt: "2" } }, testIntent);
    expect(ci).toContain("https://github.com/owner/repo/actions/runs/123 (attempt 2)");
    expect(prTitle(testRun, testIntent, "1.2.3")).toBe("[e2e][release][positive] Release fixture — 1.2.3");
  });

  test("declarations escape HTML and Markdown text", () => {
    const body = prBody(testRun, { ...testIntent, title: "fixture", identity: ["<script> [secret](https://bad) <!-- marker -->\nnext"] });
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("[secret](");
    expect(body).toContain("&lt;script&gt;");
  });

  test("missing explicit cases reject with their scenario identity", () => {
    expect(() => prCase({ gh: github("test"), urls: [], untrusted: undefined, ...testMetadata }, "missing")).toThrow("missing PR case missing for release.test");
  });
});

describe("owned annotation", () => {
  test("preserves server bytes/markers and replaces only its section idempotently", () => {
    const server = "Release title\n\n<!-- csm-ci:securefix:123 -->\n\n";
    const first = annotatedBody(server, "first\n");
    expect(first.startsWith(server)).toBe(true);
    const changed = annotatedBody(first + "\noperator suffix", "second\n");
    expect(changed).toBe(annotatedBody(server, "second\n") + "\noperator suffix");
    expect(annotatedBody(changed, "second\n")).toBe(changed);
    expect(changed).not.toContain("first");
  });
  test.each([
    "<!-- csm-ci-e2e:intent:start -->",
    "<!-- csm-ci-e2e:intent:end -->",
    "<!-- csm-ci-e2e:intent:end --><!-- csm-ci-e2e:intent:start -->",
    "<!-- csm-ci-e2e:intent:start --><!-- csm-ci-e2e:intent:start --><!-- csm-ci-e2e:intent:end -->",
    "<!-- csm-ci-e2e:intent:start --><!-- csm-ci-e2e:intent:end --><!-- csm-ci-e2e:intent:end -->",
  ])("refuses malformed owned sections without changing server text: %s", (body) => {
    expect(() => annotatedBody(body, "new")).toThrow("malformed harness intent section; refusing to edit server content");
  });
  test.each([undefined, {}, { pull: { number: 12 } }])("unverified managed targets reject before annotation", (owned) => {
    expect(() => ownedAnnotationNumber(owned, 17)).toThrow("managed PR ownership is not verified; refusing annotation");
  });
  test("verified managed target keeps its exact number", () => expect(ownedAnnotationNumber({ pull: { number: 17 } }, 17)).toBe(17));

  test("uses additive owner labels and preserves the original server marker and title", async () => {
    const body = "Original server bytes\n<!-- csm-ci:securefix:123 -->";
    const api = fakeFetch([
      { method: "POST", path: `${repo}/issues/17/labels`, body: [{ name: "operator" }] },
      { method: "GET", path: `${repo}/pulls/17`, body: { body } },
      { method: "PATCH", path: `${repo}/pulls/17`, body: {} },
    ]);
    await annotatePr(github("owner", api), CLIENT, 17, testRun, testIntent);
    expect(JSON.parse(api.requests[0]!.body!)).toEqual({ labels: ["e2e", "e2e:release", "case:positive", "check:release-publication"] });
    expect(JSON.parse(api.requests[2]!.body!)).toEqual({ body: annotatedBody(body, prBody(testRun, testIntent)) });
    expect(api.requests.some((request) => request.method === "DELETE" || request.method === "PUT")).toBe(false);
  });
});

describe("persistent catalog labels", () => {
  test("existing operator colors/descriptions are reused without writes", async () => {
    const api = fakeFetch([{ method: "GET", path: `${repo}/labels/e2e`, body: { name: "e2e", color: "123456", description: "operator" } }]);
    await ensureLabels(github("test", api), CLIENT, ["e2e"]);
    expect(api.calls).toEqual([`GET ${repo}/labels/e2e`]);
  });
  test.each([200, 422])("missing label creation HTTP %i is recovered only by an exact reread on conflict", async (status) => {
    const api = fakeFetch([
      { method: "GET", path: `${repo}/labels/e2e`, status: 404, body: { message: "missing" } },
      { method: "POST", path: `${repo}/labels`, status, body: {} },
    ]);
    let reads = 0;
    const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && ++reads > 1) return new Response(JSON.stringify({ name: "e2e" }), { status: 200, headers: { "content-type": "application/json" } });
      return api(input, init);
    }, { preconnect: () => undefined });
    await ensureLabels(github("test", fetch), CLIENT, ["e2e"]);
    expect(reads).toBe(status === 422 ? 2 : 1);
    expect(JSON.parse(api.requests.find((request) => request.method === "POST")!.body!)).toEqual(LABEL_CATALOG[0]);
  });
  test.each([403, 422, 503])("unrelated existing-label lookup HTTP %i propagates", async (status) => {
    const api = fakeFetch([{ method: "GET", path: `${repo}/labels/e2e`, status, body: { message: "lookup failed" } }]);
    await expect(ensureLabels(github("test", api, { backoffMs: [] }), CLIENT, ["e2e"])).rejects.toThrow("lookup failed");
    expect(api.requests.some((request) => request.method === "POST")).toBe(false);
  });
  test.each([403, 422, 503])("failed label creation HTTP %i propagates without edits", async (status) => {
    const api = fakeFetch([
      { method: "GET", path: `${repo}/labels/e2e`, status: 404, body: { message: "still missing" } },
      { method: "POST", path: `${repo}/labels`, status, body: { message: "create failed" } },
    ]);
    await expect(ensureLabels(github("test", api, { backoffMs: [] }), CLIENT, ["e2e"])).rejects.toThrow(status === 422 ? "still missing" : "create failed");
    expect(api.requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

describe("metadata failures keep cleanup", () => {
  test.each([false, true])("direct creation labels fail; cleanup still runs (cleanup failure %s)", async (cleanupFails) => {
    const api = fakeFetch([
      { method: "GET", path: `${repo}/branches/main`, body: { commit: { sha: "1".repeat(40) } } },
      { method: "POST", path: `${repo}/git/refs`, body: {} },
      { method: "POST", path: "/graphql", body: { data: { createCommitOnBranch: { commit: { oid: "2".repeat(40) } } } } },
      { method: "POST", path: `${repo}/pulls`, body: { number: 17, html_url: "https://example.test/pr/17" } },
      { method: "POST", path: `${repo}/issues/17/labels`, status: 403, body: { message: "label failed" } },
      { method: "GET", path: `${repo}/pulls/17`, body: { state: "open" } },
      { method: "PATCH", path: `${repo}/pulls/17`, status: cleanupFails ? 403 : 200, body: { message: "close failed" } },
    ]);
    // Branch names are unique, so accept the exact DELETE chosen by the creator.
    let deleted = false;
    const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return api(input, init);
    }, { preconnect: () => undefined });
    const ctx: Ctx = { gh: github("owner", fetch), urls: [], untrusted: undefined, ...testMetadata };
    await expect(openPr(ctx, { intent: testIntent, kind: "signed" })).rejects.toThrow("label failed");
    expect(ctx.urls).toEqual(["https://example.test/pr/17"]);
    expect(api.calls).toContain(`PATCH ${repo}/pulls/17`);
    expect(deleted).toBe(!cleanupFails);
    const create = JSON.parse(api.requests.find((request) => request.path === `${repo}/pulls`)!.body!);
    expect(create.body).toBe(prBody(testRun, testIntent));
    expect(create.title).toContain("[e2e][release][positive] Release fixture");
  });

  test("release label failure recovers the rendered title and retains both primary and cleanup failures", async () => {
    const title = prTitle(testRun, testIntent, "1.2.3");
    let refs = 0;
    const api = fakeFetch([
      { method: "GET", path: `${repo}/branches/main`, body: { commit: { sha: "1".repeat(40) } } },
      { method: "POST", path: `${repo}/git/refs`, body: {} },
      { method: "POST", path: "/graphql", body: { data: { createCommitOnBranch: { commit: { oid: "2".repeat(40) } } } } },
      { method: "POST", path: `${repo}/pulls`, body: { number: 17, html_url: "https://example.test/pr/17" } },
      { method: "POST", path: `${repo}/issues/17/labels`, status: 403, body: { message: "label failed" } },
      { method: "GET", path: `${repo}/pulls`, body: [{ number: 17, title }, { number: 18, title: "unrelated" }] },
      { method: "PATCH", path: `${repo}/pulls/17`, status: 403, body: { message: "close failed" } },
      { method: "DELETE", path: `${repo}/git/refs/heads%2Frelease%2Fnext`, body: {} },
    ]);
    const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/git/ref/heads%2Frelease%2Fnext")) {
        refs++;
        return new Response(JSON.stringify(refs === 1 ? { message: "Not Found" } : { object: { sha: "2".repeat(40) } }), { status: refs === 1 ? 404 : 200, headers: { "content-type": "application/json" } });
      }
      return api(input, init);
    }, { preconnect: () => undefined });
    const ctx: Ctx = { gh: github("owner", fetch), urls: [], untrusted: undefined, ...testMetadata };
    let failure: unknown;
    try { await openReleasePr(ctx, { intent: testIntent, version: "1.2.3" }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain("label failed");
    expect(String(failure)).toContain("close failed");
    expect(api.calls).toContain(`DELETE ${repo}/git/refs/heads%2Frelease%2Fnext`);
    expect(api.calls).not.toContain(`PATCH ${repo}/pulls/18`);
  });
});

describe("generated output contract before annotation", () => {
  test.each([
    { title: "changed", body: "generated" },
    { title: "expected", body: "changed" },
    { title: "expected", body: null },
  ])("rejects changed server metadata %j", (actual) => {
    expect(() => assertGeneratedMetadata(actual, { title: "expected", body: "generated" })).toThrow(actual.title !== "expected" ? "unexpected generated PR title" : "unexpected generated PR body");
  });
  test("accepts the complete original output", () => {
    expect(() => assertGeneratedMetadata({ title: "expected", body: "generated" }, { title: "expected", body: "generated" })).not.toThrow();
  });
  test.each(["title", "body"])("managed metadata failure prevents annotation writes: %s", async (field) => {
    const actual = { title: MANAGED_FILES_TITLE, body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->", [field]: "changed" };
    const api = fakeFetch([{ method: "GET", path: `${repo}/pulls/17`, body: actual }]);
    const gh = github("test", api);
    await expect((async () => {
      await assertManagedMetadata(gh, CLIENT, 17);
      await annotatePr(gh, CLIENT, 17, testRun, testIntent);
    })()).rejects.toThrow(`unexpected generated PR ${field}`);
    expect(api.requests.some((request) => request.method !== "GET")).toBe(false);
  });
  test("alternate base is cleaned when first PR labeling fails", async () => {
    const item = scenario("securefix", "alternate-base");
    const api = fakeFetch([
      { method: "GET", path: `${repo}/branches/main`, body: { commit: { sha: "1".repeat(40) } } },
      { method: "POST", path: `${repo}/git/refs`, body: {} },
      { method: "POST", path: "/graphql", body: { data: { createCommitOnBranch: { commit: { oid: "2".repeat(40) } } } } },
      { method: "POST", path: `${repo}/pulls`, body: { number: 17, html_url: "https://example.test/pr/17" } },
      { method: "POST", path: `${repo}/issues/17/labels`, status: 403, body: { message: "label failed" } },
      { method: "GET", path: `${repo}/pulls/17`, body: { state: "open" } },
      { method: "PATCH", path: `${repo}/pulls/17`, body: {} },
    ]);
    const deleted: string[] = [];
    const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted.push(String(input)); return new Response(null, { status: 204 }); }
      return api(input, init);
    }, { preconnect: () => undefined });
    const ctx: Ctx = { gh: github("owner", fetch), urls: [], untrusted: undefined, ...testMetadata, cases: item.cases };
    await expect(item.run(ctx)).rejects.toThrow("label failed");
    expect(deleted).toHaveLength(2);
    expect(deleted.some((url) => url.includes("e2e-base-"))).toBe(true);
  });
});
