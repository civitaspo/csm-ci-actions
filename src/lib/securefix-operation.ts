import { type Config, type SecurefixRoute } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { MAX_SECUREFIX_FILE_SIZE, MAX_SECUREFIX_TOTAL_SIZE, SECUREFIX_ARTIFACT, bindSecurefixPullRequest, findSecurefixRoute, readSecurefixArtifact, validateRouteChanges, validateSecurefixRouteCommitFile, validateSecurefixRouteHead, validateSecurefixRun, type SecurefixChange, type SecurefixManifest, type SecurefixRun, SecurefixRunSchema } from "./securefix.ts";
import { Rejection } from "./request.ts";
import { GitRefChanged, resetBranchWithLease } from "./git-ref.ts";

type Artifact = { id: number; name: string; expired: boolean; size_in_bytes: number };
type Repo = { id: number | bigint; default_branch: string };
type Pull = {
  number: number;
  state: string;
  draft?: boolean;
  title: string;
  body: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
};
type Context = { owner: string; repo: string; repository: string; repoInfo: Repo; run: SecurefixRun; route: SecurefixRoute | null; pull: Pull | null; artifact: Artifact };
export type SecurefixInspection = { status: "already-applied" | "ready"; requiresWorkflowsWrite: boolean; context: Context; manifest: SecurefixManifest; changes: SecurefixChange[]; routeTargetSha?: string | null };

const MAX_ARTIFACT_SIZE = MAX_SECUREFIX_TOTAL_SIZE + 1024 * 1024;

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

