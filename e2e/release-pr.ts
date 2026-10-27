import { withCleanup } from "./cleanup.ts";
import { prCase } from "./harness.ts";
import { annotatePr, assertGeneratedMetadata, labelPr } from "./pr-metadata.ts";
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
  await withCleanup(() => run(runIds), [async () => {
    for (const pr of await pulls(ctx)) {
      const owned = Number(pr.user?.id) === SERVER_BOT_ID && [...runIds].some((id) => pr.body?.includes(`<!-- csm-ci:securefix:${id} -->`));
      if (!owned) throw new Error(`release PR ${pr.number} is not owned by this scenario; refusing cleanup`);
      const { data: ref } = await ctx.gh.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
      assert(ref.object.sha === pr.head.sha, "release branch moved during cleanup");
      await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
      await ctx.gh.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    }
  }]);
}

function assertReleaseMetadata(pr: { title: string; body: string | null }, version: string, runId: number): void {
  assertGeneratedMetadata(pr, {
    title: `chore(release): v${version}`,
    body: `Automated update for securefix route release-pr.\n\nchore(release): v${version}\n\n<!-- csm-ci:securefix:${runId} -->`,
  });
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
  assertReleaseMetadata(pr, actual, run.id);
  await labelPr(ctx.gh, CLIENT, pr.number, ctx.run, prCase(ctx, "fixture"));
  const changelog = await read(ctx, "CHANGELOG.md", branch);
  assert(changelog.length > 0 && changelog.includes(actual), "CHANGELOG does not include the release version");
  const packageJson: unknown = JSON.parse(await read(ctx, "package.json", branch));
  assert(typeof packageJson === "object" && packageJson !== null && "version" in packageJson && packageJson.version === actual, "root package.json version was not bumped");
  assert((await read(ctx, "Cargo.toml", branch)).includes(`version = "${actual}"`), "root Cargo version was not bumped");
  assert((await read(ctx, "Cargo.lock", branch)).includes(`version = "${actual}"`), "root Cargo.lock version was not bumped");
  assert(await read(ctx, "pyproject.toml", branch) === `[project]\nname = "release-fixture"\nversion = "${actual}"\n\n[tool.fixture]\nversion = "9.0.0"\n`, "root pyproject version was not bumped or other content changed");
  assert(await read(ctx, "dbt_project.yml", branch) === `name: release_fixture\nversion: ${actual} # package version\nconfig-version: 2\nvars:\n  version: 9.0.0\n`, "root dbt version was not bumped or other content changed");
  assert(await read(ctx, "herdr-plugin.toml", branch) === await read(ctx, "herdr-plugin.toml", pr.base.sha), "omitted version files changed herdr-plugin.toml");
  ctx.urls.push(pr.html_url);
  await annotatePr(ctx.gh, CLIENT, pr.number, ctx.run, prCase(ctx, "fixture"));
  return pr;
}

async function expectGenerationRejected(ctx: Ctx, inputs: Record<string, string>, message: string): Promise<void> {
  const run = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", inputs);
  assert(run.conclusion === "failure", `rejected generation did not fail the client (${run.html_url})`);
  const byName = await jobs(ctx, CLIENT, run.id);
  const generate = byName.get("generate");
  assert(generate?.conclusion === "failure", "generation did not fail");
  assert((await jobLog(ctx, CLIENT, generate.id)).includes(message), `generation failed for an unexpected reason; expected ${JSON.stringify(message)}`);
  const artifacts = await ctx.gh.paginate(ctx.gh.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
  assert(artifacts.length === 0, "rejected generation uploaded an artifact");
  assert([...byName.values()].every((job) => job === generate || job.conclusion === "skipped"), "rejected generation ran another release-pr job");
}

const MANIFESTS = ["package.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "dbt_project.yml", "herdr-plugin.toml"];

// Dispatches with an explicit list and requires exactly the listed manifests to change, each only in its root version.
function versionFilesScenario(input: { id: string; title: string; expected: string; files: string[] }): Scenario {
  return {
    id: `release-pr.version-files-${input.id}`,
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: input.title,
        classification: "positive",
        checks: ["path-safety", "release-publication"],
        steps: [{ operation: "release-pr", outcome: "permitted", expected: input.expected }],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes only the configured managed branch and paths.",
        ],
      },
    },
    name: input.title,
    serial: true,
    run: (ctx) => withReleaseBranch(ctx, async (ids) => {
      const version = `1.1.${Date.now()}`;
      const base = (await ctx.gh.rest.repos.getBranch({ ...repo, branch: "main" })).data.commit.sha;
      const originals = await Promise.all(MANIFESTS.map((path) => read(ctx, path, base)));
      const run = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version, "version-files": JSON.stringify(input.files) });
      ids.add(run.id);
      assert(run.conclusion === "success", `release-pr failed (${run.html_url})`);
      await expectOp(ctx, { kind: "securefix", repository: CLIENT, args: { run_id: run.id } }, new Date(run.created_at), "success");
      const open = await pulls(ctx);
      assert(open.length === 1 && open[0], "release-pr did not create exactly one pull request");
      const pr = open[0];
      assert(Number(pr.user?.id) === SERVER_BOT_ID && pr.base.ref === "main", "release PR identity or base is incorrect");
      assertReleaseMetadata(pr, version, run.id);
      assert(await read(ctx, ".release-version", branch) === `${version}\n`, "release version was not generated");
      assert((await read(ctx, "CHANGELOG.md", branch)).includes(version), "changelog was not generated");
      for (const [index, path] of MANIFESTS.entries()) {
        const original = originals[index] ?? "";
        const current = original.match(/^version = "([^"]+)"/mu)?.[1];
        const want = input.files.includes(path) && current ? original.replace(`version = "${current}"`, `version = "${version}"`) : original;
        assert(await read(ctx, path, branch) === want, `${path} does not match the expected version file update`);
      }
      const files = await ctx.gh.paginate(ctx.gh.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
      assert(JSON.stringify(files.map((file) => file.filename).sort()) === JSON.stringify([".release-version", "CHANGELOG.md", ...input.files].sort()), "version files changed unexpected files");
      ctx.urls.push(pr.html_url);
      await annotatePr(ctx.gh, CLIENT, pr.number, ctx.run, prCase(ctx, "fixture"));
    }),
  };
}

