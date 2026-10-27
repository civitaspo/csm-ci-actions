// Helpers shared by the e2e scenarios. GitHub is the system under test, so every check reads the API.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { type GitHub, splitRepository } from "../src/lib/github.ts";
import { CARGO_RAW_TARGETS, CARGO_TARGETS, type Release, parseConfig } from "../src/lib/config.ts";
import { withCleanup } from "./cleanup.ts";
import { findRecentRunByTitle, matchesAcceptedRequest, matchesCleanupLabel, recentItems } from "./correlation.ts";

export const OWNER = "civitaspo";
export const ACTIONS = `${OWNER}/csm-ci-actions`;
export const SERVER = `${OWNER}/testing-csm-ci-server`;
export const CLIENT = `${OWNER}/testing-csm-ci-client`;
const FIXTURES = join(import.meta.dir, "fixtures");
const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;

export type Run = { id: number; html_url: string; status: string | null; conclusion: string | null; created_at: string; display_title: string };
export type Ctx = { gh: GitHub; urls: string[]; untrusted: GitHub | undefined };
export type Scenario = { name: string; needsUntrusted?: boolean; serial?: boolean; run: (ctx: Ctx) => Promise<void> };

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function hasStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && "status" in e && e.status === status;
}

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

export async function until<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

export async function moveE2eBranch(gh: GitHub, sha: string): Promise<void> {
  const repo = splitRepository(ACTIONS);
  try {
    await gh.rest.git.updateRef({ ...repo, ref: "heads/e2e", sha, force: true });
  } catch (e) {
    // GitHub answers 422 "Reference does not exist" when the branch is missing.
    if (!hasStatus(e, 422)) throw e;
    await gh.rest.git.createRef({ ...repo, ref: "refs/heads/e2e", sha });
  }
}

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? fixtureFiles(path) : [path];
  });
}

export async function syncFixtures(gh: GitHub): Promise<void> {
  for (const repository of [SERVER, CLIENT]) {
    const root = join(FIXTURES, repository.split("/")[1] ?? "");
    for (const file of fixtureFiles(root)) {
      const path = relative(root, file);
      const want = readFileSync(file, "utf8");
      let sha: string | undefined;
      let have: string | undefined;
      try {
        const { data } = await gh.rest.repos.getContent({ ...splitRepository(repository), path, ref: "main" });
        if (!Array.isArray(data) && data.type === "file") {
          sha = data.sha;
          have = Buffer.from(data.content, "base64").toString("utf8");
        }
      } catch (e) {
        if (!hasStatus(e, 404)) throw e;
      }
      if (have === want) continue;
      await gh.rest.repos.createOrUpdateFileContents({
        ...splitRepository(repository),
        path,
        message: `Sync csm-ci e2e fixture ${path}`,
        content: Buffer.from(want).toString("base64"),
        branch: "main",
        ...(sha ? { sha } : {}),
      });
      console.log(`synced ${repository}/${path}`);
    }
  }
}

export async function dispatch(ctx: Ctx, repository: string, workflow: string, inputs: Record<string, string> = {}): Promise<Run> {
  const since = new Date(Date.now() - 2_000);
  const correlatedWorkflow = workflow === "csm-ci-smoke.yml" || workflow === "csm-ci-release-verify.yml" || workflow === "csm-ci-release-pr.yml" || workflow === "csm-ci-repo-settings.yml";
  const correlation = correlatedWorkflow ? randomUUID() : undefined;
  const dispatchInputs = correlation ? { ...inputs, correlation } : inputs;
  await until(`dispatch of ${workflow}`, async () => {
    try {
      await ctx.gh.rest.actions.createWorkflowDispatch({ ...splitRepository(repository), workflow_id: workflow, ref: "main", inputs: dispatchInputs });
      return true;
    } catch (e) {
      // A just-synced workflow is briefly unknown to the dispatch API.
      if (hasStatus(e, 422)) return undefined;
      throw e;
    }
  });
  const run = await until(`the ${workflow} run ${correlation ?? ""}`, async () => {
    async function* pages() {
      const iterator = ctx.gh.paginate.iterator(ctx.gh.rest.actions.listWorkflowRuns, {
        ...splitRepository(repository), workflow_id: workflow, event: "workflow_dispatch", per_page: 100,
      });
      for await (const page of iterator) yield page.data;
    }
    if (correlation) return findRecentRunByTitle(pages(), since, `${workflow.replace(/\.yml$/, "")} ${correlation}`);
    return (await recentItems(pages(), since))[0];
  });
  return waitRun(ctx, repository, run.id);
}

