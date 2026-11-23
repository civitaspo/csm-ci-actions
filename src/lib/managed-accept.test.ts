import { expect, test } from "bun:test";
import type { ManagedPullAttestation } from "./managed-pull.ts";
import type { PolicyResult } from "./policies/index.ts";
import type { GitHub } from "./github.ts";
import { config } from "./testing.ts";
import { acceptManagedPull, type ManagedAcceptDependencies } from "./managed-accept.ts";

const repository = "owner/repo";
const head = "a".repeat(40);
const base = "b".repeat(40);
const attestation: ManagedPullAttestation = {
  repositoryId: 42, repository, pullNumber: 12, pullNodeId: "PR_node", baseRef: "main", baseSha: base, headSha: head,
  configSha: "c".repeat(40), releaseSha: "d".repeat(40), releaseVersion: "v1.2.3", manifestDigest: "e".repeat(64),
};
let reservationCalls: unknown[] = [];
let statusCalls: unknown[] = [];

function reset() {
  reservationCalls = [];
  statusCalls = [];
}

function dependencies(options: { policies?: PolicyResult[]; approved?: boolean; approvals?: boolean[]; attestations?: (ManagedPullAttestation | undefined)[] } = {}): Partial<ManagedAcceptDependencies> {
  const attestations = [...(options.attestations ?? [attestation, attestation])];
  const approvals = [...(options.approvals ?? [options.approved ?? true, options.approved ?? true])];
  return {
    derive: async () => attestations.shift(),
    evaluatePolicies: async () => options.policies ?? [],
    isApproved: async () => approvals.shift() ?? true,
    createReservation: async (args) => {
      reservationCalls.push(args);
      return { deploymentId: 77, nodeId: "DEP_77", createdAt: "2026-10-29T00:00:00Z", payload: args.payload, statuses: [], state: { kind: "active" as const } };
    },
    createStatus: async (args: unknown) => { statusCalls.push(args); },
  };
}

function context(options: { pull?: { state?: string; draft?: boolean; baseRef?: string; headSha?: string }; finalPull?: { state?: string; draft?: boolean; baseRef?: string; headSha?: string }; defaultBranch?: string | null; ops?: ("approve" | "merge" | "policy-check")[] } = {}) {
  let pullReads = 0;
  const pullData = (values: typeof options.pull) => ({
    number: 12, state: values?.state ?? "open", draft: values?.draft ?? false, user: { id: 10 }, head: { sha: values?.headSha ?? head, repo: { full_name: repository } },
    base: { ref: values?.baseRef ?? "main", repo: { full_name: repository, default_branch: "main" } },
  });
  const target = {
    rest: { pulls: { get: async () => {
      pullReads++;
      return { data: pullData(pullReads > 1 ? options.finalPull ?? options.pull : options.pull) };
    } } },
  };
  const source = { rest: { repos: { get: async () => ({ data: { default_branch: options.defaultBranch === undefined ? "main" : options.defaultBranch } }) } } };
  const baseConfig = config();
  const configured = options.ops ? { ...baseConfig, repositories: baseConfig.repositories.map((entry) => entry.name === "owner/*" ? { ...entry, ops: options.ops! } : entry) } : baseConfig;
  return {
    server: target as unknown as GitHub,
    deployments: {} as GitHub,
    config: configured,
    repository,
    managedSource: { source: source as unknown as GitHub, serverRepository: "owner/server", configSha: attestation.configSha, configPath: "csm-ci.yaml" },
    now: () => new Date("2026-10-29T00:00:00.000Z"),
    serverRunUrl: "https://github.com/owner/server/actions/runs/1",
    pullUrl: "https://github.com/owner/repo/pull/12",
  };
}

test("managed acceptance requires current passing policies before creating a reservation", async () => {
  reset();
  await expect(acceptManagedPull(context(), 12, dependencies({ policies: [{ type: "signed-commits", ok: false, problems: ["signature is invalid"] }] }))).rejects.toThrow("managed acceptance policy check failed: signed-commits: signature is invalid");
  expect(reservationCalls).toHaveLength(0);
});

test.each([
  ["closed", { state: "closed" }],
  ["draft", { draft: true }],
] as const)("rejects an initially %s managed pull", async (_name, pull) => {
  reset();
  await expect(acceptManagedPull(context({ pull }), 12, dependencies())).rejects.toThrow("managed pull #12 must be open and ready for review");
  expect(reservationCalls).toHaveLength(0);
});

