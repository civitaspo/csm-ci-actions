import { withCleanup } from "./cleanup.ts";
import { OWNER_IDENTITY } from "./pr-metadata.ts";
import { annotatePr, labelPr, prBody, prTitle } from "./pr-metadata.ts";
import { prCase } from "./harness.ts";
import { splitRepository } from "../src/lib/github.ts";
import { CLIENT, OWNER, SERVER, assert, closePr, dispatch, expectOp, hasStatus, jobs, jobLog, openPr, smokeRequest, type Ctx, type RequestMatch, type Run, type Scenario, until, waitRun } from "./harness.ts";

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

async function securefixWorkflowRun(ctx: Ctx, workflow: string, event: string, head: string, title?: string): Promise<Run> {
  return until(`the ${workflow} workflow run`, async () => {
    const { data } = await ctx.gh.rest.actions.listWorkflowRuns({
      ...splitRepository(CLIENT), workflow_id: workflow, event, per_page: 20,
    });
    return data.workflow_runs.find((candidate) => title ? candidate.display_title === title : candidate.head_sha === head);
  });
}

async function requestSecurefix(ctx: Ctx, runId: number, op: "success" | "failure", logPattern?: RegExp): Promise<void> {
  const since = new Date();
  await smokeRequest(ctx, "securefix", String(runId));
  await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: runId } }, since, op, logPattern);
}

async function assertRefAbsent(ctx: Ctx, ref: string): Promise<void> {
  try {
    await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: `heads/${ref}` });
  } catch (error) {
    if (hasStatus(error, 404)) return;
    throw error;
  }
  throw new Error(`expected ${CLIENT} branch ${ref} to be absent`);
}