export async function waitRun(ctx: Ctx, repository: string, id: number): Promise<Run> {
  const run = await until(`run ${id}`, async () => {
    const { data } = await ctx.gh.rest.actions.getWorkflowRun({ ...splitRepository(repository), run_id: id });
    return data.status === "completed" ? data : undefined;
  });
  ctx.urls.push(run.html_url);
  return run;
}

export async function recentWorkflowRuns(ctx: Ctx, repository: string, workflow: string, event: string, since: Date): Promise<Run[]> {
  async function* pages() {
    const iterator = ctx.gh.paginate.iterator(ctx.gh.rest.actions.listWorkflowRuns, {
      ...splitRepository(repository), workflow_id: workflow, event, per_page: 100,
    });
    for await (const page of iterator) yield page.data;
  }
  return recentItems(pages(), since);
}

export async function serverRuns(ctx: Ctx, match: RequestMatch, since: Date): Promise<Run[]> {
  const candidates = await recentWorkflowRuns(ctx, SERVER, "csm-ci.yml", "label", since);
  const found: Run[] = [];
  for (const run of candidates) {
    if (run.status !== "completed") continue;
    const byName = await jobs(ctx, SERVER, run.id);
    const intake = byName.get("intake");
    if (!intake) continue;
    if (match.label) {
      const cleanup = byName.get("cleanup");
      if (cleanup && matchesCleanupLabel(await jobLog(ctx, SERVER, cleanup.id), match.label)) found.push(run);
    } else if (intake.conclusion !== "skipped" && matchesAcceptedRequest(await jobLog(ctx, SERVER, intake.id), match)) {
      found.push(run);
    }
  }
  return found;
}

export async function jobs(ctx: Ctx, repository: string, runId: number): Promise<Map<string, { id: number; conclusion: string | null }>> {
  const { data } = await ctx.gh.rest.actions.listJobsForWorkflowRun({ ...splitRepository(repository), run_id: runId });
  return new Map(data.jobs.map((j) => [j.name.split(" / ").at(-1) ?? j.name, { id: j.id, conclusion: j.conclusion }]));
}

export async function jobLog(ctx: Ctx, repository: string, jobId: number): Promise<string> {
  const { data } = await ctx.gh.rest.actions.downloadJobLogsForWorkflowRun({ ...splitRepository(repository), job_id: jobId });
  return String(data);
}

export type Conclusion = "success" | "failure" | "skipped";

export async function expectServer(ctx: Ctx, match: RequestMatch, since: Date, intake: Conclusion, op: Conclusion, logPattern?: RegExp): Promise<void> {
  const run = (await until("the server run for the request", async () => (await serverRuns(ctx, match, since))[0]))!;
  await waitRun(ctx, SERVER, run.id);
  const byName = await jobs(ctx, SERVER, run.id);
  const intakeJob = byName.get("intake");
  assert(intakeJob?.conclusion === intake, `intake job concluded ${intakeJob?.conclusion}, expected ${intake} (${run.html_url})`);
  assert(byName.get("op")?.conclusion === op, `op job concluded ${byName.get("op")?.conclusion}, expected ${op} (${run.html_url})`);
  assert(byName.get("cleanup")?.conclusion === "success", `cleanup job did not succeed (${run.html_url})`);
  if (logPattern && intakeJob) {
    const log = await jobLog(ctx, SERVER, intakeJob.id);
    assert(logPattern.test(log), `intake log does not match ${logPattern} (${run.html_url})`);
  }
  assert(match.label, "request label is required to verify cleanup");
  let labelExists = false;
  try {
    await ctx.gh.rest.issues.getLabel({ ...splitRepository(SERVER), name: match.label });
    labelExists = true;
  } catch (e) {
    if (!hasStatus(e, 404)) throw e;
  }
  assert(!labelExists, `request label ${match.label} remains in ${SERVER}`);
}

