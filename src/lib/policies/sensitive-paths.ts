import picomatch from "picomatch";
import { splitRepository } from "../github.ts";
import { type PolicyContext } from "./index.ts";

type ChangedFile = { filename: string; previous_filename?: string };
const MARKER = /<!-- csm-ci:approve:command:(\d+) -->/g;
const MAX_FILES = 3000;

export async function sensitivePaths(policy: Extract<import("../config.ts").Policy, { type: "sensitive-paths" }>, ctx: PolicyContext): Promise<string[]> {
  const { owner, repo } = splitRepository(ctx.repository);
  const files = await ctx.gh.paginate(ctx.gh.rest.pulls.listFiles, { owner, repo, pull_number: ctx.pullNumber, per_page: 100 }) as ChangedFile[];
  if (files.length >= MAX_FILES) return [`pull request changes ${MAX_FILES} or more files; sensitive-paths cannot verify every file`];

  const forceAll = ctx.repository.toLowerCase() === ctx.config.server_repository || ctx.repository.toLowerCase() === "civitaspo/csm-ci-actions";
  const patterns = forceAll ? ["**"] : policy.paths;
  const match = picomatch(patterns, { dot: true });
  const changed = files.filter((f) => match(f.filename) || (f.previous_filename !== undefined && match(f.previous_filename)));
  if (changed.length === 0) return [];

  const exempt = !forceAll && policy.exempt.some((p) => p.id === ctx.authorId)
    && ctx.trust.commits.length > 0
    && ctx.trust.commits.every((c) => c.identity.kind === "user" && c.identity.principal.id === ctx.authorId);
  if (exempt) return [];

  const commandApproval = ctx.commandApproval;
  if (commandApproval?.head === ctx.head && ctx.config.trust.approvers.some((p) => p.id === commandApproval.authorId)) return [];

  const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { owner, repo, pull_number: ctx.pullNumber, per_page: 100 });
  const candidates = reviews.filter((r) => Number(r.user?.id) === ctx.config.approver.id && r.state === "APPROVED" && r.commit_id === ctx.head);
  for (const review of candidates) {
    const body = review.body ?? "";
    const markers = [...body.matchAll(MARKER)];
    for (const marker of markers) {
      const commentId = Number(marker[1]);
      try {
        const { data: comment } = await ctx.gh.rest.issues.getComment({ owner, repo, comment_id: commentId });
        if (comment.body !== "/approve" || comment.issue_url !== `https://api.github.com/repos/${owner}/${repo}/issues/${ctx.pullNumber}` || comment.user?.type !== "User" || !ctx.config.trust.approvers.some((p) => p.id === Number(comment.user?.id)) || !comment.node_id || comment.created_at !== comment.updated_at) continue;
        if (!comment.node_id) continue;
        const edit = await ctx.gh.graphql<{ node: { lastEditedAt: string | null } | null }>(
          "query($id: ID!) { node(id: $id) { ... on IssueComment { lastEditedAt } } }",
          { id: comment.node_id },
        );
        if (edit.node?.lastEditedAt === null) return [];
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && error.status === 404) continue;
        throw error;
      }
    }
  }
  const paths = changed.slice(0, 20).map((f) => f.previous_filename ? `${f.filename} (previously ${f.previous_filename})` : f.filename);
  const more = changed.length > paths.length ? ` and ${changed.length - paths.length} more` : "";
  return [`sensitive paths need a trusted approver's /approve: ${paths.join(", ")}${more}`];
}
