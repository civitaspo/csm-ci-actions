import { repositoryEntry, type Config, type Policy } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { evaluatePolicies, type PolicyResult } from "./policies/index.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";
import type { PullFacts } from "./command.ts";
import { publishPolicyReport } from "./policy-report.ts";
import type { ServerRun } from "./notify.ts";
import { deriveManagedPullAttestation, type ManagedPullSourceContext } from "./managed-pull-context.ts";
import type { ManagedPullAttestation } from "./managed-pull.ts";
import { Rejection } from "./request.ts";

const ALWAYS: Policy[] = [{ type: "signed-commits" }, { type: "trusted-committers" }];
export type PolicyCheckContext = { server: GitHub; config: Config; repository: string; pull: PullFacts; managedSource?: ManagedPullSourceContext; deriveManagedPull?: typeof deriveManagedPullAttestation };
type PublicationContext = PolicyCheckContext & { serverRun: ServerRun; requestKind?: "approve" | "policy-check"; requestCommentId?: number };
export type ManagedPullPolicyEvaluation =
  | { kind: "attested"; attestation: ManagedPullAttestation; results: PolicyResult[] }
  | { kind: "not-managed"; results: PolicyResult[] }
  | { kind: "rejected"; reason: string; results: PolicyResult[] };
export type ManagedPolicyRejectionMode = "throw" | "report";

export function effectivePolicies(config: Config, repository: string): Policy[] {
  const override = repositoryEntry(config, repository)?.sensitive_paths;
  const configured = config.policies.filter((policy) => !ALWAYS.some((always) => always.type === policy.type)).map((policy): Policy => {
    if (policy.type !== "sensitive-paths") return policy;
    return { type: "sensitive-paths", paths: override?.paths ?? policy.paths, exempt: override?.exempt ?? policy.exempt };
  });
  if (!configured.some((policy) => policy.type === "sensitive-paths") && override !== undefined) {
    configured.push({ type: "sensitive-paths", paths: override?.paths ?? [], exempt: override?.exempt ?? [] });
  }
  return [...ALWAYS, ...configured];
}

async function evaluatePoliciesWithManagedState(
  ctx: PolicyCheckContext,
  trust: ReturnType<typeof evaluateTrust>,
  managedAttestation?: ManagedPullAttestation,
  managedFailure?: string,
  commandApproval?: { commentId: number; authorId: number; head: string },
): Promise<PolicyResult[]> {
  const policies = effectivePolicies(ctx.config, ctx.repository);
  const policyContext = {
    trust, gh: ctx.server, config: ctx.config, repository: ctx.repository,
    pullNumber: ctx.pull.number, head: ctx.pull.headSha, authorId: ctx.pull.authorId,
    ...(commandApproval ? { commandApproval } : {}),
  };
  const results = await evaluatePolicies(policies.filter((policy) => !(managedAttestation && policy.type === "sensitive-paths")), policyContext);
  if (managedAttestation) {
    if (policies.some((policy) => policy.type === "sensitive-paths")) results.push({ type: "sensitive-paths", ok: true, problems: [] });
    results.push({ type: "managed-files", ok: true, problems: [] });
  } else if (managedFailure) {
    results.push({ type: "managed-files", ok: false, problems: [managedFailure] });
  }
  return results;
}

export async function evaluateManagedPullPolicies(
  ctx: PolicyCheckContext,
  rejectionMode: ManagedPolicyRejectionMode = "throw",
  commandApproval?: { commentId: number; authorId: number; head: string },
): Promise<ManagedPullPolicyEvaluation> {
  if (!ctx.managedSource) throw new Rejection("managed policy evaluation is missing trusted server provenance");
  let attestation: ManagedPullAttestation | undefined;
  let failure: string | undefined;
  try {
    attestation = await (ctx.deriveManagedPull ?? deriveManagedPullAttestation)({ ...ctx.managedSource, target: ctx.server, repository: ctx.repository, pullNumber: ctx.pull.number });
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    if (rejectionMode !== "report") throw error;
    failure = error.message;
  }
  const trust = evaluateTrust(await fetchCommitFacts(ctx.server, ctx.repository, ctx.pull.number), ctx.pull.headSha, ctx.config);
  const results = await evaluatePoliciesWithManagedState(ctx, trust, attestation, failure, commandApproval);
  if (failure) return { kind: "rejected", reason: failure, results };
  if (attestation) return { kind: "attested", attestation, results };
  return { kind: "not-managed", results };
}