async function deleteRefIfPresent(ctx: Ctx, ref: string): Promise<void> {
  try {
    await ctx.gh.rest.git.deleteRef({ ...splitRepository(CLIENT), ref: `heads/${ref}` });
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
}

export const securefix: Scenario[] = [
  {
    id: "securefix.pr-write",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a securefix PR run writes its generated change to the same branch",
        classification: "mixed",
        checks: [
          "path-safety",
          "head-consistency",
          "replay"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "permitted",
            "expected": "Initial execution and retry write the generated change to the original branch"
          },
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "After an owner commit advances the branch, replay of the older request is rejected"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "a securefix PR run writes its generated change to the same branch",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-trigger.txt", fileContent: "valid\n" });
      try {
        const run = await securefixRun(ctx, pr);
        const completed = await waitRun(ctx, CLIENT, run.id);
        if (completed.conclusion !== "success") throw new Error(`client securefix run concluded ${completed.conclusion} (${completed.html_url})`);
        await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "success");
        const { data } = await ctx.gh.rest.repos.getContent({ ...splitRepository(CLIENT), path: "e2e/securefix-result.txt", ref: pr.branch });
        if (Array.isArray(data) || data.type !== "file") throw new Error("securefix result is not a file");
        const content = Buffer.from(data.content, "base64").toString("utf8");
        if (content !== `securefix run ${run.id}\n`) throw new Error(`securefix result has unexpected content: ${JSON.stringify(content)}`);
        await requestSecurefix(ctx, run.id, "success");
        const advanced = await ctx.gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
          "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
          { i: {
            branch: { repositoryNameWithOwner: CLIENT, branchName: pr.branch },
            message: { headline: `e2e advance ${pr.branch}` },
            expectedHeadOid: (await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number })).data.head.sha,
            fileChanges: { additions: [{ path: "e2e/securefix-followup.txt", contents: Buffer.from("advanced\n").toString("base64") }] },
          } },
        );
        assert(advanced.createCommitOnBranch.commit.oid !== pr.head, "signed follow-up commit did not move the PR head");
        await requestSecurefix(ctx, run.id, "failure", /branch moved after the request/u);
      } finally {
        await closePr(ctx, pr);
      }
    },
  },
  ...(["unsafe-path", "symlink", "file-limit", "single-file-size-limit", "total-size-limit"] as const).map((mode): Scenario => ({
    id: `securefix.client-${mode}`,
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: `the client rejects ${mode} changes before requesting a server write`,
        classification: "negative",
        checks: [
          "path-safety",
          "request-validation"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "The client rejects the declared invalid change before a server write"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: `the client rejects ${mode} changes before requesting a server write`,
    run: async (ctx: Ctx) => {
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-trigger.txt", fileContent: `${mode}\n` });
      try {
        const run = await securefixRun(ctx, pr);
        const completed = await waitRun(ctx, CLIENT, run.id);
        assert(completed.conclusion === "failure", `client securefix run concluded ${completed.conclusion} (${completed.html_url})`);
        const byName = await jobs(ctx, CLIENT, run.id);
        const packageJob = byName.get("package");
        assert(packageJob?.conclusion === "failure", `client package job did not reject ${mode} (${completed.html_url})`);
        const log = await jobLog(ctx, CLIENT, packageJob.id);
        const pattern = mode === "unsafe-path" ? /control character/iu
          : mode === "symlink" ? /symlink/iu
            : mode === "file-limit" ? /more than 512/u
              : mode === "single-file-size-limit" ? /larger than 8MB/u
                : /larger than 10MB in total/u;
        assert(pattern.test(log), `client rejected ${mode} for an unexpected reason (${completed.html_url})`);
      } finally {
        await closePr(ctx, pr);
      }
    },
  })),
  {
    id: "securefix.workflow-disabled",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "workflow changes are rejected when disabled in server configuration",
        classification: "negative",
        checks: [
          "path-safety"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "The server rejects workflow changes when they are disabled"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "workflow changes are rejected when disabled in server configuration",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-trigger.txt", fileContent: "workflow-change\n" });
      try {
        const run = await securefixRun(ctx, pr);
        const completed = await waitRun(ctx, CLIENT, run.id);
        assert(completed.conclusion === "success", `client securefix run concluded ${completed.conclusion} (${completed.html_url})`);
        await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "failure", /workflow changes are disabled/u);
      } finally {
        await closePr(ctx, pr);
      }
    },
  },
  {
    id: "securefix.forged-run",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "the server rejects a forged artifact whose run id does not match",
        classification: "negative",
        checks: [
          "request-validation"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "The server rejects the forged artifact run identity"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "the server rejects a forged artifact whose run id does not match",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-forged-trigger.txt", fileContent: "forged\n" });
      try {
        const run = await securefixWorkflowRun(ctx, "csm-ci-securefix-forged.yml", "pull_request", pr.head);
        const completed = await waitRun(ctx, CLIENT, run.id);
        assert(completed.conclusion === "success", `forged artifact workflow concluded ${completed.conclusion} (${completed.html_url})`);
        await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "failure", /metadata run does not match/u);
      } finally {
        await closePr(ctx, pr);
      }
    },
  },
  {
    id: "securefix.target-event",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "the server rejects pull_request_target securefix runs",
        classification: "negative",
        checks: [
          "request-validation"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "The server rejects pull_request_target securefix runs"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "the server rejects pull_request_target securefix runs",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-target-trigger.txt", fileContent: "target\n" });
      try {
        const run = await securefixWorkflowRun(ctx, "csm-ci-securefix-target.yml", "pull_request_target", pr.head, `csm-ci-securefix-target ${pr.number}`);
        const completed = await waitRun(ctx, CLIENT, run.id);
        assert(completed.conclusion === "success", `pull_request_target artifact workflow concluded ${completed.conclusion} (${completed.html_url})`);
        await requestSecurefix(ctx, run.id, "failure", /rejects pull_request_target/u);
      } finally {
        await closePr(ctx, pr);
      }
    },
  },
  {
    id: "securefix.route-path",
    cases: {},
    name: "a securefix route rejects a change outside its configured paths",
    serial: true,
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const run = await dispatch(ctx, CLIENT, "csm-ci-securefix-route.yml", { mode: "out-of-scope" });
      assert(run.conclusion === "success", `route artifact workflow concluded ${run.conclusion} (${run.html_url})`);
      await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "failure", /route does not allow path "README\.md"/u);
    },
  },
  {
    id: "securefix.route-refresh",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a fresh securefix route creates and repairs its pull request on retry",
        classification: "positive",
        checks: [
          "metadata-refresh",
          "branch-ownership"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "permitted",
            "expected": "The route creates one PR and retry restores its exact generated title and body without another commit"
          }
        ],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes only the configured managed branch and paths."
        ]
      }
    },
    name: "a fresh securefix route creates and repairs its pull request on retry",
    serial: true,
    run: async (ctx) => {
      const branch = "e2e-securefix-route";
      await assertRefAbsent(ctx, branch);
      await withCleanup(async () => {
        const since = new Date(Date.now() - 2_000);
        const run = await dispatch(ctx, CLIENT, "csm-ci-securefix-route.yml", { mode: "valid" });
        assert(run.conclusion === "success", `route artifact workflow concluded ${run.conclusion} (${run.html_url})`);
        await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "success");
        const pulls = await ctx.gh.paginate(ctx.gh.rest.pulls.list, {
          ...splitRepository(CLIENT), state: "open", base: "main", head: `${OWNER}:${branch}`, per_page: 100,
        });
        assert(pulls.length === 1, `expected one route pull request, found ${pulls.length}`);
        const pull = pulls[0]!;
        const initialHead = (await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: `heads/${branch}` })).data.object.sha;
        const title = "e2e-route: e2e route valid";
        const body = `Automated update for securefix route e2e-route.\n\ne2e route valid\n\n<!-- csm-ci:securefix:${run.id} -->`;
        assert(pull.title === title && pull.body === body, `route pull request has unexpected title or body (${pull.html_url})`);
        await labelPr(ctx.gh, CLIENT, pull.number, ctx.run, prCase(ctx, "fixture"));
        await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: pull.number, title: "e2e route changed title", body: "e2e route changed body" });

        await requestSecurefix(ctx, run.id, "success");
        const retriedPull = (await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pull.number })).data;
        const retriedHead = (await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: `heads/${branch}` })).data.object.sha;
        assert(retriedHead === initialHead, "route retry created another commit");
        assert(retriedPull.title === title && retriedPull.body === body, `route retry did not restore the pull request title and body (${retriedPull.html_url})`);
        await annotatePr(ctx.gh, CLIENT, pull.number, ctx.run, prCase(ctx, "fixture"));
      }, [async () => {
        try {
          const pulls = await ctx.gh.paginate(ctx.gh.rest.pulls.list, {
            ...splitRepository(CLIENT), state: "open", base: "main", head: `${OWNER}:${branch}`, per_page: 100,
          });
          for (const pull of pulls) await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: pull.number, state: "closed" });
        } finally {
          await deleteRefIfPresent(ctx, branch);
        }
      }]);
    },
  },
  {
    id: "securefix.route-version",
    cases: {},
    name: "a securefix route rejects a non-version-only package change",
    serial: true,
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const run = await dispatch(ctx, CLIENT, "csm-ci-securefix-route.yml", { mode: "version-only" });
      assert(run.conclusion === "success", `route artifact workflow concluded ${run.conclusion} (${run.html_url})`);
      await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "failure", /allows only version lines in "e2e\/securefix-version\.json"/u);
    },
  },
  {
    id: "securefix.route-default",
    cases: {},
    name: "a securefix route cannot write to the default branch",
    serial: true,
    run: async (ctx) => {
      const repo = splitRepository(SERVER);
      const path = "csm-ci.yaml";
      const original = (await ctx.gh.rest.repos.getContent({ ...repo, path, ref: "main" })).data;
      assert(!Array.isArray(original) && original.type === "file", "server config is not a file");
      const originalBytes = Buffer.from(original.content, "base64");
      const originalText = originalBytes.toString("utf8");
      const temporaryText = originalText.replace("to: e2e-securefix-route", "to: main");
      assert(temporaryText !== originalText, "server route fixture does not have the expected target branch");
      let temporaryConfigAttempted = false;
      try {
        temporaryConfigAttempted = true;
        await ctx.gh.rest.repos.createOrUpdateFileContents({
          ...repo, path, branch: "main", sha: original.sha, message: "e2e temporarily target the default branch", content: Buffer.from(temporaryText).toString("base64"),
        });
        const since = new Date(Date.now() - 2_000);
        const run = await dispatch(ctx, CLIENT, "csm-ci-securefix-route.yml", { mode: "valid" });
        assert(run.conclusion === "success", `route artifact workflow concluded ${run.conclusion} (${run.html_url})`);
        await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, since, "failure", /route cannot write to its source or default branch/u);
      } finally {
        if (temporaryConfigAttempted) {
          const current = (await ctx.gh.rest.repos.getContent({ ...repo, path, ref: "main" })).data;
          assert(!Array.isArray(current) && current.type === "file", "server config disappeared before restoration");
          if (Buffer.from(current.content, "base64").compare(originalBytes) !== 0) {
            await ctx.gh.rest.repos.createOrUpdateFileContents({
              ...repo, path, branch: "main", sha: current.sha, message: "e2e restore securefix route configuration", content: originalBytes.toString("base64"),
            });
          }
        }
      }
    },
  },
  {
    id: "securefix.alternate-base",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a PR from the same branch to a different base cannot redirect securefix",
        classification: "negative",
        checks: [
          "branch-ownership",
          "request-validation"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "Both shared-branch requests are rejected; the alternate base cannot redirect securefix"
          }
        ],
        identity: OWNER_IDENTITY
      },
      "alternate-base": {
        id: "alternate-base",
        target: "client",
        title: "Alternate base cannot redirect the shared securefix branch",
        classification: "negative",
        checks: [
          "branch-ownership",
          "request-validation"
        ],
        steps: [
          {
            "operation": "securefix",
            "outcome": "rejected",
            "expected": "Both shared-branch requests are rejected; the alternate base cannot redirect securefix"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "a PR from the same branch to a different base cannot redirect securefix",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const { data: main } = await ctx.gh.rest.repos.getBranch({ ...splitRepository(CLIENT), branch: "main" });
      const alternateBase = `e2e-base-${Date.now().toString(36)}`;
      await ctx.gh.rest.git.createRef({ ...splitRepository(CLIENT), ref: `refs/heads/${alternateBase}`, sha: main.commit.sha });
      let first: Awaited<ReturnType<typeof openPr>> | undefined;
      let secondNumber: number | undefined;
      await withCleanup(async () => {
        first = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: "e2e/securefix-trigger.txt", fileContent: "valid\n" });
        const { data: second } = await ctx.gh.rest.pulls.create({
          ...splitRepository(CLIENT),
          head: first.branch,
          base: alternateBase,
          title: prTitle(ctx.run, prCase(ctx, "alternate-base"), `alternate-base ${first.branch}`),
          body: prBody(ctx.run, prCase(ctx, "alternate-base")),
        });
        secondNumber = second.number;
        await labelPr(ctx.gh, CLIENT, second.number, ctx.run, prCase(ctx, "alternate-base"));
        const clientRuns = await until("both securefix client runs for the shared branch", async () => {
          const { data } = await ctx.gh.rest.actions.listWorkflowRuns({
            ...splitRepository(CLIENT), workflow_id: "csm-ci-securefix.yml", event: "pull_request", branch: first!.branch, per_page: 10,
          });
          const runs = data.workflow_runs.filter((run) => run.head_sha === first!.head && new Date(run.created_at) >= since);
          return runs.length === 2 ? runs : undefined;
        });
        for (const run of clientRuns) {
          const completed = await waitRun(ctx, CLIENT, run.id);
          assert(completed.conclusion === "success", `client securefix run concluded ${completed.conclusion} (${completed.html_url})`);
          const match: RequestMatch = { kind: "securefix", repository: CLIENT, args: { run_id: run.id } };
          await expectOp(ctx, match, since, "failure", /securefix (?:PR must target the default branch|PR head has more than one open pull request|PR run must map to exactly one pull request)/u);
        }
      }, [async () => {
        if (secondNumber !== undefined) await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: secondNumber, state: "closed" });
      }, async () => {
        if (first) await closePr(ctx, first);
      }, async () => {
        await ctx.gh.rest.git.deleteRef({ ...splitRepository(CLIENT), ref: `heads/${alternateBase}` }).catch((error: unknown) => {
          if (!(typeof error === "object" && error !== null && "status" in error && error.status === 404)) throw error;
        });
      }]);
    },
  },
];