export async function smokeRequest(ctx: Ctx, kind: string, args: string): Promise<{ since: Date; label: string }> {
  const run = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind, args });
  assert(run.conclusion === "success", `client request run concluded ${run.conclusion} (${run.html_url})`);
  const request = await until(`the request job of ${run.html_url}`, async () => (await jobs(ctx, CLIENT, run.id)).get("request"));
  const log = await jobLog(ctx, CLIENT, request.id);
  const label = /created label (csm-ci-[^ ]+) \(/.exec(log)?.[1];
  assert(label, `request label missing from ${run.html_url}`);
  return { since: new Date(new Date(run.created_at).getTime() - 2_000), label };
}

export const APPROVER_LOGIN = "testing-csm-ci-approver[bot]";
export const SERVER_BOT_ID = 347400474;

export type Pr = { number: number; head: string; branch: string };
export type RequestMatch = { kind: string; repository: string; args: Record<string, number>; label?: string };
export type ReleaseBuildType = Release["build_type"];

// signed: createCommitOnBranch, which GitHub signs as web-flow for the token's user.
// Otherwise the REST contents API, whose commits GitHub leaves unsigned.
export async function openPr(ctx: Ctx, kind: "signed" | "unsigned", as: GitHub = ctx.gh, author?: { name: string; email: string }, prAs: GitHub = ctx.gh, filePath?: string, draft = false, fileContent?: string): Promise<Pr> {
  const repo = splitRepository(CLIENT);
  const base = (await ctx.gh.rest.repos.getBranch({ ...repo, branch: "main" })).data.commit.sha;
  const branch = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await ctx.gh.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: base });
  const path = filePath ?? `e2e/${branch}.txt`;
  let head: string;
  if (kind === "signed") {
    const data = await as.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
      "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
      {
        i: {
          branch: { repositoryNameWithOwner: CLIENT, branchName: branch },
          message: { headline: `e2e ${branch}` },
          expectedHeadOid: base,
          fileChanges: { additions: [{ path, contents: Buffer.from(fileContent ?? `${branch}\n`).toString("base64") }] },
        },
      },
    );
    head = data.createCommitOnBranch.commit.oid;
  } else {
    const { data } = await as.rest.repos.createOrUpdateFileContents({
      ...repo,
      path,
      branch,
      message: `e2e ${branch}`,
      content: Buffer.from(fileContent ?? `${branch}\n`).toString("base64"),
      ...(author ? { author, committer: author } : {}),
    });
    head = data.commit.sha ?? "";
  }
  const { data: pr } = await prAs.rest.pulls.create({ ...repo, base: "main", head: branch, title: `e2e ${branch}`, ...(draft ? { draft: true } : {}) });
  return { number: pr.number, head, branch };
}

