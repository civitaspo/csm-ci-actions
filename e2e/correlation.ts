import type { RequestMatch } from "./harness.ts";

export type Timestamped = { created_at: string };

export async function recentItems<T extends Timestamped>(pages: AsyncIterable<readonly T[]>, since: Date): Promise<T[]> {
  const result: T[] = [];
  // Workflow runs are returned newest first, so an old item ends the useful range.
  for await (const page of pages) {
    const recent = page.filter((item) => new Date(item.created_at) >= since);
    result.push(...recent);
    if (recent.length < page.length) break;
  }
  return result;
}

export function matchesAcceptedRequest(log: string, match: RequestMatch): boolean {
  const accepted = `accepted ${match.kind} for ${match.repository} ${JSON.stringify(match.args)}`;
  return log.split(/\r?\n/).some((line) => line.includes(accepted));
}