async function loadContext(gh: GitHub, config: Config, repository: string, runId: number): Promise<Context> {
  const { owner, repo } = splitRepository(repository);
  const [{ data: rawRun }, repoResponse] = await Promise.all([
    gh.rest.actions.getWorkflowRun({ owner, repo, run_id: runId }),
    gh.rest.repos.get({ owner, repo }),
  ]);
  const repoInfo = repoResponse.data;
  const run = SecurefixRunSchema.parse(rawRun);
  validateSecurefixRun(run, runId, repository);
  const artifactList = await gh.paginate(gh.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: runId, per_page: 100 });
  const artifacts = artifactList.filter((artifact) => artifact.name === SECUREFIX_ARTIFACT);
  if (artifacts.length !== 1) throw new Rejection(`workflow run must have exactly one ${SECUREFIX_ARTIFACT} artifact`);
  const artifact = artifacts[0];
  if (!artifact || artifact.expired) throw new Rejection("securefix artifact is expired or missing");
  if (artifact.size_in_bytes > MAX_ARTIFACT_SIZE) throw new Rejection("securefix artifact exceeds the 11MB archive limit");
  if (Number(run.repository.id) !== Number(repoInfo.id)) throw new Rejection("workflow run repository does not match the requested repository");
  if (!run.head_repository || Number(run.head_repository.id) !== Number(repoInfo.id)) throw new Rejection("securefix workflow run head repository does not match the requested repository");

  let route: SecurefixRoute | null = null;
  let pull: Pull | null = null;
  if (run.event === "pull_request") {
    const bound = run.pull_requests[0];
    if (!bound) throw new Rejection("securefix PR run must map to exactly one pull request");
    const { data: pullData } = await gh.rest.pulls.get({ owner, repo, pull_number: bound.number });
    if (!pullData.head.repo || Number(pullData.head.repo.id) !== Number(repoInfo.id)) throw new Rejection("securefix does not accept fork pull requests");
    pull = pullData;
    const listed = await gh.paginate(gh.rest.pulls.list, { owner, repo, state: "open", head: `${owner}:${bound.head.ref}`, per_page: 100 });
    bindSecurefixPullRequest(run, repoInfo.default_branch, pullData, listed.length, repository);
  } else {
    const securefix = config.securefix;
    if (!securefix) throw new Rejection("securefix configuration is missing");
    route = findSecurefixRoute(securefix.routes, run, repoInfo.default_branch);
    const from = route.from === "default" ? repoInfo.default_branch : route.from;
    if (route.to === "default" || route.to === repoInfo.default_branch || route.to === from) throw new Rejection("securefix route cannot write to its source or default branch");
    const { data: ref } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${from}` });
    validateSecurefixRouteHead(run, route, repoInfo.default_branch, ref.object.sha);
  }
  return { owner, repo, repository, repoInfo, run, route, pull, artifact };
}

export async function locateSecurefix(gh: GitHub, config: Config, repository: string, runId: number): Promise<{ context: Context; result: string }> {
  const context = await loadContext(gh, config, repository, runId);
  return { context, result: "located" };
}

export async function inspectSecurefix(gh: GitHub, config: Config, repository: string, runId: number, artifactPath: string): Promise<SecurefixInspection> {
  const context = await loadContext(gh, config, repository, runId);
  const { manifest, changes } = await readSecurefixArtifact(artifactPath, { repository, runId, headSha: context.run.head_sha });
  if (changes.length === 0) throw new Rejection("securefix artifact contains no changes");
  await validateSafeBasePaths(gh, context, changes);
  let originals = new Map<string, Buffer | null>();
  let routeTargetSha: string | null | undefined;
  if (context.route) {
    originals = await readOriginalFiles(gh, context, changes);
    validateRouteChanges(context.route, changes, originals);
  }
  const alreadyApplied = await isAlreadyApplied(gh, config, context, changes);
  if (alreadyApplied) return { status: "already-applied", requiresWorkflowsWrite: false, context, manifest, changes };
  if (!context.route && context.pull?.head.sha !== context.run.head_sha) throw new Rejection("the branch moved after the request");
  if (context.route) routeTargetSha = await validateRouteBranch(gh, config, context);
  const requiresWorkflowsWrite = changes.some((change) => change.path.startsWith(".github/workflows/"));
  if (requiresWorkflowsWrite && !config.securefix?.allow_workflow_changes) throw new Rejection("workflow changes are disabled by securefix configuration");
  return { status: "ready", requiresWorkflowsWrite, context, manifest, changes, ...(routeTargetSha === undefined ? {} : { routeTargetSha }) };
}

export async function applySecurefix(gh: GitHub, config: Config, repository: string, runId: number, artifactPath: string, writeToken: string): Promise<{ status: "applied" | "already-applied"; commit: string; pullRequest?: number }> {
  const inspection = await inspectSecurefix(gh, config, repository, runId, artifactPath);
  const { context, manifest, changes } = inspection;
  const branch = context.route?.to ?? context.run.head_branch;
  if (inspection.status === "already-applied") {
    const commit = await branchHead(gh, context, branch);
    if (!context.route) return { status: "already-applied", commit };
    const pullRequest = await ensureRoutePullRequest(gh, context, context.route, manifest, branch);
    return { status: "already-applied", commit, pullRequest };
  }
  const expectedHead = context.run.head_sha;
  if (context.route) await resetRouteBranch(context, context.route, expectedHead, inspection.routeTargetSha ?? null, writeToken);
  let commit: string;
  try {
    commit = await createCommit(gh, context, branch, expectedHead, manifest.message, changes);
  } catch (error) {
    const applied = await isAlreadyApplied(gh, config, context, changes);
    if (applied) {
      const commit = await branchHead(gh, context, branch);
      if (context.route) {
        const pullRequest = await ensureRoutePullRequest(gh, context, context.route, manifest, branch);
        return { status: "already-applied", commit, pullRequest };
      }
      return { status: "already-applied", commit };
    }
    if (isCompareAndSwapFailure(error) || await branchHead(gh, context, branch) !== expectedHead) throw new Rejection("the branch moved after the request");
    throw error;
  }
  let pullRequest: number | undefined;
  if (context.route) pullRequest = await ensureRoutePullRequest(gh, context, context.route, manifest, branch);
  return pullRequest === undefined ? { status: "applied", commit } : { status: "applied", commit, pullRequest };
}

async function validateSafeBasePaths(gh: GitHub, context: Context, changes: readonly SecurefixChange[]): Promise<void> {
  const { data: commit } = await gh.rest.repos.getCommit({ owner: context.owner, repo: context.repo, ref: context.run.head_sha });
  const trees = new Map<string, Promise<Awaited<ReturnType<GitHub["rest"]["git"]["getTree"]>>["data"]>>();
  const readTree = (sha: string) => {
    let pending = trees.get(sha);
    if (!pending) {
      pending = gh.rest.git.getTree({ owner: context.owner, repo: context.repo, tree_sha: sha }).then(({ data }) => {
        if (data.truncated) throw new Rejection("securefix could not safely inspect the base Git tree");
        return data;
      });
      trees.set(sha, pending);
    }
    return pending;
  };
  for (const change of changes) {
    const segments = change.path.split("/");
    let treeSha = commit.commit.tree.sha;
    for (const [index, segment] of segments.entries()) {
      const tree = await readTree(treeSha);
      const entry = tree.tree.find((candidate) => candidate.path === segment);
      if (!entry) break;
      const path = segments.slice(0, index + 1).join("/");
      if (index < segments.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000" || !entry.sha) {
          throw new Rejection(`securefix path ${JSON.stringify(change.path)} traverses a non-directory Git entry at ${JSON.stringify(path)}`);
        }
        treeSha = entry.sha;
      } else if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        throw new Rejection(`securefix path ${JSON.stringify(change.path)} is not a regular file in the base Git tree`);
      }
    }
  }
}

async function readOriginalFiles(gh: GitHub, context: Context, changes: readonly SecurefixChange[]): Promise<Map<string, Buffer | null>> {
  const originals = new Map<string, Buffer | null>();
  const paths = changes.filter((change) => change.kind === "write").map((change) => change.path);
  const results = await Promise.all(paths.map(async (path) => {
    try {
      const content = await readRepositoryFile(gh, context, path, context.run.head_sha);
      return [path, content] as const;
    } catch (error) {
      if (httpStatus(error) === 404) return [path, null] as const;
      throw error;
    }
  }));
  for (const [path, content] of results) originals.set(path, content);
  return originals;
}

async function readRepositoryFile(gh: GitHub, context: Context, path: string, ref: string): Promise<Buffer | null> {
  let object: Awaited<ReturnType<GitHub["rest"]["repos"]["getContent"]>>["data"];
  try {
    ({ data: object } = await gh.rest.repos.getContent({ owner: context.owner, repo: context.repo, path, ref }));
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
  if (Array.isArray(object) || object.type !== "file") throw new Rejection(`securefix path ${JSON.stringify(path)} is not a file`);
  const { data: blob } = await gh.rest.git.getBlob({ owner: context.owner, repo: context.repo, file_sha: object.sha });
  if (blob.encoding !== "base64") throw new Rejection(`securefix file ${JSON.stringify(path)} has an unsupported Git blob encoding`);
  return Buffer.from(blob.content.replaceAll("\n", ""), "base64");
}

async function branchHead(gh: GitHub, context: Context, branch: string): Promise<string> {
  const { data } = await gh.rest.git.getRef({ owner: context.owner, repo: context.repo, ref: `heads/${branch}` });
  return data.object.sha;
}

async function isAlreadyApplied(gh: GitHub, config: Config, context: Context, changes: readonly SecurefixChange[]): Promise<boolean> {
  const branch = context.route?.to ?? context.run.head_branch;
  let head: string;
  try {
    head = await branchHead(gh, context, branch);
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
  if (head === context.run.head_sha) return false;
  const { data: commit } = await gh.rest.repos.getCommit({ owner: context.owner, repo: context.repo, ref: head });
  if (commit.parents.length !== 1 || commit.parents[0]?.sha !== context.run.head_sha) return false;
  if (!await isServerMadeCommit(gh, context, head, config.apps.server_bot_id)) return false;
  if (!await exactChangedPaths(gh, context, commit.parents[0].sha, commit.commit.tree.sha, changes)) return false;
  return await contentMatches(gh, context, head, changes);
}

async function exactChangedPaths(
  gh: GitHub,
  context: Context,
  parentSha: string,
  commitTreeSha: string,
  changes: readonly SecurefixChange[],
): Promise<boolean> {
  const { data: parent } = await gh.rest.repos.getCommit({ owner: context.owner, repo: context.repo, ref: parentSha });
  const [parentTree, commitTree] = await Promise.all([
    gh.rest.git.getTree({ owner: context.owner, repo: context.repo, tree_sha: parent.commit.tree.sha, recursive: "1" }),
    gh.rest.git.getTree({ owner: context.owner, repo: context.repo, tree_sha: commitTreeSha, recursive: "1" }),
  ]);
  if (parentTree.data.truncated || commitTree.data.truncated) return false;
  const entries = (tree: typeof parentTree.data) => new Map(tree.tree
    .filter((entry) => entry.type !== "tree" && entry.path !== undefined)
    .map((entry) => [entry.path!, `${entry.type}:${entry.mode}:${entry.sha}`]));
  const before = entries(parentTree.data);
  const after = entries(commitTree.data);
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  const actual = new Set([...allPaths].filter((path) => before.get(path) !== after.get(path)));
  const expected = new Set(changes.map((change) => change.path));
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) return false;
  for (const change of changes) {
    const entry = after.get(change.path);
    if (change.kind === "delete") {
      if (entry !== undefined) return false;
    } else if (!entry || !/^blob:100(?:644|755):/u.test(entry)) {
      return false;
    }
  }
  return true;
}

async function contentMatches(gh: GitHub, context: Context, ref: string, changes: readonly SecurefixChange[]): Promise<boolean> {
  const results = await Promise.all(changes.map(async (change) => {
    if (change.kind === "delete") {
      return (await readRepositoryFile(gh, context, change.path, ref)) === null;
    }
    const current = await readRepositoryFile(gh, context, change.path, ref);
    return current?.equals(change.content) ?? false;
  }));
  return results.every(Boolean);
}

async function isServerMadeCommit(gh: GitHub, context: Context, sha: string, serverBotId: number): Promise<boolean> {
  const { data: commit } = await gh.rest.repos.getCommit({ owner: context.owner, repo: context.repo, ref: sha });
  if (commit.committer?.login !== "web-flow" || commit.author?.id !== serverBotId || commit.commit.verification?.verified !== true) return false;
  const data = await gh.graphql<{ repository: { commit: { signature: { isValid: boolean; wasSignedByGitHub: boolean } | null } | null } }>(
    "query($owner: String!, $repo: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $repo) { commit: object(oid: $sha) { ... on Commit { signature { isValid wasSignedByGitHub } } } } }",
    { owner: context.owner, repo: context.repo, sha },
  );
  const facts = data.repository.commit;
  return facts?.signature?.isValid === true && facts.signature.wasSignedByGitHub === true;
}

async function validateRouteBranch(gh: GitHub, config: Config, context: Context): Promise<string | null> {
  const route = context.route;
  if (!route) return null;
  let targetSha: string;
  try {
    targetSha = await branchHead(gh, context, route.to);
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
  if (targetSha === context.run.head_sha) return targetSha;
  const comparison = await gh.rest.repos.compareCommitsWithBasehead({ owner: context.owner, repo: context.repo, basehead: `${context.run.head_sha}...${targetSha}`, per_page: 100 });
  if (comparison.data.ahead_by > comparison.data.commits.length) throw new Rejection("securefix route target branch commit list is incomplete");
  for (const commit of comparison.data.commits) {
    if (!await isServerMadeCommit(gh, context, commit.sha, config.apps.server_bot_id)) throw new Rejection("securefix route target branch contains a commit not made by the server");
    const { data } = await gh.rest.repos.getCommit({ owner: context.owner, repo: context.repo, ref: commit.sha });
    if (data.files === undefined || data.files.length >= 300) throw new Rejection("securefix route target branch change list is incomplete");
    if (data.parents.length !== 1) throw new Rejection("securefix route target branch contains a merge or root commit");
    for (const file of data.files) {
      const beforeSha = data.parents[0]?.sha;
      if (!beforeSha) throw new Rejection("securefix route target branch contains a root commit");
      const before = await readRepositoryFile(gh, context, file.filename, beforeSha);
      const after = file.status === "removed" ? null : await readRepositoryFile(gh, context, file.filename, commit.sha);
      validateSecurefixRouteCommitFile(route, file, before, after);
    }
  }
  return targetSha;
}

async function resetRouteBranch(context: Context, route: SecurefixRoute, expectedHead: string, observedTargetSha: string | null, token: string): Promise<void> {
  if (observedTargetSha === expectedHead) return;
  try {
    await resetBranchWithLease({
      remote: `https://github.com/${context.repository}.git`,
      sourceBranch: context.run.head_branch,
      targetBranch: route.to,
      sourceSha: expectedHead,
      expectedTargetSha: observedTargetSha,
      token,
    });
  } catch (error) {
    if (error instanceof GitRefChanged) throw new Rejection("securefix route branch or source moved before the conditional reset");
    throw error;
  }
}

