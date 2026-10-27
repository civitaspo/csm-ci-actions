import { Rejection } from "./request.ts";
import { MAX_SECUREFIX_FILES, MAX_SECUREFIX_FILE_SIZE, MAX_SECUREFIX_TOTAL_SIZE } from "./securefix.ts";
import { github, splitRepository, type GitHub } from "./github.ts";
import { GitRefChanged, resetBranchWithLease } from "./git-ref.ts";
import { loadServerOwnedHistory } from "./server-owned-history.ts";

const BRANCH = "csm-ci/repo-settings";
const PULL_TITLE = "Sync managed files";
const PULL_BODY = "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->";
const DEFAULT_BRANCH_MESSAGES = {
  incomplete: "managed files branch commit list is incomplete",
  untrusted: "managed files branch contains a commit not made by the server",
  changesIncomplete: "managed files branch change list is incomplete",
  nonLinear: "managed files branch contains a merge or root commit",
};

export type ManagedFilesInput = {
  repository: string;
  defaultBranch: string;
  serverBotId: number;
  files: Readonly<Record<string, string>>;
};
export type ManagedFile = { path: string; content: string };
export type ManagedFilesInspection = {
  status: "already-applied" | "ready";
  requiresWorkflowsWrite: boolean;
  requiresPullRequestUpdate: boolean;
  branchNeedsWrite: boolean;
  repository: string;
  defaultBranch: string;
  defaultSha: string;
  targetSha: string | null;
  files: ManagedFile[];
  changedPaths: string[];
  pullRequest: number | null;
};
export type ManagedFilesResult = { status: "applied" | "already-applied"; commit: string; pullRequest?: number };
type ManagedPullRequest = { number: number; title: string; body: string | null; base: { ref: string }; head: { sha: string } };

type GitTreeEntry = { path?: string; type?: string; mode?: string; sha?: string };
type FileValue = { content: string | null };

export function validateManagedFiles(files: Readonly<Record<string, string>>): ManagedFile[] {
  const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
  if (entries.length > MAX_SECUREFIX_FILES) throw new Rejection(`managed files has more than ${MAX_SECUREFIX_FILES} files`);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  let totalSize = 0;
  const paths = new Set<string>();
  for (const { path, content } of entries) {
    validateManagedPath(path);
    if (typeof content !== "string") throw new Rejection(`managed file ${JSON.stringify(path)} content is not text`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_SECUREFIX_FILE_SIZE) throw new Rejection(`managed file ${JSON.stringify(path)} is larger than 8MB`);
    totalSize += size;
    if (totalSize > MAX_SECUREFIX_TOTAL_SIZE) throw new Rejection("managed files are larger than 10MB in total");
    if (paths.has(path)) throw new Rejection(`managed files contain duplicate path ${JSON.stringify(path)}`);
    paths.add(path);
  }
  for (const { path } of entries) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");
      if (paths.has(ancestor)) throw new Rejection(`managed file paths conflict at ${JSON.stringify(ancestor)}`);
    }
  }
  return entries;
}

export function validateManagedPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Rejection(`managed file path ${JSON.stringify(path)} is absolute or contains a control character`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) throw new Rejection(`managed file path ${JSON.stringify(path)} contains ..`);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) throw new Rejection(`managed file path ${JSON.stringify(path)} contains a .git segment`);
  if (segments.some((segment) => segment === "" || segment === ".")) throw new Rejection(`managed file path ${JSON.stringify(path)} is not normalized`);
  if (/[!*?{}()[\]]/u.test(path)) throw new Rejection(`managed file path ${JSON.stringify(path)} contains a glob character`);
}

