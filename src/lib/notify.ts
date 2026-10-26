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

export type ServerRun = { serverUrl: string; repository: string; id: string; attempt: string };

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function receiptFooter(input: { repository: string; pullNumber: number; commentId: number; head: string; serverRun: ServerRun; mergeCommit?: string }): string {
  const { repository, pullNumber, commentId, head, serverRun, mergeCommit } = input;
  const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  const repoUrl = `${serverRun.serverUrl}/${repository}`;
  const links = [
    link(`${repoUrl}/pull/${pullNumber}#issuecomment-${commentId}`, "Request"),
    link(`${repoUrl}/commit/${head}`, `Head ${head.slice(0, 7)}`),
    ...(mergeCommit ? [link(`${repoUrl}/commit/${mergeCommit}`, `Squash commit ${mergeCommit.slice(0, 7)}`)] : []),
    link(`${serverRun.serverUrl}/${serverRun.repository}/actions/runs/${serverRun.id}/attempts/${serverRun.attempt}`, `Server run ${serverRun.id}, attempt ${serverRun.attempt}`),
  ];
  return `<sub>${links.join(" · ")}</sub>`;
}
