import type { Policy } from "../config.ts";
import type { TrustResult } from "../trust.ts";
import { signedCommits } from "./signed-commits.ts";
import { trustedCommitters } from "./trusted-committers.ts";

export type PolicyContext = { trust: TrustResult };
export type PolicyResult = { type: Policy["type"]; ok: boolean; problems: string[] };
type Evaluator<P extends Policy> = (policy: P, ctx: PolicyContext) => string[];

const EVALUATORS: { [T in Policy["type"]]: Evaluator<Extract<Policy, { type: T }>> } = {
  "signed-commits": signedCommits,
  "trusted-committers": trustedCommitters,
};

export function evaluatePolicies(policies: readonly Policy[], ctx: PolicyContext): PolicyResult[] {
  return policies.map((policy) => {
    const evaluate = EVALUATORS[policy.type] as Evaluator<Policy>;
    const problems = evaluate(policy, ctx);
    return { type: policy.type, ok: problems.length === 0, problems };
  });
}
