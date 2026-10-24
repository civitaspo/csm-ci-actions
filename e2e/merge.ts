import { marker } from "../src/lib/notify.ts";
import { assert, CLIENT, closePr, dispatch, expectOp, openPr, type Pr, postComment, type Scenario, serverComments } from "./harness.ts";

async function request(ctx: Parameters<Scenario["run"]>[0], pr: Pr, commentId: number): Promise<Date> {
  const since = new Date(Date.now() - 2_000);
  const run = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "merge", args: `${pr.number}/${commentId}` });
  assert(run.conclusion === "success", `client merge request concluded ${run.conclusion} (${run.html_url})`);
  return since;
}

async function withSignedPr(ctx: Parameters<Scenario["run"]>[0], fn: (pr: Pr) => Promise<void>): Promise<void> {
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, "signed");
  try {
    await expectOp(ctx, since, "success");
    await fn(pr);
  } finally {
    await closePr(ctx, pr);
  }
}

export const merge: Scenario[] = [
  {
    name: "/merge by an authorized merger squashes the approved head and posts one receipt",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      const c = await postComment(ctx, pr, "/merge");
      await expectOp(ctx, await request(ctx, pr, c.id), "success");
      const { data: merged } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
      assert(merged.merged && merged.merge_commit_sha, `pull request #${pr.number} was not merged`);
      const receipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", c.id)));
      assert(receipts.length === 1 && receipts[0]?.includes("merged as"), `expected one merge receipt, found ${receipts.length}`);
    }),
  },
  {
    name: "a non-merger's /merge request fails without a receipt and leaves the pull request open",
    needsUntrusted: true,
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      assert(ctx.untrusted, "the untrusted test token is not configured");
      const c = await postComment(ctx, pr, "/merge", ctx.untrusted);
      await expectOp(ctx, await request(ctx, pr, c.id), "failure", /not one of the mergers/);
      const { data: unchanged } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
      assert(!unchanged.merged && unchanged.state === "open", `non-merger request changed pull request #${pr.number}`);
      const receipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", c.id)));
      assert(receipts.length === 0, `expected no receipt before command acceptance, found ${receipts.length}`);
    }),
  },
  {
    name: "/merge without the approver's current head approval times out without merging",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, per_page: 100 });
      for (const review of reviews.filter((r) => r.user?.login === "testing-csm-ci-approver[bot]" && r.state === "APPROVED")) {
        await ctx.gh.rest.pulls.dismissReview({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, review_id: Number(review.id), message: "e2e: test merge readiness timeout" });
      }
      const c = await postComment(ctx, pr, "/merge");
      await expectOp(ctx, await request(ctx, pr, c.id), "failure", /readiness deadline passed: the approver has not approved/);
      const { data: unchanged } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
      assert(!unchanged.merged && unchanged.state === "open", `unapproved request changed pull request #${pr.number}`);
    }),
  },
];
