import type { RequestMatch } from "./harness.ts";

export type Timestamped = { created_at: string };

export function findRunByTitle<T extends { display_title: string }>(runs: readonly T[], title: string): T | undefined {
  return runs.find((run) => run.display_title === title);
}

export function runsForComments<T extends { display_title: string }>(runs: readonly T[], pullNumber: number, commentIds: readonly number[]): T[] | undefined {
  const titles = [...new Set(commentIds)].map((id) => new RegExp(`request #${pullNumber}(?!\\d).*comment #${id}(?!\\d)`));
  const matches = titles.map((title) => runs.find((run) => title.test(run.display_title)));
  return matches.every((run) => run !== undefined) ? matches : undefined;
}

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

export async function findRecentRunByTitle<T extends Timestamped & { display_title: string }>(pages: AsyncIterable<readonly T[]>, since: Date, title: string): Promise<T | undefined> {
  return findRunByTitle(await recentItems(pages, since), title);
}

export function matchesAcceptedRequest(log: string, match: RequestMatch): boolean {
  const accepted = `accepted ${match.kind} for ${match.repository} ${JSON.stringify(match.args)}`;
  return log.split(/\r?\n/).some((line) => line.includes(accepted));
}

export function matchesCleanupLabel(log: string, label: string): boolean {
  return log.split(/\r?\n/).some((line) => line.trimEnd().endsWith(` LABEL: ${label}`) || line.trimEnd() === `LABEL: ${label}`);
}

export function completedRequestRuns<T extends { status: string | null }>(runs: T[], expectedCount: number): T[] | undefined {
  return runs.length >= expectedCount && runs.every((run) => run.status === "completed") ? runs : undefined;
}
