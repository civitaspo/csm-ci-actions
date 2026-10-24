import type { PolicyContext } from "./index.ts";

export function signedCommits(_: unknown, { trust }: PolicyContext): string[] {
  return [...trust.problems, ...trust.commits.filter((c) => !c.signed).map((c) => `${c.sha} is not signed and verified`)];
}
