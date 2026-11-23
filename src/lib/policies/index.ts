import type { Config, Policy } from "../config.ts";
import type { GitHub } from "../github.ts";
import type { TrustResult } from "../trust.ts";
import { signedCommits } from "./signed-commits.ts";
import { sensitivePaths } from "./sensitive-paths.ts";
import { trustedCommitters } from "./trusted-committers.ts";
import { pullRequestTitle } from "./pull-request-title.ts";

export type PolicyContext = { trust: TrustResult; gh: GitHub; config: Config; repository: string; pullNumber: number; head: string; authorId: number; title: string; commandApproval?: { commentId: number; authorId: number; head: string } };
export type PolicyResult = { type: Policy["type"] | "approval" | "managed-files"; ok: boolean; problems: string[] };
type Evaluator<P extends Policy> = (policy: P, ctx: PolicyContext) => Promise<string[]> | string[];

const EVALUATORS: { [T in Policy["type"]]: Evaluator<Extract<Policy, { type: T }>> } = {
  "signed-commits": signedCommits,
  "trusted-committers": trustedCommitters,
  "sensitive-paths": sensitivePaths,
  "pull-request-title": pullRequestTitle,
};

// The title is commit metadata, not evidence about the code, so approval and reservation
// decisions ignore it; check publication and merge readiness enforce it.
export function approvalDecisionResults(results: readonly PolicyResult[]): PolicyResult[] {
  return results.filter((result) => result.type !== "pull-request-title");
}

export async function evaluatePolicies(policies: readonly Policy[], ctx: PolicyContext): Promise<PolicyResult[]> {
  return Promise.all(policies.map(async (policy) => {
    const evaluate = EVALUATORS[policy.type] as Evaluator<Policy>;
    const problems = await evaluate(policy, ctx);
    return { type: policy.type, ok: problems.length === 0, problems };
  }));
}
