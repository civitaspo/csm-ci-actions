import type { Policy } from "../config.ts";
import type { PolicyContext } from "./index.ts";

type PullRequestTitlePolicy = Extract<Policy, { type: "pull-request-title" }>;

// Types match ^[a-z]+$ (config.ts), so they need no escaping inside the pattern.
export function pullRequestTitle(policy: PullRequestTitlePolicy, { title }: PolicyContext): string[] {
  const header = new RegExp(`^(${policy.types.join("|")})(\\([a-z0-9-]+\\))?!?: \\S`);
  if (header.test(title)) return [];
  return [`title ${JSON.stringify(title)} is not a Conventional Commit header; edit it to <type>[(<scope>)][!]: <subject> with type one of ${policy.types.join(", ")}`];
}
