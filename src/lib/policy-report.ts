import { createHash } from "node:crypto";
import { z } from "zod";
import { type GitHub, isNetworkFailure, splitRepository } from "./github.ts";
import { escapeHtml, type ServerRun } from "./notify.ts";
import type { PolicyResult } from "./policies/index.ts";

export const POLICY_FAILURE_MARKER = "<!-- csm-ci:policy-failure -->";
type Context = { server: GitHub; repository: string; pullNumber: number; head: string; serverBotId: number; serverRun: ServerRun; requestKind?: "approve" | "policy-check"; requestCommentId?: number };
const stateSchema = z.object({ node: z.object({
  id: z.string(), databaseId: z.number(), body: z.string(), isMinimized: z.boolean(), minimizedReason: z.string().nullable(),
  author: z.object({ __typename: z.literal("Bot"), databaseId: z.number() }),
  issue: z.object({ number: z.number(), repository: z.object({ nameWithOwner: z.string() }) }),
}) });

function escapeDetail(text: string, limit: number): string {
  let result = "";
  for (const char of text) {
    const encoded = /[\u0000-\u001f\u007f-\u009f]/.test(char) ? " " : /[\\`*_\[\]~!@|()#]/.test(char) ? `&#${char.codePointAt(0)};` : escapeHtml(char);
    if (result.length + encoded.length > limit) return `${result}… [truncated; see server run for full details]`;
    result += encoded;
  }
  return result;
}

export function policyFailureContent(results: readonly PolicyResult[]): string {
  const failures = [...new Set(results.filter((r) => !r.ok).map((r) => r.type))];
  const rows = failures.map((type) => {
    const details = results.filter((r) => !r.ok && r.type === type).flatMap((r) => r.problems).join("; ");
    return `- ${type}: <code>${escapeDetail(details, Math.floor(5700 / Math.max(failures.length, 1)) - 100)}</code>`;
  });
  const guidance = failures.includes("sensitive-paths") ? "For sensitive changes, obtain the required trusted approver's `/approve` evidence for this head. " : "";
  return `csm-ci: Policy check failed.\n\n${rows.join("\n")}\n\nFix the reported violations. ${guidance}Trust restrictions must pass; approval cannot bypass them. Use \`/recheck\` after correcting the cause or a temporary issue.`;
}

function reportBody(ctx: Context, content: string): { prefix: string; body: string } {
  const fingerprint = createHash("sha256").update(`${ctx.head}\n${content}`).digest("hex");
  const prefix = `${POLICY_FAILURE_MARKER}\n<!-- csm-ci:policy-failure-content:${fingerprint} -->\n${content}`;
  const { serverRun: run } = ctx;
  const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  const repoUrl = `${run.serverUrl}/${ctx.repository}`;
  const runUrl = `${run.serverUrl}/${run.repository}/actions/runs/${run.id}`;
  const request = `${ctx.repository}/${ctx.pullNumber}${ctx.requestCommentId ? `/${ctx.requestCommentId}` : ""}`;
  const footer = [
    escapeHtml(`Request ${ctx.requestKind ?? "policy-check"} ${request}`),
    ...(ctx.requestCommentId ? [link(`${repoUrl}/pull/${ctx.pullNumber}#issuecomment-${ctx.requestCommentId}`, "Command")] : []),
    link(`${repoUrl}/commit/${ctx.head}`, `Head ${ctx.head.slice(0, 7)}`),
    link(runUrl, `Server run ${run.id}`),
    link(`${runUrl}/attempts/${run.attempt}`, `Attempt ${run.attempt}`),
  ];
  return { prefix, body: `${prefix}\n\n<sub>${footer.join(" · ")}</sub>` };
}

async function current(ctx: Context): Promise<boolean> {
  const { data: pull } = await ctx.server.rest.pulls.get({ ...splitRepository(ctx.repository), pull_number: ctx.pullNumber });
  return pull.state === "open" && pull.head.sha === ctx.head;
}

function owned(ctx: Context, comment: { user: { id: number | bigint; type: string } | null; body?: string | null }): boolean {
  return Number(comment.user?.id) === ctx.serverBotId && comment.user?.type === "Bot" && (comment.body ?? "").startsWith(`${POLICY_FAILURE_MARKER}\n`);
}

async function readReport(ctx: Context, id: number) {
  const { data: comment } = await ctx.server.rest.issues.getComment({ ...splitRepository(ctx.repository), comment_id: id });
  const issueUrl = `https://api.github.com/repos/${ctx.repository}/issues/${ctx.pullNumber}`;
  if (!owned(ctx, comment) || comment.issue_url.toLowerCase() !== issueUrl.toLowerCase() || !comment.node_id || Number(comment.id) !== id) throw new Error(`cannot verify policy report ${id} ownership`);
  const response: unknown = await ctx.server.graphql("query($id: ID!) { node(id: $id) { ... on IssueComment { id databaseId body isMinimized minimizedReason author { __typename ... on Bot { databaseId } } issue { number repository { nameWithOwner } } } } }", { id: comment.node_id });
  const parsed = stateSchema.safeParse(response);
  if (!parsed.success) throw new Error(`cannot verify policy report ${id} node identity`);
  const { node } = parsed.data;
  if (node.id !== comment.node_id || node.databaseId !== id || node.author.databaseId !== ctx.serverBotId || node.issue.number !== ctx.pullNumber || node.issue.repository.nameWithOwner.toLowerCase() !== ctx.repository.toLowerCase() || node.body !== comment.body) throw new Error(`cannot verify policy report ${id} node identity`);
  return node;
}

export async function publishPolicyReport(ctx: Context, results: readonly PolicyResult[]): Promise<void> {
  const list = () => ctx.server.paginate(ctx.server.rest.issues.listComments, { ...splitRepository(ctx.repository), issue_number: ctx.pullNumber, per_page: 100 });
  let comments = await list();
  const passing = results.every((r) => r.ok);
  const report = reportBody(ctx, policyFailureContent(results));
  const active = async () => {
    for (const comment of comments.filter((c) => owned(ctx, c))) {
      const node = await readReport(ctx, Number(comment.id));
      if (!node.isMinimized && node.body.startsWith(`${report.prefix}\n\n<sub>`)) return node.databaseId;
    }
    return undefined;
  };
  let retained = passing ? undefined : await active();
  if (!passing && retained === undefined) {
    if (!await current(ctx)) return;
    try {
      const { data: created } = await ctx.server.rest.issues.createComment({ ...splitRepository(ctx.repository), issue_number: ctx.pullNumber, body: report.body });
      retained = Number(created.id);
    } catch (error) {
      // A lost response can follow a successful write. Recover from owned state without retrying the write.
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      if (!isNetworkFailure(error) && !(error instanceof Error && error.name === "TimeoutError") && status !== 502 && status !== 503 && status !== 504) throw error;
      comments = await list();
      retained = await active();
      if (retained === undefined) throw error;
    }
  }
  for (const comment of comments.filter((c) => owned(ctx, c) && Number(c.id) !== retained)) {
    const node = await readReport(ctx, Number(comment.id));
    const classifier = passing ? "RESOLVED" : "OUTDATED";
    if (node.isMinimized && node.minimizedReason?.toUpperCase() === classifier) continue;
    if (!await current(ctx)) return;
    const response: unknown = await ctx.server.graphql("mutation($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: {subjectId: $id, classifier: $classifier}) { minimizedComment { isMinimized minimizedReason } } }", { id: node.id, classifier });
    const result = z.object({ minimizeComment: z.object({ minimizedComment: z.object({ isMinimized: z.literal(true), minimizedReason: z.string() }) }) }).safeParse(response);
    if (!result.success || result.data.minimizeComment.minimizedComment.minimizedReason.toUpperCase() !== classifier) throw new Error(`policy report ${node.databaseId} was not minimized as ${classifier}`);
  }
}
