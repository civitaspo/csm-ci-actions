import { type GitHub, splitRepository } from "./github.ts";

export function marker(op: string, id: number | string): string {
  return `<!-- csm-ci:${op}:${id} -->`;
}

type Comment = { user: { id: number | bigint } | null; body?: string | null | undefined };

// Only the server bot's own comments count: anyone can paste a marker into a comment.
export function hasServerMarker(comments: readonly Comment[], text: string, serverBotId: number): boolean {
  return comments.some((c) => Number(c.user?.id) === serverBotId && (c.body ?? "").includes(text));
}

export async function postResult(gh: GitHub, repository: string, issueNumber: number, markerText: string, body: string): Promise<void> {
  await gh.rest.issues.createComment({ ...splitRepository(repository), issue_number: issueNumber, body: `${markerText}\n${body}` });
}
