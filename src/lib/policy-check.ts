import { repositoryEntry, type Config, type Policy } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { evaluatePolicies, type PolicyResult } from "./policies/index.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";
import type { PullFacts } from "./command.ts";
import { publishPolicyReport } from "./policy-report.ts";
import type { ServerRun } from "./notify.ts";

const ALWAYS: Policy[] = [{ type: "signed-commits" }, { type: "trusted-committers" }];
export type PolicyCheckContext = { server: GitHub; config: Config; repository: string; pull: PullFacts };
type PublicationContext = PolicyCheckContext & { serverRun: ServerRun; requestKind?: "approve" | "policy-check"; requestCommentId?: number };

export function effectivePolicies(config: Config, repository: string): Policy[] {
  const override = repositoryEntry(config, repository)?.sensitive_paths;
  const protectedRepository = repository.toLowerCase() === config.server_repository || repository.toLowerCase() === "civitaspo/csm-ci-actions";
  const configured = config.policies.filter((policy) => !ALWAYS.some((always) => always.type === policy.type)).map((policy): Policy => {
    if (policy.type !== "sensitive-paths") return policy;
    return { type: "sensitive-paths", paths: override?.paths ?? policy.paths, exempt: override?.exempt ?? policy.exempt };
  });
  if (!configured.some((policy) => policy.type === "sensitive-paths") && (override !== undefined || protectedRepository)) {
    configured.push({ type: "sensitive-paths", paths: override?.paths ?? [], exempt: override?.exempt ?? [] });
  }
  return [...ALWAYS, ...configured];
}

export async function evaluatePullPolicies(ctx: PolicyCheckContext, commandApproval?: { commentId: number; authorId: number; head: string }): Promise<PolicyResult[]> {
  const trust = evaluateTrust(await fetchCommitFacts(ctx.server, ctx.repository, ctx.pull.number), ctx.pull.headSha, ctx.config);
  const policies = effectivePolicies(ctx.config, ctx.repository);
  return evaluatePolicies(policies, {
    trust, gh: ctx.server, config: ctx.config, repository: ctx.repository,
    pullNumber: ctx.pull.number, head: ctx.pull.headSha, authorId: ctx.pull.authorId,
    ...(commandApproval ? { commandApproval } : {}),
  });
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
  const results = await evaluatePullPolicies(ctx);
  const ok = results.every((r) => r.ok);
  const summary = policySummary(results);
  const completedAt = new Date().toISOString();
  const checkRuns = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { owner, repo, ref: ctx.pull.headSha, per_page: 100 });
  const existing = checkRuns.find((c) => c.name === "csm-ci/policy" && c.external_id === ctx.pull.headSha && Number(c.app?.id) === ctx.config.apps.server_app_id);
  const output = { title: ok ? "Policies passed" : "Policies failed", summary };
  const { data: current } = await ctx.server.rest.pulls.get({ owner, repo, pull_number: ctx.pull.number });
  if (current.state !== "open") return { result: "skipped", reason: `#${ctx.pull.number} closed before policy publication` };
  if (current.head.sha !== ctx.pull.headSha) return { result: "skipped", reason: `#${ctx.pull.number} head moved before policy publication` };
  if (existing) {
    await ctx.server.rest.checks.update({ owner, repo, check_run_id: Number(existing.id), name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", completed_at: completedAt, conclusion: ok ? "success" : "failure", output });
  } else {
    await ctx.server.rest.checks.create({ owner, repo, name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", completed_at: completedAt, conclusion: ok ? "success" : "failure", output });
  }
  await publishPolicyReport({ server: ctx.server, repository: ctx.repository, pullNumber: ctx.pull.number, head: ctx.pull.headSha, serverBotId: ctx.config.apps.server_bot_id, serverRun: ctx.serverRun, requestKind: ctx.requestKind ?? "policy-check", ...(ctx.requestCommentId === undefined ? {} : { requestCommentId: ctx.requestCommentId }) }, results);
  return { result: "published", results };
}

export async function runPolicyCheck(ctx: PublicationContext): Promise<PolicyCheckOutcome> {
  return updatePolicyCheck(ctx);
}