test.each([
  ["approve", ["merge", "policy-check"]],
  ["policy-check", ["approve", "merge"]],
  ["merge", ["approve", "policy-check"]],
] as const)("requires the %s operation to be enabled", async (_missing, ops) => {
  reset();
  await expect(acceptManagedPull(context({ ops: [...ops] }), 12, dependencies())).rejects.toThrow("managed pull automatic completion requires approve, policy-check, and merge operations");
  expect(reservationCalls).toHaveLength(0);
});

test("requires an attestation for an enabled managed pull", async () => {
  reset();
  await expect(acceptManagedPull(context(), 12, dependencies({ attestations: [undefined] }))).rejects.toThrow("managed acceptance did not identify an enabled managed pull request");
  expect(reservationCalls).toHaveLength(0);
});

test("managed acceptance requires an approval pinned to the current head", async () => {
  reset();
  await expect(acceptManagedPull(context(), 12, dependencies({ approved: false }))).rejects.toThrow(`the configured approver has not approved managed head ${head}`);
  expect(reservationCalls).toHaveLength(0);
});

test("rechecks approval after the final provenance and pull read", async () => {
  reset();
  await expect(acceptManagedPull(context(), 12, dependencies({ approvals: [true, false] }))).rejects.toThrow(`the configured approver has not approved managed head ${head}`);
  expect(reservationCalls).toHaveLength(0);
});

test("managed acceptance rejects provenance that changes during the final recheck", async () => {
  reset();
  await expect(acceptManagedPull(context(), 12, dependencies({ attestations: [attestation, { ...attestation, headSha: "f".repeat(40) }] }))).rejects.toThrow("managed pull changed during acceptance; retry after revalidation");
  expect(reservationCalls).toHaveLength(0);
});

test.each([
  ["closed", { state: "closed" }],
  ["draft", { draft: true }],
  ["head", { headSha: "f".repeat(40) }],
  ["base ref", { baseRef: "stable" }],
] as const)("rejects a changed final pull %s", async (_name, finalPull) => {
  reset();
  await expect(acceptManagedPull(context({ finalPull }), 12, dependencies())).rejects.toThrow("managed pull changed during acceptance; retry after revalidation");
  expect(reservationCalls).toHaveLength(0);
});

test("requires a resolvable server default branch before creating a reservation", async () => {
  reset();
  await expect(acceptManagedPull(context({ defaultBranch: null }), 12, dependencies())).rejects.toThrow("managed acceptance cannot resolve the server default branch");
  expect(reservationCalls).toHaveLength(0);
});

test("managed acceptance pins the base and head and creates a retryable reservation", async () => {
  reset();
  const result = await acceptManagedPull(context(), 12, dependencies());
  expect(result.deploymentId).toBe(77);
  const args = reservationCalls[0] as { payload: Record<string, unknown>; defaultBranch: string };
  expect(args.defaultBranch).toBe("main");
  expect(args.payload).toMatchObject({
    version: 2,
    kind: "managed-files",
    accepted_base: base,
    accepted_head: head,
    configuration_sha: attestation.configSha,
    release_sha: attestation.releaseSha,
    release_version: attestation.releaseVersion,
    manifest_digest: attestation.manifestDigest,
    accepted_at: "2026-10-29T00:00:00.000Z",
    expires_at: "2026-11-05T00:00:00.000Z",
  });
  expect(args.payload.idempotency_key).toMatch(/^[0-9a-f]{64}$/u);
  expect(statusCalls).toHaveLength(1);
});

test("managed acceptance ignores a failing title and leaves it to merge readiness", async () => {
  reset();
  const titleFailure: PolicyResult = { type: "pull-request-title", ok: false, problems: ["title \"x\" is not a Conventional Commit header"] };
  await expect(acceptManagedPull(context(), 12, dependencies({ policies: [titleFailure], approved: false }))).rejects.toThrow(`the configured approver has not approved managed head ${head}`);
  await expect(acceptManagedPull(context(), 12, dependencies({ policies: [titleFailure, { type: "signed-commits", ok: false, problems: ["signature is invalid"] }] })))
    .rejects.toThrow("managed acceptance policy check failed: signed-commits: signature is invalid");
});
