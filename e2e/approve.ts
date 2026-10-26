import { verifyReceipt } from "./notifications.ts";
import { splitRepository } from "../src/lib/github.ts";
import { marker } from "../src/lib/notify.ts";
import { completedRequestRuns, matchesAcceptedRequest, runsForComments } from "./correlation.ts";
import {
  approverReviews,
  assert,
  CLIENT,
  type Ctx,
  closePr,
  dispatch,
  expectOp,
  openPr,
  type Pr,
  postComment,
  type Scenario,
  jobLog,
  jobs,
  SERVER,
  serverComments,
  serverRuns,
  recentWorkflowRuns,
  sleep,
  until,
} from "./harness.ts";

const OWNER_EMAIL = "4525500+civitaspo@users.noreply.github.com";

async function withPr(ctx: Ctx, kind: "signed" | "unsigned", fn: (pr: Pr) => Promise<void>, as = ctx.gh, author?: { name: string; email: string }): Promise<void> {
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, kind, as, author);
  try {
    // Opening the pull request runs the automatic path once.
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number } }, since, "success");
    await fn(pr);
  } finally {
    await closePr(ctx, pr);
  }
}

async function approvedAt(ctx: Ctx, pr: Pr) {
  return (await approverReviews(ctx, pr)).filter((r) => r.state === "APPROVED" && r.commit_id === pr.head);
}

async function dismissApprovals(ctx: Ctx, pr: Pr): Promise<void> {
  for (const r of await approvedAt(ctx, pr)) {
    await ctx.gh.rest.pulls.dismissReview({ ...splitRepository(CLIENT), pull_number: pr.number, review_id: r.id, message: "e2e: reset" });
  }
  assert((await approvedAt(ctx, pr)).length === 0, "approval still present after dismissing");
}

async function rocketFromServer(ctx: Ctx, commentId: number): Promise<boolean> {
  const reactions = await ctx.gh.paginate(ctx.gh.rest.reactions.listForIssueComment, { ...splitRepository(CLIENT), comment_id: commentId, per_page: 100 });
  return reactions.some((r) => r.content === "rocket" && r.user?.login === "testing-csm-ci-server[bot]");
}

async function expectRejectedCommand(ctx: Ctx, pr: Pr, body: string, pattern: RegExp, receipt: boolean): Promise<void> {
  const before = (await approverReviews(ctx, pr)).length;
  const c = await postComment(ctx, pr, body);
  await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, c.since, "failure", pattern);
  assert((await approverReviews(ctx, pr)).length === before, "a rejected command created a review");
  const receipts = (await serverComments(ctx, pr)).filter((b) => b.includes(marker("approve", c.id)));
  assert(receipts.length === (receipt ? 1 : 0), `expected ${receipt ? "one receipt" : "no receipt"}, found ${receipts.length}`);
  if (receipt) await verifyReceipt(ctx, pr, c, "approve", pattern);
}

// The completed client runs determine how many labels must reach the server.
async function expectEveryOp(ctx: Ctx, match: {kind:string; repository:string; args:Record<string,number>}, since: Date, expectedCount: number, op: "success" | "failure", logPattern: RegExp): Promise<void> {
  const runs = await until("the server runs to finish", async () => completedRequestRuns(await serverRuns(ctx, match, since), expectedCount));
  for (const run of runs) {
    ctx.urls.push(run.html_url);
    const opJob = (await jobs(ctx, SERVER, run.id)).get("op");
    assert(opJob?.conclusion === op, `op job concluded ${opJob?.conclusion}, expected ${op} (${run.html_url})`);
    assert(logPattern.test(await jobLog(ctx, SERVER, opJob.id)), `op log does not match ${logPattern} (${run.html_url})`);
  }
}

