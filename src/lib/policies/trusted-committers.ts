import type { PolicyContext } from "./index.ts";

export function trustedCommitters(_: unknown, { trust }: PolicyContext): string[] {
  return [
    ...trust.problems,
    ...trust.commits.flatMap((c) => {
      if (c.identity.kind === "unknown") return [`${c.sha}: ${c.identity.reason}`];
      if (c.identity.kind === "user" && !c.trusted) return [`${c.sha} is by ${c.identity.principal.login}, not a trusted committer`];
      return [];
    }),
  ];
}
