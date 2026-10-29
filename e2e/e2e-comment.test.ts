import { afterEach, describe, expect, test } from "bun:test";
import { FEATURES } from "./pr-metadata.ts";
import { authorize, chooseHarness, parseCommand, report, type Command } from "./e2e-comment.ts";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";

describe("parseCommand", () => {
  test.each<[string, Command]>([
    ["/e2e --feature smoke", { features: ["smoke"], scenario: "" }],
    ["/e2e --feature merge,smoke,merge\n", { features: ["merge", "smoke"], scenario: "" }],
    ["/e2e --feature merge --scenario a head change while /merge waits  ", { features: ["merge"], scenario: "a head change while /merge waits" }],
  ])("accepts %j", (body, command) => {
    expect(parseCommand(body)).toEqual({ ok: true, command });
  });

  const syntax = "the comment must be exactly `/e2e --feature <feature>[,<feature>...] [--scenario <name substring>]`.";
  test.each([
    ["/e2e merge", syntax],
    ["/e2e", syntax],
    ["/e2e --feature", syntax],
    ["/e2e --feature merge --scenario", syntax],
    ["/e2e --feature merge\nsecond line", syntax],
    ["/e2e --feature merge --scenario x\ny", syntax],
    ["/e2e --feature Merge", syntax],
    [`/e2e --feature merge --scenario ${"x".repeat(201)}`, syntax],
    ["/e2e --feature nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
    ["/e2e --feature merge,nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
  ])("rejects %j", (body, error) => {
    expect(parseCommand(body)).toEqual({ ok: false, error });
  });
});

describe("deployment reporting", () => {
  const repo = "/repos/owner/repo";
  const runUrl = "https://github.com/owner/repo/actions/runs/42";
  const env = { REPO: "owner/repo", PR: "12", COMMENT_ID: "34", COMMENTER_ID: "4525500", BODY: "/e2e --feature smoke", RUN_URL: runUrl, DEPLOYMENT_ID: "56", REF: "pr-head", FEATURE: "smoke", HARNESS: "main" };
  const originalEnv = { ...process.env };
  afterEach(() => {
    for (const key of [...Object.keys(env), "RESULT"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test("creates an in-progress deployment for the authorized PR head", async () => {
    Object.assign(process.env, env);
    const api = fakeFetch([
      { method: "GET", path: `${repo}/pulls/12`, body: { state: "open", head: { sha: "pr-head", repo: { full_name: "owner/repo" } } } },
      { method: "GET", path: `${repo}/pulls/12/commits`, body: [{ commit: { verification: { verified: true } }, author: { id: 4525500 } }] },
      { method: "POST", path: `${repo}/issues/comments/34/reactions`, body: {} },
      { method: "POST", path: `${repo}/issues/12/comments`, body: {} },
      { method: "POST", path: `${repo}/deployments`, body: { id: 56 } },
      { method: "POST", path: `${repo}/deployments/56/statuses`, body: {} },
    ]);
    await authorize(github("token", api));
    const create = api.requests.find((request) => request.path === `${repo}/deployments`);
    expect(JSON.parse(create!.body!)).toMatchObject({ ref: "pr-head", environment: "csm-ci-e2e", auto_merge: false, required_contexts: [], production_environment: false });
    const status = api.requests.find((request) => request.path.endsWith("/statuses"));
    expect(JSON.parse(status!.body!)).toMatchObject({ state: "in_progress", log_url: runUrl, auto_inactive: false });
  });

  test.each(["unauthorized", "invalid", "closed"])("does not create a deployment when %s", async (reason) => {
    Object.assign(process.env, env, { COMMENTER_ID: reason === "unauthorized" ? "1" : env.COMMENTER_ID, BODY: reason === "invalid" ? "/e2e" : env.BODY });
    const api = fakeFetch([
      { method: "GET", path: `${repo}/pulls/12`, body: { state: "closed" } },
      { method: "POST", path: `${repo}/issues/12/comments`, body: {} },
    ]);
    await authorize(github("token", api));
    expect(api.calls).not.toContain(`POST ${repo}/deployments`);
  });

  test("fails when GitHub does not create a deployment", async () => {
    Object.assign(process.env, env);
    const api = fakeFetch([
      { method: "GET", path: `${repo}/pulls/12`, body: { state: "open", head: { sha: "pr-head", repo: { full_name: "owner/repo" } } } },
      { method: "GET", path: `${repo}/pulls/12/commits`, body: [] },
      { method: "POST", path: `${repo}/issues/comments/34/reactions`, body: {} },
      { method: "POST", path: `${repo}/issues/12/comments`, body: {} },
      { method: "POST", path: `${repo}/deployments`, status: 202, body: { message: "deployment pending" } },
    ]);
    await expect(authorize(github("token", api))).rejects.toThrow("deployment was not created: deployment pending");
  });

  test.each([["success", "success"], ["failure", "failure"], ["cancelled", "error"]])("reports %s with a link to the run", async (result, state) => {
    Object.assign(process.env, env, { RESULT: result });
    const api = fakeFetch([
      { method: "POST", path: `${repo}/issues/comments/34/reactions`, body: {} },
      { method: "POST", path: `${repo}/issues/12/comments`, body: {} },
      { method: "POST", path: `${repo}/deployments/56/statuses`, body: {} },
    ]);
    await report(github("token", api));
    const status = api.requests.find((request) => request.path.endsWith("/statuses"));
    expect(JSON.parse(status!.body!)).toMatchObject({ state, description: `e2e ${result}`, log_url: runUrl, auto_inactive: false });
    const comment = api.requests.find((request) => request.path === `${repo}/issues/12/comments`);
    expect(JSON.parse(comment!.body!).body).toContain(runUrl);
  });

  test("updates the deployment even if the PR notification fails", async () => {
    Object.assign(process.env, env, { RESULT: "failure" });
    const api = fakeFetch([
      { method: "POST", path: `${repo}/issues/comments/34/reactions`, status: 403, body: { message: "denied" } },
      { method: "POST", path: `${repo}/deployments/56/statuses`, body: {} },
    ]);
    await expect(report(github("token", api))).rejects.toThrow();
    expect(api.calls).toContain(`POST ${repo}/deployments/56/statuses`);
  });
});

describe("chooseHarness", () => {
  const ok = { verified: true, authorId: 1 };
  const input = { repository: "o/r", headRepository: "o/r", commits: [ok, ok], ownerId: 1 };
  test.each([
    ["own verified commits on a branch of this repository", input, "pr"],
    ["a fork", { ...input, headRepository: "x/r" }, "main"],
    ["a deleted head repository", { ...input, headRepository: undefined }, "main"],
    ["an unverified commit", { ...input, commits: [ok, { verified: false, authorId: 1 }] }, "main"],
    ["another author", { ...input, commits: [ok, { verified: true, authorId: 2 }] }, "main"],
    ["an author without an account", { ...input, commits: [{ verified: true, authorId: undefined }] }, "main"],
    ["no commits", { ...input, commits: [] }, "main"],
  ] as const)("%s", (_name, args, harness) => {
    expect(chooseHarness(args)).toBe(harness);
  });
});