export async function withServerConfig<T>(ctx: Ctx, edit: (text: string) => string, run: () => Promise<T>): Promise<T> {
  const repository = splitRepository(SERVER);
  const read = async () => {
    const { data: head } = await ctx.gh.rest.git.getRef({ ...repository, ref: "heads/main" });
    const { data } = await ctx.gh.rest.repos.getContent({ ...repository, path: "csm-ci.yaml", ref: head.object.sha });
    assert(!Array.isArray(data) && data.type === "file", `expected ${SERVER}/csm-ci.yaml to be a file`);
    return { sha: data.sha, text: Buffer.from(data.content, "base64").toString("utf8") };
  };
  const write = async (sha: string, text: string, message: string) => ctx.gh.rest.repos.createOrUpdateFileContents({
    ...repository, path: "csm-ci.yaml", branch: "main", sha, message, content: Buffer.from(text).toString("base64"),
  });
  const visible = (text: string) => until("server fixture content visibility", async () => (await read()).text === text ? true : undefined);
  const original = await read();
  const changed = edit(original.text);
  parseConfig(changed);
  if (changed === original.text) return run();
  let pendingSha: string | undefined;
  return withCleanup(async () => {
    const { data } = await write(original.sha, changed, "Temporarily configure e2e server fixture");
    pendingSha = data.content?.sha;
    assert(pendingSha, "server fixture write returned no content SHA");
    await visible(changed);
    pendingSha = undefined;
    return run();
  }, [async () => {
    const latest = await read();
    if (latest.text === changed || (latest.text === original.text && pendingSha)) {
      await write(pendingSha ?? latest.sha, original.text, "Restore e2e server fixture");
      await visible(original.text);
    } else if (latest.text !== original.text) throw new Error("server fixture changed unexpectedly during e2e; refusing to overwrite it");
  }]);
}

export function configureRelease(type: ReleaseBuildType): (text: string) => string {
  return (text) => {
    const parsed = parseConfig(text);
    const repository = parsed.repositories.find((entry) => entry.name === CLIENT.toLowerCase());
    assert(repository?.release, `release config for ${CLIENT} is missing`);
    const release = type === "cargo" ? `release: { build_type: cargo, targets: [${CARGO_TARGETS.join(", ")}] }`
      : type === "cargo-raw" ? `release: { build_type: cargo-raw, binary: testing-csm-ci-client, targets: [${CARGO_RAW_TARGETS.join(", ")}] }`
      : type === "terraform-provider" ? "release: { build_type: terraform-provider, provider_name: csm-ci-test }"
      : `release: { build_type: ${type} }`;
    const pattern = /release: \{ build_type: [^}]+\}/;
    assert(pattern.test(text), "could not locate release build configuration");
    return text.replace(pattern, release);
  };
}

export const withoutReleaseOperation = (text: string): string => {
  const changed = text.replace("ops: [approve, merge, policy-check, securefix, release], release: { build_type: none }", "ops: [approve, merge, policy-check, securefix]");
  assert(changed !== text, "could not locate enabled release operation in fixture");
  return changed;
};

export async function openReleasePr(ctx: Ctx, version: string, additions: Record<string, string | null> = {}): Promise<Pr & { openedAt: Date }> {
  const repo = splitRepository(CLIENT);
  try {
    await ctx.gh.rest.git.getRef({ ...repo, ref: "heads/release/next" });
    throw new Error("ref release/next already exists; refusing to reuse it");
  } catch (e) {
    if (!hasStatus(e, 404)) throw e;
  }
  const base = (await ctx.gh.rest.repos.getBranch({ ...repo, branch: "main" })).data.commit.sha;
  const branch = "release/next";
  await ctx.gh.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: base });
  const files = { ".release-version": `${version}\n`, "e2e/release-request.txt": `${crypto.randomUUID()}\n`, ...additions };
  const since = new Date(Date.now() - 2_000);
  let ownedHead = base;
  try {
    const deletions: { path: string }[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (content !== null) continue;
      try {
        await ctx.gh.rest.repos.getContent({ ...repo, path, ref: base });
        deletions.push({ path });
      } catch (error) {
        if (!hasStatus(error, 404)) throw error;
      }
    }
    const data = await ctx.gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
      "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
      { i: { branch: { repositoryNameWithOwner: CLIENT, branchName: branch }, message: { headline: `e2e release ${version}` }, expectedHeadOid: base,
        fileChanges: {
          additions: Object.entries(files).flatMap(([path, content]) => content === null ? [] : [{ path, contents: Buffer.from(content).toString("base64") }]),
          deletions,
        } } },
    );
    ownedHead = data.createCommitOnBranch.commit.oid;
    const { data: pr } = await ctx.gh.rest.pulls.create({ ...repo, base: "main", head: branch, title: `e2e release ${version}` });
    return { number: pr.number, head: ownedHead, branch, openedAt: since };
  } catch (error) {
    const { data: pulls } = await ctx.gh.rest.pulls.list({ ...repo, state: "open", head: `${OWNER}:release/next`, per_page: 100 });
    for (const pr of pulls.filter((item) => item.title === `e2e release ${version}`)) {
      await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
    }
    try {
      const { data: ref } = await ctx.gh.rest.git.getRef({ ...repo, ref: "heads/release/next" });
      if (ref.object.sha === ownedHead) await ctx.gh.rest.git.deleteRef({ ...repo, ref: "heads/release/next" });
    } catch (cleanupError) {
      if (!hasStatus(cleanupError, 404)) throw cleanupError;
    }
    throw error;
  }
}

