import { describe, expect, test } from "bun:test";
import type { PullFacts } from "./command.ts";
import type { Config } from "./config.ts";
import { config, fakeFetch } from "./testing.ts";
import { github } from "./github.ts";
import { evaluatePullPolicies, policySummary, updatePolicyCheck } from "./policy-check.ts";

const head = "a".repeat(40);
const pull: PullFacts = { number: 12, state: "open", draft: false, headSha: head, headRepository: "owner/repo", baseRepository: "owner/repo", baseRef: "main", defaultBranch: "main", authorId: 10 };
const base = "/repos/owner/repo";

function setup(checkRuns: unknown[]) {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (init?.body) sent.push({ method, path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const routes = [
      { method: "GET", path: `${base}/pulls/12/commits`, body: [{ sha: head, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }] },
      { method: "GET", path: `${base}/commits/${head}/check-runs`, body: checkRuns },
      { method: "POST", path: `${base}/check-runs`, status: 201, body: { id: 99 } },
      { method: "PATCH", path: `${base}/check-runs/7`, body: { id: 7 } },
    ];
    const route = routes.find((r) => r.method === method && r.path === url.pathname);
    return route ? new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { server: github("token", fetch), sent };
}

describe("updatePolicyCheck", () => {
  const protectedCases: Array<[string, Config["policies"]]> = [
    ["omitted policy", []],
    ["exemption", [{ type: "sensitive-paths", paths: [], exempt: [{ id: 10, login: "alice" }] }]],
  ];
  test.each(protectedCases)("forces every path in the protected server repository despite %s", async (_case, policies) => {
    const protectedConfig = config();
    protectedConfig.policies = policies;
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/server/pulls/12/commits", body: [{ sha: head, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }] },
      { method: "GET", path: "/repos/owner/server/pulls/12/files", body: [{ filename: "ordinary.txt" }] },
      { method: "GET", path: "/repos/owner/server/pulls/12/reviews", body: [] },
    ]);
    const results = await evaluatePullPolicies({ server: github("token", fetch), config: protectedConfig, repository: "owner/server", pull });
    expect(results.find((result) => result.type === "sensitive-paths")).toEqual({ type: "sensitive-paths", ok: false, problems: ["sensitive paths need a trusted approver's /approve: ordinary.txt"] });
  });

  test("creates a current-head check run with the Server App and a result table", async () => {
    const { server, sent } = setup([]);
    await updatePolicyCheck({ server, config: config(), repository: "owner/repo", pull });
    const create = sent.find((r) => r.method === "POST" && r.path === `${base}/check-runs`);
    expect(create?.body).toMatchObject({ name: "csm-ci/policy", external_id: head, head_sha: head, status: "completed", completed_at: expect.any(String), conclusion: "success" });
    expect(create?.body.output).toMatchObject({ title: "Policies passed" });
    expect((create?.body.output as { summary: string }).summary).toContain("| trusted-committers | pass | — |");
  });

  test("updates only a check created by the configured Server App", async () => {
    const own = setup([{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 1 } }]);
    await updatePolicyCheck({ server: own.server, config: config(), repository: "owner/repo", pull });
    const update = own.sent.find((r) => r.method === "PATCH" && r.path === `${base}/check-runs/7`);
    expect(update).toBeDefined();
    expect(update?.body).toMatchObject({ status: "completed", completed_at: expect.any(String), conclusion: "success" });
    const other = setup([{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 2 } }]);
    await updatePolicyCheck({ server: other.server, config: config(), repository: "owner/repo", pull });
    expect(other.sent.some((r) => r.method === "POST" && r.path === `${base}/check-runs`)).toBe(true);
    expect(other.sent.some((r) => r.method === "PATCH")).toBe(false);
  });
});

test("policy summary keeps hostile details inside their table cell", () => {
  const summary = policySummary([{
    type: "sensitive-paths",
    ok: false,
    problems: ["bad\n| trusted-committers | pass | <img src=x onerror=alert(1)> `code` *bold* [link](https://example.test)\\tail"],
  }]);

  expect(summary.split("\n")).toHaveLength(3);
  expect(summary).not.toContain("| trusted-committers | pass |");
  expect(summary).toContain("bad &#124; trusted-committers &#124; pass &#124; &lt;img src=x onerror=alert(1)&gt; &#96;code&#96; &#42;bold&#42; &#91;link&#93;(https://example.test)&#92;tail");
});
