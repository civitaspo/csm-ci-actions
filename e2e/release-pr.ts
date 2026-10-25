import { randomUUID } from "node:crypto";
import { splitRepository } from "../src/lib/github.ts";
import { parseSemVer } from "../src/release/semver.ts";
import { CLIENT, OWNER, SERVER_BOT_ID, assert, dispatch, expectOp, hasStatus, jobLog, jobs, until, waitRun, type Ctx, type Run, type Scenario } from "./harness.ts";

const repo = splitRepository(CLIENT);
const branch = "release/next";

async function read(ctx: Ctx, path: string, ref: string): Promise<string> {
  const { data } = await ctx.gh.rest.repos.getContent({ ...repo, path, ref });
  assert(!Array.isArray(data) && data.type === "file", `${path} is not a file`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function pulls(ctx: Ctx) {
  return ctx.gh.paginate(ctx.gh.rest.pulls.list, { ...repo, state: "open", head: `${OWNER}:${branch}`, per_page: 100 });
}

async function withReleaseBranch(ctx: Ctx, run: (runIds: Set<number>) => Promise<void>): Promise<void> {
  try {
    await ctx.gh.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    throw new Error(`${branch} already exists; refusing to reuse it`);
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
  const runIds = new Set<number>();
  try {
    await run(runIds);
  } finally {
    for (const pr of await pulls(ctx)) {
      const owned = Number(pr.user?.id) === SERVER_BOT_ID && [...runIds].some((id) => pr.body?.includes(`<!-- csm-ci:securefix:${id} -->`));
      if (!owned) throw new Error(`release PR ${pr.number} is not owned by this scenario; refusing cleanup`);
      const { data: ref } = await ctx.gh.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
      assert(ref.object.sha === pr.head.sha, "release branch moved during cleanup");
      await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
      await ctx.gh.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    }
  }
}

async function expectReleasePr(ctx: Ctx, run: Run, runIds: Set<number>, version?: string) {
  runIds.add(run.id);
  assert(run.conclusion === "success", `release-pr client failed (${run.html_url})`);
  await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, new Date(run.created_at), "success");
  const open = await pulls(ctx);
  assert(open.length === 1 && open[0], "release-pr did not create exactly one pull request");
  const pr = open[0];
  assert(Number(pr.user?.id) === SERVER_BOT_ID && pr.base.ref === "main", "release PR identity or base is incorrect");
  const actual = (await read(ctx, ".release-version", branch)).trim();
  assert(parseSemVer(actual), `generated version ${JSON.stringify(actual)} is not SemVer`);
  if (version) assert(actual === version, `expected version ${version}, received ${actual}`);
  assert(pr.title === `release-pr: chore(release): v${actual}`, `unexpected release PR title ${JSON.stringify(pr.title)}`);
  assert(pr.body?.includes(`<!-- csm-ci:securefix:${run.id} -->`), "release PR body does not identify the latest run");
  const changelog = await read(ctx, "CHANGELOG.md", branch);
  assert(changelog.length > 0 && changelog.includes(actual), "CHANGELOG does not include the release version");
  const packageJson: unknown = JSON.parse(await read(ctx, "package.json", branch));
  assert(typeof packageJson === "object" && packageJson !== null && "version" in packageJson && packageJson.version === actual, "root package.json version was not bumped");
  assert((await read(ctx, "Cargo.toml", branch)).includes(`version = "${actual}"`), "root Cargo version was not bumped");
  assert((await read(ctx, "Cargo.lock", branch)).includes(`version = "${actual}"`), "root Cargo.lock version was not bumped");
  ctx.urls.push(pr.html_url);
  return pr;
}

export const releasePr: Scenario[] = [
  {
    name: "an explicit release version creates one PR and a repeated request updates its metadata",
    serial: true,
    run: (ctx) => withReleaseBranch(ctx, async (ids) => {
      const version = `1.1.${Date.now()}`;
      const first = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version });
      const pr = await expectReleasePr(ctx, first, ids, version);
      const repeated = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version });
      const updated = await expectReleasePr(ctx, repeated, ids, version);
      assert(updated.number === pr.number && updated.head.sha === pr.head.sha, "repeated generation replaced the PR or changed its exact generated commit");
    }),
  },
  {
    name: "a default-branch push infers the version and opens a release PR",
    serial: true,
    run: (ctx) => withReleaseBranch(ctx, async (ids) => {
      const base = (await ctx.gh.rest.repos.getBranch({ ...repo, branch: "main" })).data.commit.sha;
      const result = await ctx.gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
        "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
        { i: { branch: { repositoryNameWithOwner: CLIENT, branchName: "main" }, expectedHeadOid: base,
          message: { headline: "fix: exercise inferred release PR version" },
          fileChanges: { additions: [{ path: "e2e/release-pr-trigger.txt", contents: Buffer.from(`${randomUUID()}\n`).toString("base64") }] } } },
      );
      const sha = result.createCommitOnBranch.commit.oid;
      const started = await until("release-pr push run", async () => {
        const { data } = await ctx.gh.rest.actions.listWorkflowRuns({ ...repo, workflow_id: "csm-ci-release-pr.yml", event: "push", head_sha: sha, per_page: 20 });
        return data.workflow_runs.find((candidate) => candidate.head_sha === sha && candidate.display_title === `csm-ci-release-pr ${sha}`);
      });
      await expectReleasePr(ctx, await waitRun(ctx, CLIENT, started.id), ids);
    }),
  },
  {
    name: "an invalid explicit version fails before a securefix artifact or request is created",
    serial: true,
    run: async (ctx) => {
      const run = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version: "not-semver" });
      assert(run.conclusion === "failure", "invalid release version did not fail the client");
      const byName = await jobs(ctx, CLIENT, run.id);
      const generate = byName.get("generate");
      assert(generate?.conclusion === "failure", "generation did not reject invalid SemVer");
      assert(/not valid SemVer/.test(await jobLog(ctx, CLIENT, generate.id)), "invalid version failed for an unexpected reason");
      const artifacts = await ctx.gh.paginate(ctx.gh.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
      assert(artifacts.length === 0, "invalid version uploaded an artifact");
      assert([...byName.values()].every((job) => job === generate || job.conclusion === "skipped"), "invalid version ran a request job");
    },
  },
  {
    name: "a manual dispatch from a non-default branch skips generation and requesting",
    serial: true,
    run: async (ctx) => {
      const sha = (await ctx.gh.rest.repos.getBranch({ ...repo, branch: "main" })).data.commit.sha;
      const ref = `e2e-release-pr-${randomUUID()}`;
      const correlation = randomUUID();
      await ctx.gh.rest.git.createRef({ ...repo, ref: `refs/heads/${ref}`, sha });
      try {
        await ctx.gh.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: "csm-ci-release-pr.yml", ref, inputs: { correlation, version: "1.2.3" } });
        const started = await until("non-default release-pr dispatch", async () => {
          const { data } = await ctx.gh.rest.actions.listWorkflowRuns({ ...repo, workflow_id: "csm-ci-release-pr.yml", event: "workflow_dispatch", branch: ref, per_page: 20 });
          return data.workflow_runs.find((run) => run.display_title === `csm-ci-release-pr ${correlation}`);
        });
        const run = await waitRun(ctx, CLIENT, started.id);
        assert(run.conclusion === "skipped", "non-default dispatch did not skip");
        const byName = await jobs(ctx, CLIENT, run.id);
        assert(byName.size > 0 && [...byName.values()].every((job) => job.conclusion === "skipped"), "non-default dispatch ran a release-pr job");
        const artifacts = await ctx.gh.paginate(ctx.gh.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
        assert(artifacts.length === 0, "non-default dispatch uploaded an artifact");
      } finally {
        const { data } = await ctx.gh.rest.git.getRef({ ...repo, ref: `heads/${ref}` });
        assert(data.object.sha === sha, "non-default test branch moved; refusing cleanup");
        await ctx.gh.rest.git.deleteRef({ ...repo, ref: `heads/${ref}` });
      }
    },
  },
];
