import type { Config, Policy } from "../config.ts";
import type { GitHub } from "../github.ts";
import type { TrustResult } from "../trust.ts";
import { signedCommits } from "./signed-commits.ts";
import { sensitivePaths } from "./sensitive-paths.ts";
import { trustedCommitters } from "./trusted-committers.ts";

export type PolicyContext = { trust: TrustResult; gh: GitHub; config: Config; repository: string; pullNumber: number; head: string; authorId: number; commandApproval?: { commentId: number; authorId: number; head: string } };
export type PolicyResult = { type: Policy["type"]; ok: boolean; problems: string[] };
type Evaluator<P extends Policy> = (policy: P, ctx: PolicyContext) => Promise<string[]> | string[];

const EVALUATORS: { [T in Policy["type"]]: Evaluator<Extract<Policy, { type: T }>> } = {
  "signed-commits": signedCommits,
  "trusted-committers": trustedCommitters,
  "sensitive-paths": sensitivePaths,
};

export async function evaluatePolicies(policies: readonly Policy[], ctx: PolicyContext): Promise<PolicyResult[]> {
  return Promise.all(policies.map(async (policy) => {
    const evaluate = EVALUATORS[policy.type] as Evaluator<Policy>;
    const problems = await evaluate(policy, ctx);
    return { type: policy.type, ok: problems.length === 0, problems };
  }));
}
