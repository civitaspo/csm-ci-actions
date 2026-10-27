import { describe, expect, test } from "bun:test";
import type { PullFacts } from "./command.ts";
import type { Config } from "./config.ts";
import { config, fakeFetch } from "./testing.ts";
import { github } from "./github.ts";
import { effectivePolicies, evaluatePullPolicies, policySummary, updatePolicyCheck } from "./policy-check.ts";

const serverRun = { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" };
const head = "a".repeat(40);
const pull: PullFacts = { number: 12, state: "open", draft: false, headSha: head, headRepository: "owner/repo", baseRepository: "owner/repo", baseRef: "main", defaultBranch: "main", authorId: 10 };
const base = "/repos/owner/repo";

function setup(checkRuns: unknown[], current = { state: "open", head: { sha: head } }, commits: unknown[] = [{ sha: head, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }], pullStatus = 200) {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") reads.push(url.pathname);
    if (init?.body) sent.push({ method, path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const routes = [
      { method: "GET", path: `${base}/pulls/12/commits`, body: commits },
      { method: "GET", path: `${base}/pulls/12`, body: current, status: pullStatus },
      { method: "GET", path: `${base}/commits/${head}/check-runs`, body: checkRuns },
      { method: "GET", path: `${base}/issues/12/comments`, body: [] },
      { method: "POST", path: `${base}/issues/12/comments`, status: 201, body: { id: 100 } },
      { method: "POST", path: `${base}/check-runs`, status: 201, body: { id: 99 } },
      { method: "PATCH", path: `${base}/check-runs/7`, body: { id: 7 } },
    ];
    const route = routes.find((r) => r.method === method && r.path === url.pathname);
    return route ? new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { server: github("token", fetch), sent, reads };
}

describe("updatePolicyCheck", () => {
  function protectionFetch(repository: string) {
    const path = `/repos/${repository}/pulls/12`;
    return fakeFetch([
      { method: "GET", path: `${path}/commits`, body: [{ sha: head, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }] },
      { method: "GET", path: `${path}/files`, body: [{ filename: "ordinary.txt" }] },
      { method: "GET", path: `${path}/reviews`, body: [] },
    ]);
  }

  test.each(["owner/server", "civitaspo/csm-ci-actions"])("explicit protection of %s covers every path and ignores the global exemption", async (repository) => {
    const cfg = config();
    cfg.owners.push("civitaspo");
    cfg.policies = [{ type: "sensitive-paths", paths: ["docs/**"], exempt: [{ id: 10, login: "alice" }] }];
    cfg.repositories = [{ name: repository, ops: ["policy-check"], sensitive_paths: { paths: ["**"], exempt: [] } }];
    const results = await evaluatePullPolicies({ server: github("token", protectionFetch(repository)), config: cfg, repository, pull });
    expect(results.find((result) => result.type === "sensitive-paths")).toEqual({ type: "sensitive-paths", ok: false, problems: ["sensitive paths need a trusted approver's /approve: ordinary.txt"] });
  });

  test.each(["owner/server", "civitaspo/csm-ci-actions"])("an explicit exemption applies to %s", async (repository) => {
    const cfg = config();
    cfg.owners.push("civitaspo");
    cfg.policies = [{ type: "sensitive-paths", paths: ["**"], exempt: [] }];
    cfg.repositories = [{ name: repository, ops: ["policy-check"], sensitive_paths: { exempt: [{ id: 10, login: "alice" }] } }];
    const results = await evaluatePullPolicies({ server: github("token", protectionFetch(repository)), config: cfg, repository, pull });
    expect(results.find((result) => result.type === "sensitive-paths")).toEqual({ type: "sensitive-paths", ok: true, problems: [] });
  });

  test.each(["owner/server", "civitaspo/csm-ci-actions"])("%s without a global policy or override has no sensitive-paths result", async (repository) => {
    const cfg = config();
    cfg.owners.push("civitaspo");
    cfg.policies = [];
    cfg.repositories = [{ name: repository, ops: ["policy-check"] }];
    expect(effectivePolicies(cfg, repository).some((policy) => policy.type === "sensitive-paths")).toBe(false);
  });

  test.each([
    ["owner/server", "no override", undefined],
    ["civitaspo/csm-ci-actions", "explicit empty paths", { paths: [], exempt: [] }],
  ] as const)("%s follows its configuration with %s", async (repository, _case, override) => {
    const cfg = config();
    cfg.owners.push("civitaspo");
    cfg.policies = [{ type: "sensitive-paths", paths: ["docs/**"], exempt: [] }];
    cfg.repositories = [{ name: repository, ops: ["policy-check"], ...(override ? { sensitive_paths: { paths: [...override.paths], exempt: [...override.exempt] } } : {}) }];
    const results = await evaluatePullPolicies({ server: github("token", protectionFetch(repository)), config: cfg, repository, pull });
    expect(results.find((result) => result.type === "sensitive-paths")).toEqual({ type: "sensitive-paths", ok: true, problems: [] });
  });

  test.each([[[]], [[{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 1 } }]]])("skips a closed PR without evaluating or publishing, checks %j", async (checks) => {
    const { server, sent, reads } = setup(checks, { state: "closed", head: { sha: head } }, []);
    const outcome = await updatePolicyCheck({ server, config: config(), repository: "owner/repo", serverRun, pull: { ...pull, state: "closed" } });
    expect(outcome).toEqual({ result: "skipped", reason: "#12 is closed" });
    expect(sent).toEqual([]);
    expect(reads).toEqual([]);
  });

  const races = [
    ["closure", { state: "closed", head: { sha: head } }, "#12 closed before policy publication"],
    ["head change", { state: "open", head: { sha: "b".repeat(40) } }, "#12 head moved before policy publication"],
  ] as const;
  test.each(races)("skips publication after %s during evaluation", async (_name, current, reason) => {
    for (const checks of [[], [{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 1 } }]]) {
      const { server, sent, reads } = setup(checks, current);
      expect(await updatePolicyCheck({ server, config: config(), repository: "owner/repo", serverRun, pull })).toEqual({ result: "skipped", reason });
      expect(sent).toEqual([]);
      expect(reads.at(-1)).toBe(`${base}/pulls/12`);
    }
  });

  test.each([403, 404, 422, 500])("propagates final PR read failure %s without publishing", async (status) => {
    const { server, sent } = setup([], undefined, undefined, status);
    await expect(updatePolicyCheck({ server, config: config(), repository: "owner/repo", serverRun, pull })).rejects.toMatchObject({ status });
    expect(sent).toEqual([]);
  });

  test("an open PR with no commits still publishes both trust failures", async () => {
    const { server, sent } = setup([], undefined, []);
    expect(await updatePolicyCheck({ server, config: config(), repository: "owner/repo", serverRun, pull })).toEqual({ result: "published", results: [
      { type: "signed-commits", ok: false, problems: ["pull request has no commits"] },
      { type: "trusted-committers", ok: false, problems: ["pull request has no commits"] },
    ] });
    expect(sent[0]?.body.conclusion).toBe("failure");
  });

  test("creates a current-head check run with the Server App and a result table", async () => {
    const { server, sent } = setup([]);
    await updatePolicyCheck({ server, config: config(), repository: "owner/repo", serverRun, pull });
    const create = sent.find((r) => r.method === "POST" && r.path === `${base}/check-runs`);
    expect(create?.body).toMatchObject({ name: "csm-ci/policy", external_id: head, head_sha: head, status: "completed", completed_at: expect.any(String), conclusion: "success" });
    expect(create?.body.output).toMatchObject({ title: "Policies passed" });
    expect((create?.body.output as { summary: string }).summary).toContain("| trusted-committers | pass | — |");
  });

  test("updates only a check created by the configured Server App", async () => {
    const own = setup([{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 1 } }]);
    await updatePolicyCheck({ server: own.server, config: config(), repository: "owner/repo", serverRun, pull });
    const update = own.sent.find((r) => r.method === "PATCH" && r.path === `${base}/check-runs/7`);
    expect(update).toBeDefined();
    expect(update?.body).toMatchObject({ status: "completed", completed_at: expect.any(String), conclusion: "success" });
    const other = setup([{ id: 7, name: "csm-ci/policy", external_id: head, app: { id: 2 } }]);
    await updatePolicyCheck({ server: other.server, config: config(), repository: "owner/repo", serverRun, pull });
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


describe("effective repository policies", () => {
  const alice = { id: 10, login: "alice" };
  const bot = { id: 20, login: "renovate[bot]" };
  const global = { type: "sensitive-paths", paths: ["global/**"], exempt: [alice] } satisfies Config["policies"][number];
  const cases: Array<[string, Config["repositories"][number]["sensitive_paths"], Config["policies"], Config["policies"]]> = [
    ["omission inherits", undefined, [global], [global]],
    ["empty object inherits", {}, [global], [global]],
    ["paths replace independently", { paths: ["local/**"] }, [global], [{ ...global, paths: ["local/**"] }]],
    ["exemptions replace independently", { exempt: [bot] }, [global], [{ ...global, exempt: [bot] }]],
    ["empty paths replace", { paths: [] }, [global], [{ ...global, paths: [] }]],
    ["empty exemptions replace", { exempt: [] }, [global], [{ ...global, exempt: [] }]],
    ["omission keeps absent policy disabled", undefined, [], []],
    ["empty object enables absent policy", {}, [], [{ type: "sensitive-paths", paths: [], exempt: [] }]],
    ["absent global components default empty", { paths: ["local/**"] }, [], [{ type: "sensitive-paths", paths: ["local/**"], exempt: [] }]],
    ["every duplicate policy receives replacements", { paths: [], exempt: [bot] }, [global, { ...global, paths: ["other/**"], exempt: [] }], [{ ...global, paths: [], exempt: [bot] }, { ...global, paths: [], exempt: [bot] }]],
  ];
  test.each(cases)("%s", (_name, override, policies, expected) => {
    const cfg = config();
    cfg.policies = policies;
    cfg.repositories = [{ name: "owner/repo", ops: ["approve"], ...(override === undefined ? {} : { sensitive_paths: override }) }];
    expect(effectivePolicies(cfg, "owner/repo")).toEqual([{ type: "signed-commits" }, { type: "trusted-committers" }, ...expected]);
  });

  test("the first entry supplies the complete override and repositories remain independent", () => {
    const cfg = config();
    cfg.policies = [global];
    cfg.repositories = [
      { name: "owner/repo", ops: ["approve"], sensitive_paths: { paths: ["local/**"] } },
      { name: "owner/*", ops: ["approve"], sensitive_paths: { exempt: [bot] } },
    ];
    expect(effectivePolicies(cfg, "OWNER/REPO").at(-1)).toEqual({ ...global, paths: ["local/**"] });
    expect(effectivePolicies(cfg, "owner/other").at(-1)).toEqual({ ...global, exempt: [bot] });
  });

  test.each([
    ["inherited sensitivity", undefined, false],
    ["replacement paths", { paths: ["other/**"] }, true],
    ["explicit empty paths", { paths: [] }, true],
    ["replacement exemption", { exempt: [alice] }, true],
    ["empty exemptions revoke inherited exemption", { exempt: [] }, false],
  ] satisfies [string, Config["repositories"][number]["sensitive_paths"], boolean][])("evaluation uses %s", async (name, override, ok) => {
    const cfg = config();
    cfg.policies = [{ ...global, exempt: name.includes("revoke") ? [alice] : [] }];
    cfg.repositories = [{ name: "owner/repo", ops: ["policy-check"], ...(override === undefined ? {} : { sensitive_paths: override }) }];
    const fetch = fakeFetch([
      { method: "GET", path: `${base}/pulls/12/commits`, body: [{ sha: head, commit: { verification: { verified: true } }, author: alice, committer: alice }] },
      { method: "GET", path: `${base}/pulls/12/files`, body: [{ filename: "global/file" }] },
      { method: "GET", path: `${base}/pulls/12/reviews`, body: [] },
    ]);
    const results = await evaluatePullPolicies({ server: github("token", fetch), config: cfg, repository: "owner/repo", pull });
    expect(results.at(-1)).toEqual({ type: "sensitive-paths", ok, problems: ok ? [] : ["sensitive paths need a trusted approver's /approve: global/file"] });
  });
});

test("each serialized full refresh reevaluates current facts even when the pinned head is unchanged", async () => {
  const commit = { sha: head, commit: { verification: { verified: true } }, author: { id: 10 }, committer: { id: 10 } };
  const fetch = fakeFetch([
    { method: "GET", path: `${base}/pulls/12/commits`, body: [commit], then: [[{ ...commit, commit: { verification: { verified: false } } }], [commit]] },
    { method: "GET", path: `${base}/pulls/12`, body: { state: "open", head: { sha: head } } },
    { method: "GET", path: `${base}/commits/${head}/check-runs`, body: [] },
    { method: "POST", path: `${base}/check-runs`, body: { id: 99 } },
    { method: "GET", path: `${base}/issues/12/comments`, body: [] },
    { method: "POST", path: `${base}/issues/12/comments`, body: { id: 100 } },
  ]);
  const context = { server: github("s", fetch), config: config(), repository: "owner/repo", serverRun, pull };
  for (let i = 0; i < 3; i++) await updatePolicyCheck(context);
  const checks = fetch.requests.filter((r) => r.method === "POST" && r.path === `${base}/check-runs`).map((r) => JSON.parse(r.body ?? "{}").conclusion);
  expect(checks).toEqual(["success", "failure", "success"]);
  expect(fetch.calls.filter((r) => r === `GET ${base}/pulls/12/commits`)).toHaveLength(3);
  expect(fetch.requests.filter((r) => r.method === "POST" && r.path === `${base}/issues/12/comments`)).toHaveLength(1);
});
