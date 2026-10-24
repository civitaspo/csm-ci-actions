import type { Config, Policy } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { evaluatePolicies, type PolicyResult } from "./policies/index.ts";
import { evaluateTrust, fetchCommitFacts } from "./trust.ts";
import type { PullFacts } from "./command.ts";

const ALWAYS: Policy[] = [{ type: "signed-commits" }, { type: "trusted-committers" }];
export type PolicyCheckContext = { server: GitHub; config: Config; repository: string; pull: PullFacts };

export async function evaluatePullPolicies(ctx: PolicyCheckContext, commandApproval?: { commentId: number; authorId: number; head: string }): Promise<PolicyResult[]> {
  const trust = evaluateTrust(await fetchCommitFacts(ctx.server, ctx.repository, ctx.pull.number), ctx.pull.headSha, ctx.config);
  const protectedRepository = ctx.repository.toLowerCase() === ctx.config.server_repository || ctx.repository.toLowerCase() === "civitaspo/csm-ci-actions";
  const hasSensitivePaths = ctx.config.policies.some((p) => p.type === "sensitive-paths");
  const configured = [...ctx.config.policies.filter((p) => !ALWAYS.some((a) => a.type === p.type))];
  if (protectedRepository && !hasSensitivePaths) configured.push({ type: "sensitive-paths", paths: ["**"], exempt: [] });
  const policies = [...ALWAYS, ...configured];
  return evaluatePolicies(policies, {
    trust, gh: ctx.server, config: ctx.config, repository: ctx.repository,
    pullNumber: ctx.pull.number, head: ctx.pull.headSha, authorId: ctx.pull.authorId,
    ...(commandApproval ? { commandApproval } : {}),
  });
}

export function policySummary(results: readonly PolicyResult[]): string {
  const rows = results.map((r) => `| ${r.type} | ${r.ok ? "pass" : "fail"} | ${r.problems.length ? r.problems.join("; ").replaceAll("|", "\\|") : "—"} |`);
  return ["| Policy | Result | Details |", "| --- | --- | --- |", ...rows].join("\n");
}

export async function updatePolicyCheck(ctx: PolicyCheckContext): Promise<PolicyResult[]> {
  const { owner, repo } = splitRepository(ctx.repository);
  const results = await evaluatePullPolicies(ctx);
  const ok = results.every((r) => r.ok);
  const summary = policySummary(results);
  const checkRuns = await ctx.server.paginate(ctx.server.rest.checks.listForRef, { owner, repo, ref: ctx.pull.headSha, per_page: 100 });
  const existing = checkRuns.find((c) => c.name === "csm-ci/policy" && c.external_id === ctx.pull.headSha && Number(c.app?.id) === ctx.config.apps.server_app_id);
  const output = { title: ok ? "Policies passed" : "Policies failed", summary };
  if (existing) {
    await ctx.server.rest.checks.update({ owner, repo, check_run_id: Number(existing.id), name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", conclusion: ok ? "success" : "failure", output });
  } else {
    await ctx.server.rest.checks.create({ owner, repo, name: "csm-ci/policy", external_id: ctx.pull.headSha, head_sha: ctx.pull.headSha, status: "completed", conclusion: ok ? "success" : "failure", output });
  }
  return results;
}

export async function runPolicyCheck(ctx: PolicyCheckContext): Promise<PolicyResult[]> {
  return updatePolicyCheck(ctx);
}
