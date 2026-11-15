import { expect, test } from "bun:test";
import type { PullFacts } from "./command.ts";
import { config, fakeFetch } from "./testing.ts";
import { github } from "./github.ts";
import { Rejection } from "./request.ts";

const repository = "owner/repo";
const head = "a".repeat(40);
const pull: PullFacts = { number: 12, state: "open", draft: false, headSha: head, headRepository: repository, baseRepository: repository, baseRef: "main", defaultBranch: "main", authorId: 10 };
const attestation = {
  repositoryId: 42, repository, pullNumber: 12, pullNodeId: "PR_node", baseRef: "main", baseSha: "b".repeat(40), headSha: head,
  configSha: "c".repeat(40), releaseSha: "d".repeat(40), releaseVersion: "v1.2.3", manifestDigest: "e".repeat(64),
};
let derive: () => Promise<typeof attestation | undefined> = async () => attestation;

const { evaluateManagedPullPolicies, evaluatePullPolicies } = await import("./policy-check.ts");
const { autoApprove, preflightManagedApproval, runApprove } = await import("./approve.ts");

function context(withManagedSource: boolean) {
  const cfg = config();
  cfg.policies = [{ type: "sensitive-paths", paths: ["**"], exempt: [] }];
  const serverFetch = fakeFetch([
    { method: "GET", path: `/repos/${repository}/pulls/12`, body: { number: 12, state: "open", draft: false, user: { id: 10 }, head: { sha: head, repo: { full_name: repository } }, base: { ref: "main", repo: { full_name: repository, default_branch: "main" } } } },
    { method: "GET", path: `/repos/${repository}/pulls/12/commits`, body: [{ sha: head, commit: { verification: { verified: true } }, author: { id: 10, login: "alice" }, committer: { id: 10, login: "alice" } }] },
    { method: "GET", path: `/repos/${repository}/commits/${head}/check-runs`, body: [] },
    { method: "GET", path: `/repos/${repository}/pulls/12/files`, body: [{ filename: "managed.yml" }] },
    { method: "GET", path: `/repos/${repository}/pulls/12/reviews`, body: [] },
    { method: "GET", path: `/repos/${repository}/issues/12/comments`, body: [] },
    { method: "POST", path: `/repos/${repository}/issues/12/comments`, body: { id: 100 } },
    { method: "GET", path: `/repos/${repository}/commits/${head}/check-runs`, body: [] },
    { method: "POST", path: `/repos/${repository}/check-runs`, body: { id: 99 } },
  ]);
  const gh = github("test", serverFetch);
  return {
    server: gh, serverFetch, config: cfg, repository, pull,
    ...(withManagedSource ? { managedSource: { source: gh, serverRepository: "owner/server", configSha: "c".repeat(40), configPath: "csm-ci.yaml" }, deriveManagedPull: () => derive() } : {}),
  };
}

test("a verified managed pull waives only sensitive-paths and leaves other policies unchanged", async () => {
  derive = async () => attestation;
  const ordinary = await evaluatePullPolicies(context(false));
  const managed = await evaluatePullPolicies(context(true));

  expect(managed.find((result) => result.type === "sensitive-paths")).toEqual({ type: "sensitive-paths", ok: true, problems: [] });
  expect(managed.find((result) => result.type === "managed-files")).toEqual({ type: "managed-files", ok: true, problems: [] });
  expect(managed.filter((result) => result.type !== "sensitive-paths" && result.type !== "managed-files")).toEqual(
    ordinary.filter((result) => result.type !== "sensitive-paths"),
  );
  expect(ordinary.find((result) => result.type === "sensitive-paths")?.ok).toBe(false);
});

test("a managed candidate that fails attestation keeps sensitive-paths enforced", async () => {
  derive = async () => { throw new Rejection("managed pull does not match the current trusted managed-file proposal"); };
  const results = await evaluatePullPolicies(context(true));

  expect(results.find((result) => result.type === "sensitive-paths")).toEqual({
    type: "sensitive-paths", ok: false, problems: ["sensitive paths need a trusted approver's /approve: managed.yml"],
  });
  expect(results.find((result) => result.type === "managed-files")).toEqual({
    type: "managed-files", ok: false, problems: ["managed pull does not match the current trusted managed-file proposal"],
  });
});

test("approval declines a managed candidate when attestation fails", async () => {
  derive = async () => { throw new Rejection("managed pull does not match the current trusted managed-file proposal"); };
  const ctx = {
    ...context(true),
    approver: github("approver", fakeFetch([])),
    serverRun: { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" },
    now: () => new Date("2026-10-24T12:00:00Z"),
  };

  expect(await runApprove(ctx, { pull_number: 12 })).toEqual({
    result: "declined", head, problems: [
      "sensitive-paths: sensitive paths need a trusted approver's /approve: managed.yml",
      "managed-files: managed pull does not match the current trusted managed-file proposal",
    ],
  });
});

test("managed approval preflight rejects before any server write or approver token is available", async () => {
  derive = async () => { throw new Rejection("managed pull does not match the current trusted managed-file proposal"); };
  const ctx = context(true);

  await expect(preflightManagedApproval(ctx, pull)).rejects.toThrow("managed pull does not match the current trusted managed-file proposal");
  expect(ctx.serverFetch.requests).toEqual([]);
});

test("managed approval preflight reuses its single derived attestation for policy evaluation", async () => {
  let deriveCalls = 0;
  derive = async () => {
    deriveCalls++;
    return attestation;
  };
  const ctx = context(true);

  expect(await preflightManagedApproval(ctx, pull)).toEqual({ head });
  expect(deriveCalls).toBe(1);
});

test("managed policy evaluation derives once and returns its result without accepting an attestation input", async () => {
  let deriveCalls = 0;
  derive = async () => {
    deriveCalls++;
    return attestation;
  };
  const result = await evaluateManagedPullPolicies(context(true));

  expect(result.kind).toBe("attested");
  expect(result.kind === "attested" ? result.attestation : undefined).toEqual(attestation);
  expect(result.results.find((item) => item.type === "managed-files")).toEqual({ type: "managed-files", ok: true, problems: [] });
  expect(deriveCalls).toBe(1);
});

test("managed approval revalidates provenance after policy evaluation and before creating the review", async () => {
  const attestations = [attestation, { ...attestation, releaseVersion: "v1.2.4" }];
  derive = async () => attestations.shift();
  const ctx = context(true);
  const approverFetch = fakeFetch([]);
  const approvalContext = {
    ...ctx,
    approver: github("approver", approverFetch),
    serverRun: { serverUrl: "https://github.com", repository: "owner/server", id: "345", attempt: "2" },
    now: () => new Date("2026-10-24T12:00:00Z"),
  };

  await expect(autoApprove(approvalContext, pull)).rejects.toThrow("managed pull changed during approval; retry after revalidation");
  expect(approverFetch.requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls/12/reviews"))).toBe(false);
});