async function commentRequestCount(ctx: Ctx, since: Date, pr: number, commentId: number): Promise<number> {
  const run = await until(`the client run for comment ${commentId}`, async () => {
    const recent = await recentWorkflowRuns(ctx, CLIENT, "csm-ci-approve.yml", "issue_comment", since);
    const found = runsForComments(recent, pr, [commentId])?.[0];
    return found?.status === "completed" ? found : undefined;
  });
  ctx.urls.push(run.html_url);
  const request = await until(`the request job of ${run.html_url}`, async () => (await jobs(ctx, CLIENT, run.id)).get("request"));
  if (request.conclusion === "skipped") return 0;
  assert(request.conclusion === "success", `client request job concluded ${request.conclusion} (${run.html_url})`);
  const labels = (await jobLog(ctx, CLIENT, request.id)).match(/created label csm-ci-[^ ]+ \(/g) ?? [];
  assert(labels.length === 1, `expected one client request label, found ${labels.length} (${run.html_url})`);
  return 1;
}

// Waits for the issue_comment runs of the client workflow and checks that their request job was skipped.
async function expectClientSkipped(ctx: Ctx, since: Date, pr: number, commentIds: number[]): Promise<void> {
  const runs = await until(`${commentIds.length} client issue_comment runs`, async () => {
    const recent = await recentWorkflowRuns(ctx, CLIENT, "csm-ci-approve.yml", "issue_comment", since);
    const found = runsForComments(recent, pr, commentIds);
    return found?.every((r) => r.status === "completed") ? found : undefined;
  });
  for (const run of runs) {
    ctx.urls.push(run.html_url);
    assert(run.display_title?.includes(`request #${pr}`), `client run does not identify PR ${pr} (${run.html_url})`);
    // Right after a run completes, its job list can still be empty.
    const request = await until(`the request job of ${run.html_url}`, async () => (await jobs(ctx, CLIENT, run.id)).get("request"));
    assert(request.conclusion === "skipped", `client request job concluded ${request.conclusion} (${run.html_url})`);
  }
}

// After the client runs are done, no label can still be on its way.
async function expectNoServerRun(ctx: Ctx, since: Date, match: {kind:string; repository:string; args:Record<string,number>}): Promise<void> {
  await sleep(15_000);
  const recent = await recentWorkflowRuns(ctx, SERVER, "csm-ci.yml", "label", since);
  const runs = [];
  for (const run of recent) {
    const intake = (await jobs(ctx, SERVER, run.id)).get("intake");
    if (intake && intake.conclusion !== null && intake.conclusion !== "skipped" && matchesAcceptedRequest(await jobLog(ctx, SERVER, intake.id), match)) runs.push(run);
  }
  assert(runs.length === 0, `expected no server run, found ${runs.map((r) => r.html_url).join(", ")}`);
}

// Creates a request label for any comment with the client App, as a holder of its key could.
// The server run for this label starts after the dispatch, so earlier runs on the same pull
// request, such as the automatic one for opening it, fall before `since`.
async function labelFor(ctx: Ctx, pr: Pr, commentId: number): Promise<Date> {
  const since = new Date();
  const run = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "approve", args: `${pr.number}/${commentId}` });
  assert(run.conclusion === "success", `client request run concluded ${run.conclusion} (${run.html_url})`);
  return since;
}

async function receipts(ctx: Ctx, pr: Pr, commentId: number): Promise<string[]> {
  return (await serverComments(ctx, pr)).filter((b) => b.includes(marker("approve", commentId)));
}