export async function inspectManagedFiles(gh: GitHub, input: ManagedFilesInput): Promise<ManagedFilesInspection> {
  const files = validateManagedFiles(input.files);
  if (input.defaultBranch === BRANCH) throw new Rejection(`managed files branch ${BRANCH} cannot be the repository default branch`);
  const { owner, repo } = splitRepository(input.repository);
  const { data: defaultRef } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${input.defaultBranch}` });
  const defaultSha = defaultRef.object.sha;
  if (files.length === 0) return {
    status: "already-applied",
    requiresWorkflowsWrite: false,
    requiresPullRequestUpdate: false,
    branchNeedsWrite: false,
    repository: input.repository.toLowerCase(),
    defaultBranch: input.defaultBranch,
    defaultSha,
    targetSha: null,
    files,
    changedPaths: [],
    pullRequest: null,
  };
  const sourceValues = await readFiles(gh, owner, repo, defaultSha, files);
  const changedPaths = files.filter(({ path, content }) => sourceValues.get(path)?.content !== content).map(({ path }) => path);
  if (changedPaths.length === 0) return {
    status: "already-applied",
    requiresWorkflowsWrite: false,
    requiresPullRequestUpdate: false,
    branchNeedsWrite: false,
    repository: input.repository.toLowerCase(),
    defaultBranch: input.defaultBranch,
    defaultSha,
    targetSha: null,
    files,
    changedPaths,
    pullRequest: null,
  };
  const targetSha = await branchHead(gh, owner, repo);
  let targetHistoryLength: number | undefined;
  if (targetSha) {
    const history = await loadServerOwnedHistory(gh, {
      owner,
      repo,
      baseSha: defaultSha,
      headSha: targetSha,
      serverBotId: input.serverBotId,
      messages: DEFAULT_BRANCH_MESSAGES,
    });
    targetHistoryLength = history.length;
    const allowed = new Set(files.map(({ path }) => path));
    for (const commit of history) {
      for (const change of commit.files) {
        if (!allowed.has(change.filename)) throw new Rejection(`managed files branch changed unmanaged path ${JSON.stringify(change.filename)}`);
        if (change.previous_filename && !allowed.has(change.previous_filename)) {
          throw new Rejection(`managed files branch changed unmanaged path ${JSON.stringify(change.previous_filename)}`);
        }
      }
    }
  }
  const targetValues = targetSha ? await readFiles(gh, owner, repo, targetSha, files) : new Map<string, FileValue>();
  const targetMatches = files.every(({ path, content }) => targetValues.get(path)?.content === content);
  const targetIsAncestorOfDefault = targetSha !== null && targetSha !== defaultSha && targetHistoryLength === 0;
  const branchNeedsWrite = !targetMatches || targetIsAncestorOfDefault;
  const pullRequest = await findPullRequest(gh, input.repository, input.defaultBranch, targetSha);
  const requiresPullRequestUpdate = !pullRequest || pullRequest.title !== PULL_TITLE || pullRequest.body !== PULL_BODY;
  const status = branchNeedsWrite || requiresPullRequestUpdate ? "ready" : "already-applied";
  return {
    status,
    // The reset moves the branch across any default-branch workflow changes, which GitHub may refuse without workflows write.
    requiresWorkflowsWrite: branchNeedsWrite && (changedPaths.some((path) => path.startsWith(".github/workflows/")) || (targetSha !== null && targetSha !== defaultSha)),
    requiresPullRequestUpdate,
    branchNeedsWrite,
    repository: input.repository.toLowerCase(),
    defaultBranch: input.defaultBranch,
    defaultSha,
    targetSha,
    files,
    changedPaths,
    pullRequest: pullRequest?.number ?? null,
  };
}

async function readFiles(gh: GitHub, owner: string, repo: string, ref: string, files: readonly ManagedFile[]): Promise<Map<string, FileValue>> {
  const results = await Promise.all(files.map(async ({ path }) => [path, await readFileAtRef(gh, owner, repo, path, ref)] as const));
  return new Map(results);
}

async function readFileAtRef(gh: GitHub, owner: string, repo: string, path: string, ref: string): Promise<FileValue> {
  const entry = await findTreeEntry(gh, owner, repo, path, ref);
  if (!entry) return { content: null };
  const { data } = await gh.rest.git.getBlob({ owner, repo, file_sha: entry.sha! });
  if (data.encoding !== "base64") throw new Rejection(`managed file ${JSON.stringify(path)} has an unsupported Git blob encoding`);
  return { content: Buffer.from(data.content.replaceAll("\n", ""), "base64").toString("utf8") };
}

export async function findTreeEntry(gh: GitHub, owner: string, repo: string, path: string, ref: string): Promise<GitTreeEntry | null> {
  const { data: commit } = await gh.rest.repos.getCommit({ owner, repo, ref });
  let treeSha = commit.commit.tree.sha;
  if (!treeSha) throw new Rejection("managed files commit has no Git tree SHA");
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const { data: tree } = await gh.rest.git.getTree({ owner, repo, tree_sha: treeSha });
    if (tree.truncated) throw new Rejection("managed files could not safely inspect a Git tree");
    const entry = tree.tree.find((candidate) => candidate.path === segment);
    if (!entry) return null;
    const fullPath = segments.slice(0, index + 1).join("/");
    if (index < segments.length - 1) {
      if (entry.type !== "tree" || entry.mode !== "040000" || !entry.sha) throw new Rejection(`managed path ${JSON.stringify(path)} traverses a non-directory Git entry at ${JSON.stringify(fullPath)}`);
      treeSha = entry.sha;
    } else if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || !entry.sha) {
      throw new Rejection(`managed file ${JSON.stringify(path)} is not a regular file in the Git tree`);
    }
    if (index === segments.length - 1) return entry;
  }
  return null;
}

async function branchHead(gh: GitHub, owner: string, repo: string): Promise<string | null> {
  try {
    const { data } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` });
    return data.object.sha;
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    throw error;
  }
}