export async function closeReleasePrIfOwned(ctx: Ctx, pr: Pr): Promise<void> {
  const repo = splitRepository(CLIENT);
  const { data } = await ctx.gh.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (data.state === "open") await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
  try {
    const { data: ref } = await ctx.gh.rest.git.getRef({ ...repo, ref: "heads/release/next" });
    if (ref.object.sha === pr.head) await ctx.gh.rest.git.deleteRef({ ...repo, ref: "heads/release/next" });
  } catch (e) {
    if (!hasStatus(e, 404)) throw e;
  }
}

export async function closePr(ctx: Ctx, pr: Pr): Promise<void> {
  const repo = splitRepository(CLIENT);
  const { data } = await ctx.gh.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (data.state === "open") await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
  // With delete_branch_on_merge, GitHub may already have removed a merged head branch.
  if (data.merged) {
    try {
      await ctx.gh.rest.git.getRef({ ...repo, ref: `heads/${pr.branch}` });
    } catch (e) {
      if (hasStatus(e, 404)) return;
      throw e;
    }
  }
  await ctx.gh.rest.git.deleteRef({ ...repo, ref: `heads/${pr.branch}` });
}

export async function postComment(ctx: Ctx, pr: Pr, body: string, as: GitHub = ctx.gh): Promise<{ id: number; since: Date; authorAssociation: string }> {
  const since = new Date(Date.now() - 2_000);
  const { data } = await as.rest.issues.createComment({ ...splitRepository(CLIENT), issue_number: pr.number, body });
  return { id: Number(data.id), since, authorAssociation: data.author_association ?? "" };
}

export async function approverReviews(ctx: Ctx, pr: Pr): Promise<{ id: number; state: string; commit_id: string | null; body: string }[]> {
  const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { ...splitRepository(CLIENT), pull_number: pr.number, per_page: 100 });
  return reviews.filter((r) => r.user?.login === APPROVER_LOGIN).map((r) => ({ id: Number(r.id), state: r.state, commit_id: r.commit_id, body: r.body }));
}

export async function serverComments(ctx: Ctx, pr: Pr): Promise<string[]> {
  const comments = await ctx.gh.paginate(ctx.gh.rest.issues.listComments, { ...splitRepository(CLIENT), issue_number: pr.number, per_page: 100 });
  return comments.filter((c) => Number(c.user?.id) === SERVER_BOT_ID).map((c) => c.body ?? "");
}

// Waits for the one server run started since `since` and checks its op job.
export async function expectOp(ctx: Ctx, match: RequestMatch, since: Date, op: Conclusion, logPattern?: RegExp): Promise<void> {
  const run = (await until("the server run for the request", async () => (await serverRuns(ctx, match, since))[0]))!;
  await waitRun(ctx, SERVER, run.id);
  const byName = await jobs(ctx, SERVER, run.id);
  const opJob = byName.get("op");
  assert(byName.get("intake")?.conclusion === "success", `intake job concluded ${byName.get("intake")?.conclusion} (${run.html_url})`);
  assert(opJob?.conclusion === op, `op job concluded ${opJob?.conclusion}, expected ${op} (${run.html_url})`);
  if (logPattern && opJob) {
    const log = await jobLog(ctx, SERVER, opJob.id);
    assert(logPattern.test(log), `op log does not match ${logPattern} (${run.html_url})`);
  }
}