export const approve: Scenario[] = [
  {
    name: "a pull request of signed commits by a trusted committer is approved automatically",
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        const approvals = await approvedAt(ctx, pr);
        assert(approvals.length === 1, `expected one approval at ${pr.head}, found ${approvals.length}`);
        assert(!approvals[0]?.body.includes("approve:command"), "an automatic approval carries the command marker");
      }),
  },
  {
    name: "a pull request with an unsigned commit is not approved automatically",
    run: (ctx) =>
      withPr(ctx, "unsigned", async (pr) => {
        assert((await approverReviews(ctx, pr)).length === 0, "an unsigned pull request got a review");
      }),
  },
  {
    name: "/approve by an approver approves with the command marker, a rocket and a receipt",
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        await dismissApprovals(ctx, pr);
        const c = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, c.since, "success");
        const approvals = await approvedAt(ctx, pr);
        assert(approvals.length === 1 && approvals[0]?.body.includes(marker("approve:command", c.id)), "no /approve approval at the head");
        assert(await rocketFromServer(ctx, c.id), "the server did not react with a rocket");
        assert((await receipts(ctx, pr, c.id)).some((b) => b.includes("Approved the requested head")), "no success receipt");
        await verifyReceipt(ctx, pr, c, "approve", /\/approve succeeded/u);
      }),
  },
  {
    name: "a replayed /approve label is rejected without another receipt",
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        await dismissApprovals(ctx, pr);
        const c = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, c.since, "success");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, await labelFor(ctx, pr, c.id), "failure", /already handled/);
        assert((await receipts(ctx, pr, c.id)).length === 1, "the replay posted another receipt");
      }),
  },
  {
    name: "/approve on an unsigned commit is rejected with a receipt",
    run: (ctx) => withPr(ctx, "unsigned", (pr) => expectRejectedCommand(ctx, pr, "/approve", /policy checks failed: signed-commits: [0-9a-f]{40} is not signed and verified/, true)),
  },
  {
    name: "an /approve edited after posting is rejected without a receipt",
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        await dismissApprovals(ctx, pr);
        // The client run may read the edited body and send a request of its own, so the scenario
        // also labels the comment directly and expects every resulting request to be rejected.
        const c = await postComment(ctx, pr, "e2e: about to become /approve");
        await ctx.gh.rest.issues.updateComment({ ...splitRepository(CLIENT), comment_id: c.id, body: "/approve" });
        await labelFor(ctx, pr, c.id);
        const expectedRequests = 1 + await commentRequestCount(ctx, c.since, pr.number, c.id);
        await expectEveryOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, c.since, expectedRequests, "failure", /was edited/);
        assert((await approvedAt(ctx, pr)).length === 0, "an edited command approved");
        assert(!(await rocketFromServer(ctx, c.id)), "the server reacted to an edited command");
      }),
  },
  {
    name: "/recheck approves again after the approval was dismissed",
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        await dismissApprovals(ctx, pr);
        const c = await postComment(ctx, pr, "/recheck");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, c.since, "success");
        assert((await approvedAt(ctx, pr)).length === 1, "/recheck did not approve");
        assert(await rocketFromServer(ctx, c.id), "the server did not react with a rocket");
      }),
  },
  {
    name: "an App commit made through the REST API with the owner as author is unsigned and not approved",
    needsUntrusted: true,
    run: (ctx) =>
      withPr(
        ctx,
        "unsigned",
        async (pr) => {
          const { data } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(CLIENT), ref: pr.head });
          assert(data.commit.verification?.verified === false, `the forged commit is verified (${data.commit.verification?.reason})`);
          assert((await approverReviews(ctx, pr)).length === 0, "a forged commit got a review");
        },
        ctxUntrusted(ctx),
        { name: "civitaspo", email: OWNER_EMAIL },
      ),
  },
  {
    name: "a signed commit by an untrusted App is not approved, even by /approve",
    needsUntrusted: true,
    run: (ctx) =>
      withPr(
        ctx,
        "signed",
        async (pr) => {
          assert((await approverReviews(ctx, pr)).length === 0, "an untrusted commit was approved automatically");
          await expectRejectedCommand(ctx, pr, "/approve", /is by testing-csm-ci-untrusted-committer\[bot\], not a trusted committer/, true);
        },
        ctxUntrusted(ctx),
      ),
  },
  {
    name: "a label for an /approve by someone who is not an approver gets no rocket and no receipt",
    needsUntrusted: true,
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        await dismissApprovals(ctx, pr);
        const c = await postComment(ctx, pr, "/approve", ctxUntrusted(ctx));
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: c.id } }, await labelFor(ctx, pr, c.id), "failure", /is not one of the approvers/);
        assert((await receipts(ctx, pr, c.id)).length === 0, "the server posted a receipt for a non-approver");
        assert(!(await rocketFromServer(ctx, c.id)), "the server reacted to a non-approver");
      }),
  },
  {
    name: "/approve and /recheck from a commenter who is not an owner, member or collaborator create no request",
    needsUntrusted: true,
    run: (ctx) =>
      withPr(ctx, "signed", async (pr) => {
        const untrusted = ctxUntrusted(ctx);
        const a = await postComment(ctx, pr, "/approve", untrusted);
        const b = await postComment(ctx, pr, "/recheck", untrusted);
        await expectClientSkipped(ctx, a.since, pr.number, [a.id, b.id]);
        await expectNoServerRun(ctx, a.since, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: a.id } });
        await expectNoServerRun(ctx, b.since, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: b.id } });
      }),
  },
];

function ctxUntrusted(ctx: Ctx) {
  assert(ctx.untrusted, "the untrusted committer token is not set");
  return ctx.untrusted;
}