async function findPullRequest(gh: GitHub, repository: string, defaultBranch: string, targetSha: string | null): Promise<ManagedPullRequest | null> {
  const { owner, repo } = splitRepository(repository);
  const pulls = await gh.paginate(gh.rest.pulls.list, { owner, repo, state: "open", head: `${owner}:${BRANCH}`, per_page: 100 });
  if (pulls.length > 1) throw new Rejection("managed files branch has multiple open pull requests");
  const current: ManagedPullRequest | undefined = pulls[0];
  if (!current) return null;
  if (current.base.ref !== defaultBranch) throw new Rejection("managed files branch has an open pull request for a different base branch");
  if (targetSha && current.head.sha !== targetSha) throw new Rejection("managed files pull request head does not match the branch head");
  return current;
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

export async function applyManagedFiles(gh: GitHub, input: ManagedFilesInput & { writeToken: string; writeClient?: GitHub }): Promise<ManagedFilesResult> {
  const inspection = await inspectManagedFiles(gh, input);
  if (inspection.status === "already-applied") {
    if (inspection.changedPaths.length === 0) return { status: "already-applied", commit: inspection.targetSha ?? inspection.defaultSha };
    const commit = inspection.targetSha ?? inspection.defaultSha;
    return inspection.pullRequest === null
      ? { status: "already-applied", commit }
      : { status: "already-applied", commit, pullRequest: inspection.pullRequest };
  }
  const writeGh = input.writeClient ?? github(input.writeToken);
  if (!inspection.branchNeedsWrite) {
    const pullRequest = await ensurePullRequest(writeGh, inspection, inspection.targetSha ?? inspection.defaultSha);
    return pullRequest === undefined
      ? { status: "applied", commit: inspection.targetSha ?? inspection.defaultSha }
      : { status: "applied", commit: inspection.targetSha ?? inspection.defaultSha, pullRequest };
  }
  if (inspection.targetSha && inspection.targetSha !== inspection.defaultSha) {
    try {
      await resetBranchWithLease({
        remote: `https://github.com/${inspection.repository}.git`,
        sourceBranch: inspection.defaultBranch,
        targetBranch: BRANCH,
        sourceSha: inspection.defaultSha,
        expectedTargetSha: inspection.targetSha,
        token: input.writeToken,
      });
    } catch (error) {
      if (error instanceof GitRefChanged) throw new Rejection("managed files branch or default branch moved before the conditional reset");
      throw error;
    }
  } else if (!inspection.targetSha) {
    const { owner, repo } = splitRepository(inspection.repository);
    const { data: currentDefault } = await writeGh.rest.git.getRef({ owner, repo, ref: `heads/${inspection.defaultBranch}` });
    if (currentDefault.object.sha !== inspection.defaultSha) throw new Rejection("managed files default branch moved before branch creation");
    await writeGh.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: inspection.defaultSha });
  }
  const commit = await createCommit(writeGh, inspection);
  const pullRequest = await ensurePullRequest(writeGh, inspection, commit);
  return pullRequest === undefined ? { status: "applied", commit } : { status: "applied", commit, pullRequest };
}

async function createCommit(gh: GitHub, inspection: ManagedFilesInspection): Promise<string> {
  const additions = inspection.files.filter(({ path }) => inspection.changedPaths.includes(path)).map(({ path, content }) => ({ path, contents: Buffer.from(content, "utf8").toString("base64") }));
  const result = await gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    { input: {
      branch: { repositoryNameWithOwner: inspection.repository, branchName: BRANCH },
      expectedHeadOid: inspection.defaultSha,
      message: { headline: "Sync managed files" },
      fileChanges: { additions, deletions: [] },
    } },
  );
  return result.createCommitOnBranch.commit.oid;
}

async function ensurePullRequest(gh: GitHub, inspection: ManagedFilesInspection, headSha: string): Promise<number | undefined> {
  const { owner, repo } = splitRepository(inspection.repository);
  const { data: defaultRef } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${inspection.defaultBranch}` });
  if (defaultRef.object.sha !== inspection.defaultSha) throw new Rejection("managed files default branch moved before pull request update");
  const { data: currentHead } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` });
  if (currentHead.object.sha !== headSha) throw new Rejection("managed files branch moved before pull request update");
  const current = await findPullRequest(gh, inspection.repository, inspection.defaultBranch, headSha);
  if (current) {
    if (current.title === PULL_TITLE && current.body === PULL_BODY) return current.number;
    const { data } = await gh.rest.pulls.update({ owner, repo, pull_number: current.number, title: PULL_TITLE, body: PULL_BODY });
    return data.number;
  }
  if (headSha === inspection.defaultSha) return undefined;
  const { data } = await gh.rest.pulls.create({ owner, repo, title: PULL_TITLE, body: PULL_BODY, head: BRANCH, base: inspection.defaultBranch });
  return data.number;
}
