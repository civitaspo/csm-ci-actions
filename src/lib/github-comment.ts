import type { CommentFacts } from "./command.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { Rejection } from "./request.ts";

export async function fetchComment(gh: GitHub, repository: string, commentId: number): Promise<CommentFacts> {
  const { data: comment } = await gh.rest.issues.getComment({ ...splitRepository(repository), comment_id: commentId });
  if (!comment.node_id) throw new Rejection(`cannot verify the edit history of comment ${commentId}`);
  const { node } = await gh.graphql<{ node: { databaseId: number; lastEditedAt: string | null } | null }>(
    "query($id: ID!) { node(id: $id) { ... on IssueComment { databaseId lastEditedAt } } }",
    { id: comment.node_id },
  );
  if (!node || node.databaseId !== Number(comment.id) || !(node.lastEditedAt === null || typeof node.lastEditedAt === "string")) {
    throw new Rejection(`cannot verify the edit history of comment ${commentId}`);
  }
  return {
    id: Number(comment.id),
    body: comment.body ?? "",
    issueUrl: comment.issue_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    lastEditedAt: node.lastEditedAt,
    user: comment.user ? { id: Number(comment.user.id), login: comment.user.login, type: comment.user.type } : null,
  };
}