async function createCommit(gh: GitHub, context: Context, branch: string, expectedHead: string, message: string, changes: readonly SecurefixChange[]): Promise<string> {
  const additions = changes.filter((change): change is Extract<SecurefixChange, { kind: "write" }> => change.kind === "write")
    .map((change) => ({ path: change.path, contents: change.content.toString("base64") }));
  const deletions = changes.filter((change): change is Extract<SecurefixChange, { kind: "delete" }> => change.kind === "delete").map((change) => change.path);
  const [headline, ...body] = message.split("\n");
  const result = await gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    { input: {
      branch: { repositoryNameWithOwner: context.repository, branchName: branch },
      expectedHeadOid: expectedHead,
      message: { headline: headline ?? message, body: body.join("\n") },
      fileChanges: { additions, deletions },
    } },
  );
  return result.createCommitOnBranch.commit.oid;
}

function isCompareAndSwapFailure(error: unknown): boolean {
  return error instanceof Error && /expected.*(?:head|sha)|branch.*(?:changed|moved|updated)/iu.test(error.message);
}

async function ensureRoutePullRequest(gh: GitHub, context: Context, route: SecurefixRoute, manifest: SecurefixManifest, head: string): Promise<number> {
  const base = route.from === "default" ? context.repoInfo.default_branch : route.from;
  const pulls = await gh.paginate(gh.rest.pulls.list, { owner: context.owner, repo: context.repo, state: "open", head: `${context.owner}:${head}`, base, per_page: 100 });
  if (pulls.length > 1) throw new Rejection("securefix route branch has multiple open pull requests");
  const title = `${route.name}: ${manifest.message.split("\n", 1)[0] ?? manifest.message}`.slice(0, 250);
  const body = `Automated update for securefix route ${route.name}.\n\n${manifest.message}\n\n<!-- csm-ci:securefix:${manifest.run_id} -->`;
  const current = pulls[0];
  if (current) {
    const { data } = await gh.rest.pulls.update({ owner: context.owner, repo: context.repo, pull_number: current.number, title, body });
    return data.number;
  }
  const { data } = await gh.rest.pulls.create({ owner: context.owner, repo: context.repo, title, body, head, base });
  return data.number;
}

export function securefixPreparationOutput(result: SecurefixInspection): { result: string; "requires-workflows-write": string } {
  return {
    result: result.status,
    "requires-workflows-write": result.status === "ready" && result.requiresWorkflowsWrite ? "true" : "false",
  };
}

