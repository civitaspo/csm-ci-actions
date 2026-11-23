import { createHash } from "node:crypto";
import { repositoryEntry, type Config } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { createManagedReservation, createReservationStatus, type ReservationRecord } from "./automerge-github.ts";
import { approverApprovedHead, evaluateManagedPullPolicies, evaluatePullPolicies } from "./policy-check.ts";
import { deriveManagedPullAttestation, type ManagedPullSourceContext } from "./managed-pull-context.ts";
import type { PullFacts } from "./command.ts";
import { approvalDecisionResults, type PolicyResult } from "./policies/index.ts";
import type { ManagedPullAttestation } from "./managed-pull.ts";
import { Rejection } from "./request.ts";

export type ManagedAcceptContext = {
  /** Target-scoped Server App read client. */
  server: GitHub;
  /** Server repository Deployments:write client. */
  deployments: GitHub;
  config: Config;
  repository: string;
  managedSource: ManagedPullSourceContext;
  now: () => Date;
  serverRunUrl: string;
  pullUrl: string;
};

export type ManagedAcceptDependencies = {
  derive: () => Promise<ManagedPullAttestation | undefined>;
  evaluatePolicies: () => Promise<PolicyResult[]>;
  isApproved: () => Promise<boolean>;
  createReservation: typeof createManagedReservation;
  createStatus: typeof createReservationStatus;
};

/**
 * Revalidates an authorized managed PR and creates its durable merge reservation.
 * Required checks may still be pending; the shared evaluator owns waiting and merge.
 */