export const releasePr: Scenario[] = [
  versionFilesScenario({
    id: "empty",
    title: "an empty version file list preserves manifests and generates only the release version and changelog",
    expected: "Generation creates only the release version and changelog, preserving root manifests",
    files: [],
  }),
  versionFilesScenario({
    id: "explicit",
    title: "an explicit version file list updates exactly the listed Cargo and Herdr manifests",
    expected: "Generation updates the release version, changelog, Cargo.toml, Cargo.lock and the root herdr-plugin.toml version only",
    files: ["Cargo.toml", "Cargo.lock", "herdr-plugin.toml"],
  }),
  {
    id: "release-pr.explicit-refresh",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "an explicit release version creates one PR and a repeated request updates its metadata",
        classification: "positive",
        checks: [
          "metadata-refresh",
          "replay"
        ],
        steps: [
          {
            "operation": "release-pr",
            "outcome": "permitted",
            "expected": "Generation creates one PR; repeated generation refreshes metadata without changing its exact generated commit; a new version rebuilds the branch and keeps the same open PR"
          }
        ],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes only the configured managed branch and paths."
        ]
      }
    },
    name: "an explicit release version creates one PR and a repeated request updates its metadata",
    serial: true,
    run: (ctx) => withReleaseBranch(ctx, async (ids) => {
      const version = `1.1.${Date.now()}`;
      const first = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version });
      const pr = await expectReleasePr(ctx, first, ids, version);
      await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, title: `release-pr: chore(release): v${version}` });
      const repeated = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version });
      const updated = await expectReleasePr(ctx, repeated, ids, version);
      assert(updated.number === pr.number && updated.head.sha === pr.head.sha, "repeated generation replaced the PR or changed its exact generated commit");
      const nextVersion = `1.1.${Date.now()}`;
      const rebuilt = await dispatch(ctx, CLIENT, "csm-ci-release-pr.yml", { version: nextVersion });
      const rebuiltPr = await expectReleasePr(ctx, rebuilt, ids, nextVersion);
      assert(rebuiltPr.number === pr.number && rebuiltPr.head.sha !== pr.head.sha, "rebuilding the release branch replaced the PR or kept the previous commit");
      const { data: current } = await ctx.gh.rest.pulls.get({ ...repo, pull_number: pr.number });
      assert(current.state === "open" && !current.merged && current.head.sha === rebuiltPr.head.sha, "rebuilding the release branch closed the PR or left it on another commit");
    }),
  },
  {
    id: "release-pr.inferred-version",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a default-branch push infers the version and opens a release PR",
        classification: "positive",
        checks: [
          "release-publication"
        ],
        steps: [
          {
            "operation": "release-pr",
            "outcome": "permitted",
            "expected": "A default-branch push infers the version and opens one release PR"
          }
        ],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes only the configured managed branch and paths."
        ]
      }
    },
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
    id: "release-pr.invalid-version",
    cases: {},
    name: "an invalid explicit version fails before a securefix artifact or request is created",
    serial: true,
    run: (ctx) => expectGenerationRejected(ctx, { version: "not-semver" }, "not valid SemVer"),
  },
  {
    id: "release-pr.version-files-unsupported",
    cases: {},
    name: "an unsupported version file fails before a securefix artifact or request is created",
    serial: true,
    run: (ctx) => expectGenerationRejected(ctx, { version: "1.2.3", "version-files": '["Cargo.toml","README.md"]' }, 'version file "README.md" is not supported'),
  },
  {
    id: "release-pr.non-default",
    cases: {},
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
        const byName = await until("completed non-default release-pr jobs", async () => {
          const found = await jobs(ctx, CLIENT, run.id);
          return found.has("generate") && [...found.values()].every((job) => job.conclusion !== null) ? found : undefined;
        });
        assert([...byName.values()].every((job) => job.conclusion === "skipped"), "non-default dispatch ran a release-pr job");
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
