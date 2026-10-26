import { z } from "zod";
import { splitRepository } from "../src/lib/github.ts";
import { marker } from "../src/lib/notify.ts";
import { assert, CLIENT, type Ctx, type Pr, SERVER, SERVER_BOT_ID, serverRuns, until } from "./harness.ts";

export async function verifyReceipt(ctx: Ctx, pr: Pr, command: { id: number; since: Date }, operation: "approve" | "merge", primary: RegExp, mergeCommit?: string): Promise<void> {
  const receipt = await until(`the ${operation} receipt for comment ${command.id}`, async () => {
    const comments = await ctx.gh.paginate(ctx.gh.rest.issues.listComments, { ...splitRepository(CLIENT), issue_number: pr.number, per_page: 100 });
    return comments.find((comment) => comment.user?.id === SERVER_BOT_ID && comment.body?.includes(marker(operation, command.id)));
  });
  const { data } = await ctx.gh.rest.issues.getComment({ ...splitRepository(CLIENT), comment_id: receipt.id, mediaType: { format: "full" } });
  const rendered = z.object({ body: z.string(), body_html: z.string() }).parse(data);
  const body = rendered.body;
  const footer = body.match(/<sub>([\s\S]*)<\/sub>$/u)?.[0];
  assert(footer && body.split("<sub>").length === 2, "receipt must have one small supplementary footer");
  const message = body.slice(0, body.indexOf("<sub>"));
  assert(primary.test(message), `receipt primary message does not match ${primary}`);
  assert(!message.includes('<a href=') && !message.includes("Server run"), "receipt metadata escaped the small footer");
  const runs = await serverRuns(ctx, { kind: operation, repository: CLIENT, args: { pull_number: pr.number, comment_id: command.id } }, command.since);
  const linkedRuns = runs.filter((run) => footer.includes(`href="${run.html_url}/attempts/`));
  assert(linkedRuns.length === 1 && linkedRuns[0], `receipt must link exactly one server run correlated to this request, found ${linkedRuns.length}`);
  const { data: run } = await ctx.gh.rest.actions.getWorkflowRun({ ...splitRepository(SERVER), run_id: linkedRuns[0].id });
  const requestUrl = `https://github.com/${CLIENT}/pull/${pr.number}#issuecomment-${command.id}`;
  const headUrl = `https://github.com/${CLIENT}/commit/${pr.head}`;
  const runUrl = `${run.html_url}/attempts/${run.run_attempt}`;
  for (const url of [requestUrl, headUrl, runUrl, ...(mergeCommit ? [`https://github.com/${CLIENT}/commit/${mergeCommit}`] : [])]) {
    assert(footer.includes(`<a href="${url}">`), `receipt footer is missing an HTML link to ${url}`);
    const renderedFooter = rendered.body_html.match(/<sub>[\s\S]*<\/sub>/u)?.[0];
    assert(renderedFooter?.includes(`href="${url}"`), `GitHub did not render the ${url} link inside the small footer`);
  }
  assert(footer.includes(`Head ${pr.head.slice(0, 7)}`), "receipt head is not a readable short identifier");
  assert(footer.includes(`Server run ${run.id}, attempt ${run.run_attempt}`), "receipt omitted actual run identity or attempt");
  if (mergeCommit) assert(footer.includes(`Squash commit ${mergeCommit.slice(0, 7)}`), "receipt omitted the short squash commit");
  ctx.urls.push(receipt.html_url);
}
