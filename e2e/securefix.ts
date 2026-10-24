import { splitRepository } from "../src/lib/github.ts";
import { CLIENT, SERVER, assert, closePr, expectOp, jobs, jobLog, openPr, type Ctx, type Run, type Scenario, until, waitRun } from "./harness.ts";

async function securefixRun(ctx: Ctx, pr: { branch: string; head: string }): Promise<Run> {
  return until("the securefix PR workflow", async () => {
    const { data } = await ctx.gh.rest.actions.listWorkflowRuns({
      ...splitRepository(CLIENT),
      workflow_id: "csm-ci-securefix.yml",
      event: "pull_request",
      branch: pr.branch,
      per_page: 10,
    });
    const run = data.workflow_runs.find((candidate) => candidate.head_sha === pr.head);
    return run;
  });
}

export const securefix: Scenario[] = [
  {
    name: "a securefix PR run writes its generated change to the same branch",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const pr = await openPr(ctx, "signed");
      try {
        const run = await securefixRun(ctx, pr);
        const completed = await waitRun(ctx, CLIENT, run.id);
        if (completed.conclusion !== "success") throw new Error(`client securefix run concluded ${completed.conclusion} (${completed.html_url})`);
        await expectOp(ctx, since, "success");
        const { data } = await ctx.gh.rest.repos.getContent({ ...splitRepository(CLIENT), path: "e2e/securefix-result.txt", ref: pr.branch });
        if (Array.isArray(data) || data.type !== "file") throw new Error("securefix result is not a file");
        const content = Buffer.from(data.content, "base64").toString("utf8");
        if (content !== `securefix run ${run.id}\n`) throw new Error(`securefix result has unexpected content: ${JSON.stringify(content)}`);
      } finally {
        await closePr(ctx, pr);
      }
    },
  },
  {
    name: "a PR from the same branch to a different base cannot redirect securefix",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const { data: main } = await ctx.gh.rest.repos.getBranch({ ...splitRepository(CLIENT), branch: "main" });
      const alternateBase = `e2e-base-${Date.now().toString(36)}`;
      await ctx.gh.rest.git.createRef({ ...splitRepository(CLIENT), ref: `refs/heads/${alternateBase}`, sha: main.commit.sha });
      const first = await openPr(ctx, "signed");
      let secondNumber: number | undefined;
      try {
        const { data: second } = await ctx.gh.rest.pulls.create({
          ...splitRepository(CLIENT),
          head: first.branch,
          base: alternateBase,
          title: `e2e alternate base ${first.branch}`,
        });
        secondNumber = second.number;
        const serverRuns = await until("both server requests for the shared PR branch", async () => {
          const { data } = await ctx.gh.rest.actions.listWorkflowRuns({ ...splitRepository(SERVER), workflow_id: "csm-ci.yml", event: "label", per_page: 20 });
          const runs = data.workflow_runs.filter((run) => new Date(run.created_at) >= since);
          assert(runs.length <= 2, `expected two securefix server runs, found ${runs.length}`);
          if (runs.length !== 2 || runs.some((run) => run.status !== "completed")) return undefined;
          return runs;
        });
        const rejectionPatterns: RegExp[] = [];
        for (const run of serverRuns) {
          const completed = await waitRun(ctx, SERVER, run.id);
          assert(completed.conclusion === "failure", `server securefix run concluded ${completed.conclusion} (${completed.html_url})`);
          const byName = await jobs(ctx, SERVER, run.id);
          assert(byName.get("intake")?.conclusion === "success", `server intake failed (${completed.html_url})`);
          assert(byName.get("op")?.conclusion === "failure", `server op did not reject the ambiguous PR binding (${completed.html_url})`);
          const op = byName.get("op");
          if (!op) throw new Error(`server op job was missing (${completed.html_url})`);
          const log = await jobLog(ctx, SERVER, op.id);
          const pattern = /securefix (?:PR must target the default branch|PR head has more than one open pull request|PR run must map to exactly one pull request)/u;
          assert(pattern.test(log), `securefix rejected for an unexpected reason (${completed.html_url})`);
          rejectionPatterns.push(pattern);
        }
        assert(rejectionPatterns.length === 2, "both pull_request runs must be rejected");
      } finally {
        if (secondNumber !== undefined) await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: secondNumber, state: "closed" });
        await closePr(ctx, first);
        await ctx.gh.rest.git.deleteRef({ ...splitRepository(CLIENT), ref: `heads/${alternateBase}` }).catch((error: unknown) => {
          if (!(typeof error === "object" && error !== null && "status" in error && error.status === 404)) throw error;
        });
      }
    },
  },
];