export async function evaluatePullPolicies(ctx: PolicyCheckContext, commandApproval?: { commentId: number; authorId: number; head: string }): Promise<PolicyResult[]> {
  const trust = evaluateTrust(await fetchCommitFacts(ctx.server, ctx.repository, ctx.pull.number), ctx.pull.headSha, ctx.config);
  let managedAttestation: ManagedPullAttestation | undefined;
  let managedFailure: string | undefined;
  if (ctx.managedSource) {
    try {
      managedAttestation = await (ctx.deriveManagedPull ?? deriveManagedPullAttestation)({ ...ctx.managedSource, target: ctx.server, repository: ctx.repository, pullNumber: ctx.pull.number });
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      managedFailure = error.message;
    }
  }
  return evaluatePoliciesWithManagedState(ctx, trust, managedAttestation, managedFailure, commandApproval);
}

export async function approverApprovedHead(server: GitHub, config: Config, repository: string, pull: PullFacts): Promise<boolean> {
  const reviews = await server.paginate(server.rest.pulls.listReviews, { ...splitRepository(repository), pull_number: pull.number, per_page: 100 });
  const latest = reviews.filter((r) => Number(r.user?.id) === config.approver.id && r.submitted_at)
    .reduce<(typeof reviews)[number] | undefined>((current, review) => {
      if (!current || String(review.submitted_at) > String(current.submitted_at)) return review;
      return String(review.submitted_at) === String(current.submitted_at) && Number(review.id) > Number(current.id) ? review : current;
    }, undefined);
  return latest?.state === "APPROVED" && latest.commit_id === pull.headSha;
}

export function policySummary(results: readonly PolicyResult[]): string {
  const escapeCell = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "&#92;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("~", "&#126;")
    .replaceAll("!", "&#33;")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const rows = results.map((r) => `| ${escapeCell(r.type)} | ${r.ok ? "pass" : "fail"} | ${escapeCell(r.problems.length ? r.problems.join("; ") : "—")} |`);
  return ["| Policy | Result | Details |", "| --- | --- | --- |", ...rows].join("\n");
}

export type PolicyCheckOutcome =
  | { result: "published"; results: PolicyResult[] }
  | { result: "skipped"; reason: string };

export async function updatePolicyCheck(ctx: PublicationContext): Promise<PolicyCheckOutcome> {
  if (ctx.pull.state !== "open") return { result: "skipped", reason: `#${ctx.pull.number} is closed` };
  const { owner, repo } = splitRepository(ctx.repository);
  const checkRuns = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { owner, repo, ref: ctx.pull.headSha, per_page: 100 });
  const existing = checkRuns.find((c) => c.name === "csm-ci/policy" && c.external_id === ctx.pull.headSha && Number(c.app?.id) === ctx.config.apps.server_app_id);
  const { data: current } = await ctx.server.rest.pulls.get({ owner, repo, pull_number: ctx.pull.number });
  if (current.state !== "open") return { result: "skipped", reason: `#${ctx.pull.number} closed before policy publication` };
  if (current.head.sha !== ctx.pull.headSha) return { result: "skipped", reason: `#${ctx.pull.number} head moved before policy publication` };
  // Read provenance and all policy inputs after confirming the pinned head, close to publication.
  const policies = await evaluatePullPolicies(ctx);
  const approved = await approverApprovedHead(ctx.server, ctx.config, ctx.repository, ctx.pull);
  const results: PolicyResult[] = [...policies, { type: "approval", ok: approved, problems: approved ? [] : [`${ctx.config.approver.login} has not approved head ${ctx.pull.headSha}`] }];
  const ok = results.every((r) => r.ok);
  const summary = policySummary(results);
  const output = { title: ok ? "Policies passed" : "Policies failed", summary };
  const completedAt = new Date().toISOString();
  const { data: final } = await ctx.server.rest.pulls.get({ owner, repo, pull_number: ctx.pull.number });
  if (final.state !== "open") return { result: "skipped", reason: `#${ctx.pull.number} closed before policy publication` };
  if (final.head.sha !== ctx.pull.headSha) return { result: "skipped", reason: `#${ctx.pull.number} head moved before policy publication` };
  if (existing) {
    await ctx.server.rest.checks.update({ owner, repo, check_run_id: Number(existing.id), name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", completed_at: completedAt, conclusion: ok ? "success" : "failure", output });
  } else {
    await ctx.server.rest.checks.create({ owner, repo, name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", completed_at: completedAt, conclusion: ok ? "success" : "failure", output });
  }
  await publishPolicyReport({ server: ctx.server, repository: ctx.repository, pullNumber: ctx.pull.number, head: ctx.pull.headSha, serverBotId: ctx.config.apps.server_bot_id, serverRun: ctx.serverRun, requestKind: ctx.requestKind ?? "policy-check", ...(ctx.requestCommentId === undefined ? {} : { requestCommentId: ctx.requestCommentId }) }, policies);
  return { result: "published", results };
}

export async function runPolicyCheck(ctx: PublicationContext): Promise<PolicyCheckOutcome> {
  return updatePolicyCheck(ctx);
}