export async function acceptManagedPull(ctx: ManagedAcceptContext, pullNumber: number, dependencies?: Partial<ManagedAcceptDependencies>): Promise<ReservationRecord> {
  const derive = dependencies?.derive ?? (() => deriveManagedPullAttestation({ ...ctx.managedSource, target: ctx.server, repository: ctx.repository, pullNumber }));
  const evaluatePolicies = dependencies?.evaluatePolicies ?? (() => evaluatePullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull, managedSource: ctx.managedSource }));
  const isApproved = dependencies?.isApproved ?? (() => approverApprovedHead(ctx.server, ctx.config, ctx.repository, pull));
  const createReservation = dependencies?.createReservation ?? createManagedReservation;
  const createStatus = dependencies?.createStatus ?? createReservationStatus;
  const pull = await fetchManagedPull(ctx.server, ctx.repository, pullNumber);
  if (pull.state !== "open" || pull.draft) throw new Rejection(`managed pull #${pullNumber} must be open and ready for review`);
  const entry = repositoryEntry(ctx.config, ctx.repository);
  if (!entry?.ops.includes("approve") || !entry.ops.includes("policy-check") || !entry.ops.includes("merge")) {
    throw new Rejection("managed pull automatic completion requires approve, policy-check, and merge operations");
  }

  let first: ManagedPullAttestation | undefined;
  let results: PolicyResult[];
  if (dependencies?.derive || dependencies?.evaluatePolicies) {
    first = await derive();
    results = await evaluatePolicies();
  } else {
    const evaluation = await evaluateManagedPullPolicies({ server: ctx.server, config: ctx.config, repository: ctx.repository, pull, managedSource: ctx.managedSource });
    if (evaluation.kind === "rejected") throw new Rejection(evaluation.reason);
    if (evaluation.kind === "not-managed") throw new Rejection("managed acceptance did not identify an enabled managed pull request");
    first = evaluation.attestation;
    results = evaluation.results;
  }
  if (!first) throw new Rejection("managed acceptance did not identify an enabled managed pull request");
  const failures = approvalDecisionResults(results).filter((result) => !result.ok).flatMap((result) => result.problems.map((problem) => `${result.type}: ${problem}`));
  if (failures.length) throw new Rejection(`managed acceptance policy check failed: ${failures.join("; ")}`);
  if (!(await isApproved())) {
    throw new Rejection(`the configured approver has not approved managed head ${pull.headSha}`);
  }

  const { data: serverRepository } = await ctx.managedSource.source.rest.repos.get(splitRepository(ctx.managedSource.serverRepository));
  if (!serverRepository.default_branch) throw new Rejection("managed acceptance cannot resolve the server default branch");

  // Re-read both provenance and the review pin immediately before the server-side write.
  const [attestation, current] = await Promise.all([derive(), fetchManagedPull(ctx.server, ctx.repository, pullNumber)]);
  if (!attestation || !sameAttestation(first, attestation) || current.state !== "open" || current.draft || current.headSha !== pull.headSha || current.baseRef !== pull.baseRef) {
    throw new Rejection("managed pull changed during acceptance; retry after revalidation");
  }
  if (!(await isApproved())) {
    throw new Rejection(`the configured approver has not approved managed head ${current.headSha}`);
  }

  const acceptedAt = ctx.now();
  const acceptedAtIso = acceptedAt.toISOString();
  const identity = {
    repository_id: attestation.repositoryId,
    repository: attestation.repository.toLowerCase(),
    pull_number: attestation.pullNumber,
    pull_node_id: attestation.pullNodeId,
    base_ref: attestation.baseRef,
    accepted_base: attestation.baseSha,
    accepted_head: attestation.headSha,
    configuration_sha: attestation.configSha,
    release_version: attestation.releaseVersion,
    release_sha: attestation.releaseSha,
    manifest_digest: attestation.manifestDigest,
  };
  const idempotencyKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const payload = {
    version: 2 as const,
    kind: "managed-files" as const,
    ...identity,
    managed_ref: "csm-ci/repo-settings" as const,
    idempotency_key: idempotencyKey,
    accepted_at: acceptedAtIso,
    expires_at: new Date(acceptedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const reservation = await createReservation({
    server: ctx.deployments,
    serverRepository: ctx.managedSource.serverRepository,
    defaultBranch: serverRepository.default_branch,
    serverBotId: ctx.config.apps.server_bot_id,
    payload,
    serverRunUrl: ctx.serverRunUrl,
    pullUrl: ctx.pullUrl,
  });
  if (reservation.state.kind === "active" && reservation.statuses.length === 0) {
    await createStatus({
      server: ctx.deployments,
      serverRepository: ctx.managedSource.serverRepository,
      serverBotId: ctx.config.apps.server_bot_id,
      deploymentId: reservation.deploymentId,
      serverRunUrl: ctx.serverRunUrl,
      pullUrl: ctx.pullUrl,
      state: "queued",
      description: "accepted managed-file proposal; evaluator checks approval, policies, and required checks",
    });
  }
  return reservation;
}

async function fetchManagedPull(gh: GitHub, repository: string, pullNumber: number): Promise<PullFacts> {
  const { data: pull } = await gh.rest.pulls.get({ ...splitRepository(repository), pull_number: pullNumber });
  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft === true,
    headSha: pull.head.sha,
    headRepository: pull.head.repo?.full_name ?? null,
    baseRepository: pull.base.repo.full_name,
    baseRef: pull.base.ref,
    defaultBranch: pull.base.repo.default_branch,
    authorId: Number(pull.user.id),
    title: pull.title,
  };
}

function sameAttestation(a: Awaited<ReturnType<typeof deriveManagedPullAttestation>>, b: Awaited<ReturnType<typeof deriveManagedPullAttestation>>): boolean {
  return !!a && !!b && a.repositoryId === b.repositoryId && a.repository === b.repository && a.pullNumber === b.pullNumber &&
    a.pullNodeId === b.pullNodeId && a.baseRef === b.baseRef && a.baseSha === b.baseSha && a.headSha === b.headSha &&
    a.configSha === b.configSha && a.releaseSha === b.releaseSha && a.releaseVersion === b.releaseVersion && a.manifestDigest === b.manifestDigest;
}
