import { expect, mock, test } from "bun:test";
import type { ManagedPullAttestation } from "./managed-pull.ts";
import type { PolicyResult } from "./policies/index.ts";
import type { GitHub } from "./github.ts";
import { config } from "./testing.ts";
import type { ManagedAcceptDependencies } from "./managed-accept.ts";

const repository = "owner/repo";
const head = "a".repeat(40);
const attestation: ManagedPullAttestation = {
  repositoryId: 42,
  repository,
  pullNumber: 12,
  pullNodeId: "PR_node",
  baseRef: "main",
  baseSha: "b".repeat(40),
  headSha: head,
  configSha: "c".repeat(40),
  releaseSha: "d".repeat(40),
  releaseVersion: "v1.2.3",
  manifestDigest: "e".repeat(64),
};

let results: PolicyResult[] = [];
let finalAttestation: ManagedPullAttestation | undefined = attestation;
let policyEvaluationCalls = 0;
let finalDerivationCalls = 0;
let reservationCalls = 0;

mock.module("./policy-check.ts", () => ({
  approverApprovedHead: async () => true,
  evaluateManagedPullPolicies: async () => {
    policyEvaluationCalls++;
    return { kind: "attested", attestation, results };
  },
  evaluatePullPolicies: async () => {
    throw new Error("managed acceptance must use its combined production policy evaluator");
  },
}));
mock.module("./managed-pull-context.ts", () => ({
  deriveManagedPullAttestation: async () => {
    finalDerivationCalls++;
    return finalAttestation;
  },
}));

const { acceptManagedPull } = await import("./managed-accept.ts");

function reset(options: { policies?: PolicyResult[]; final?: ManagedPullAttestation | undefined } = {}) {
  results = options.policies ?? [];
  finalAttestation = options.final === undefined ? attestation : options.final;
  policyEvaluationCalls = 0;
  finalDerivationCalls = 0;
  reservationCalls = 0;
}

function context() {
  let pullReads = 0;
  const target = {
    rest: {
      pulls: {
        get: async () => {
          pullReads++;
          return { data: {
            number: 12,
            state: "open",
            draft: false,
            user: { id: 10 },
            head: { sha: head, repo: { full_name: repository } },
            base: { ref: "main", repo: { full_name: repository, default_branch: "main" } },
          } };
        },
      },
    },
  };
  const source = { rest: { repos: { get: async () => ({ data: { default_branch: "main" } }) } } };
  return {
    server: target as unknown as GitHub,
    deployments: {} as GitHub,
    config: config(),
    repository,
    managedSource: { source: source as unknown as GitHub, serverRepository: "owner/server", configSha: attestation.configSha, configPath: "csm-ci.yaml" },
    now: () => new Date("2026-10-29T00:00:00.000Z"),
    serverRunUrl: "https://github.com/owner/server/actions/runs/1",
    pullUrl: "https://github.com/owner/repo/pull/12",
  };
}

function writeDependencies() {
  return {
    createReservation: async (args: Parameters<ManagedAcceptDependencies["createReservation"]>[0]) => {
      reservationCalls++;
      return { deploymentId: 77, nodeId: "DEP_77", createdAt: "2026-10-29T00:00:00Z", payload: args.payload, statuses: [], state: { kind: "active" as const } };
    },
    createStatus: async () => {},
  };
}

test("production managed acceptance evaluates once and creates a reservation after final revalidation", async () => {
  reset();

  const reservation = await acceptManagedPull(context(), 12, writeDependencies());

  expect(reservation.deploymentId).toBe(77);
  expect(policyEvaluationCalls).toBe(1);
  expect(finalDerivationCalls).toBe(1);
  expect(reservationCalls).toBe(1);
});

test.each(["policy failure", "release version drift"] as const)("production managed acceptance rejects %s before reserving", async (scenario) => {
  const changedRelease = scenario === "release version drift" ? { ...attestation, releaseVersion: "v9.9.9" } : attestation;
  const policies: PolicyResult[] = scenario === "policy failure"
    ? [{ type: "signed-commits", ok: false, problems: ["signature is invalid"] }]
    : [];
  reset({ policies, final: scenario === "release version drift" ? changedRelease : attestation });

  await expect(acceptManagedPull(context(), 12, writeDependencies())).rejects.toThrow(
    scenario === "policy failure"
      ? "managed acceptance policy check failed: signed-commits: signature is invalid"
      : "managed pull changed during acceptance; retry after revalidation",
  );

  expect(policyEvaluationCalls).toBe(1);
  expect(reservationCalls).toBe(0);
  expect(finalDerivationCalls).toBe(scenario === "policy failure" ? 0 : 1);
});
