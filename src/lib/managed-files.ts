import { hasGeneratedHeader, isWorkflowFileName, type GeneratedWorkflows } from "./generated-workflows.ts";
import { Rejection } from "./request.ts";
import { MAX_SECUREFIX_FILES, MAX_SECUREFIX_FILE_SIZE, MAX_SECUREFIX_TOTAL_SIZE } from "./securefix.ts";
import { github, splitRepository, type GitHub } from "./github.ts";
import { GitRefChanged } from "./git-ref.ts";
import { rebuildBranchWithLease } from "./branch-rebuild.ts";
import { loadServerOwnedHistory } from "./server-owned-history.ts";

const BRANCH = "csm-ci/repo-settings";
export const MANAGED_FILES_TITLE = "chore(repo-settings): sync managed files";
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
  generated?: GeneratedWorkflows;
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
  deletions?: string[];
  pullBody?: string;
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
  const files = validateManagedFiles({ ...input.files, ...input.generated?.files });
  if (input.defaultBranch === BRANCH) throw new Rejection(`managed files branch ${BRANCH} cannot be the repository default branch`);
  const { owner, repo } = splitRepository(input.repository);
  const { data: defaultRef } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${input.defaultBranch}` });
  const defaultSha = defaultRef.object.sha;
  const generated = input.generated;
  const deletions = generated ? await generatedDeletions(gh, { owner, repo, defaultSha, generated, additional: input.files }) : [];
  validateManagedFiles({ ...input.files, ...generated?.files, ...Object.fromEntries(deletions.map((path) => [path, ""])) });
  const pullBody = generated ? `${PULL_BODY}\n\nStandard client workflows: ${generated.release.version} (${generated.release.sha}).` : PULL_BODY;
  const metadata = generated ? { deletions, pullBody } : {};
  if (files.length === 0 && deletions.length === 0) return {
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
  const changedPaths = [...files.filter(({ path, content }) => sourceValues.get(path)?.content !== content).map(({ path }) => path), ...deletions];
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
    const allowed = new Set([...files.map(({ path }) => path), ...deletions]);
    for (const commit of history) {
      for (const change of commit.files) {
        if (!allowed.has(change.filename)) throw new Rejection(`managed files branch changed unmanaged path ${JSON.stringify(change.filename)}`);
        if (change.previous_filename && !allowed.has(change.previous_filename)) {
          throw new Rejection(`managed files branch changed unmanaged path ${JSON.stringify(change.previous_filename)}`);
        }
      }
    }
  }
  const inspectedFiles = [...files, ...deletions.map((path) => ({ path, content: "" }))];
  const targetValues = targetSha ? await readFiles(gh, owner, repo, targetSha, inspectedFiles) : new Map<string, FileValue>();
  const targetMatches = targetSha !== null && files.every(({ path, content }) => targetValues.get(path)?.content === content) && deletions.every((path) => targetValues.get(path)?.content === null);
  const targetIsAncestorOfDefault = targetSha !== null && targetSha !== defaultSha && targetHistoryLength === 0;
  const branchNeedsWrite = !targetMatches || targetIsAncestorOfDefault;
  const pullRequest = await findPullRequest(gh, input.repository, input.defaultBranch, targetSha);
  const requiresPullRequestUpdate = !pullRequest || pullRequest.title !== MANAGED_FILES_TITLE || pullRequest.body !== pullBody;
  const status = branchNeedsWrite || requiresPullRequestUpdate ? "ready" : "already-applied";
  return {
    status,
    // The final ref move carries the branch across any default-branch workflow changes, which GitHub may refuse without workflows write.
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
    ...metadata,
  };
}

// Every regular .yml/.yaml file directly under .github/workflows/ whose first line is the generated header
// is deleted unless a selected caller rewrites it. Files without the header are never touched.
async function generatedDeletions(gh: GitHub, input: { owner: string; repo: string; defaultSha: string; generated: GeneratedWorkflows; additional: Readonly<Record<string, string>> }): Promise<string[]> {
  const { owner, repo } = input;
  const deletions: string[] = [];
  for (const entry of await listWorkflowFiles(gh, owner, repo, input.defaultSha)) {
    const path = `.github/workflows/${entry.path}`;
    if (Object.hasOwn(input.generated.files, path)) continue;
    // latin1 keeps the ASCII header comparison byte-exact without rejecting non-UTF-8 operator files.
    if (hasGeneratedHeader((await readBlob(gh, owner, repo, path, entry.sha)).toString("latin1"))) deletions.push(path);
  }
  for (const path of [...Object.keys(input.generated.files), ...deletions]) {
    if (Object.hasOwn(input.additional, path)) throw new Rejection(`managed files contain duplicate producer destination ${JSON.stringify(path)}`);
  }
  return deletions.sort();
}

async function listWorkflowFiles(gh: GitHub, owner: string, repo: string, ref: string): Promise<{ path: string; sha: string }[]> {
  const { data: commit } = await gh.rest.repos.getCommit({ owner, repo, ref });
  let treeSha = commit.commit.tree.sha;
  if (!treeSha) throw new Rejection("managed files commit has no Git tree SHA");
  for (const segment of [".github", "workflows"]) {
    const { data: tree } = await gh.rest.git.getTree({ owner, repo, tree_sha: treeSha });
    if (tree.truncated) throw new Rejection("managed files could not safely inspect a Git tree");
    const entry = tree.tree.find((candidate) => candidate.path === segment);
    if (!entry || entry.type !== "tree" || entry.mode !== "040000" || !entry.sha) return [];
    treeSha = entry.sha;
  }
  const { data: tree } = await gh.rest.git.getTree({ owner, repo, tree_sha: treeSha });
  if (tree.truncated) throw new Rejection("managed files could not safely inspect a Git tree");
  return tree.tree.flatMap((entry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755") && entry.sha && entry.path && isWorkflowFileName(entry.path) ? [{ path: entry.path, sha: entry.sha }] : []);
}

async function readFiles(gh: GitHub, owner: string, repo: string, ref: string, files: readonly ManagedFile[]): Promise<Map<string, FileValue>> {
  const results = await Promise.all(files.map(async ({ path }) => [path, await readFileAtRef(gh, owner, repo, path, ref)] as const));
  return new Map(results);
}

export async function readFileAtRef(gh: GitHub, owner: string, repo: string, path: string, ref: string): Promise<FileValue> {
  const entry = await findTreeEntry(gh, owner, repo, path, ref);
  if (!entry) return { content: null };
  const bytes = await readBlob(gh, owner, repo, path, entry.sha!);
  try { return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { throw new Rejection(`managed file ${JSON.stringify(path)} is not UTF-8`); }
}

async function readBlob(gh: GitHub, owner: string, repo: string, path: string, sha: string): Promise<Buffer> {
  const { data } = await gh.rest.git.getBlob({ owner, repo, file_sha: sha });
  if (data.encoding !== "base64") throw new Rejection(`managed file ${JSON.stringify(path)} has an unsupported Git blob encoding`);
  const encoded = data.content.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Rejection(`managed file ${JSON.stringify(path)} has malformed base64`);
  return bytes;
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
  if (input.generated) {
    const current = await inspectManagedFiles(gh, input);
    if (current.defaultSha !== inspection.defaultSha || current.targetSha !== inspection.targetSha || current.pullRequest !== inspection.pullRequest || JSON.stringify(current.deletions) !== JSON.stringify(inspection.deletions)) throw new Rejection("generated workflows state changed before managed file write");
  }
  if (!inspection.branchNeedsWrite) {
    const pullRequest = await ensurePullRequest(writeGh, inspection, inspection.targetSha ?? inspection.defaultSha);
    return pullRequest === undefined
      ? { status: "applied", commit: inspection.targetSha ?? inspection.defaultSha }
      : { status: "applied", commit: inspection.targetSha ?? inspection.defaultSha, pullRequest };
  }
  const rebuild = inspection.targetSha !== null && inspection.targetSha !== inspection.defaultSha;
  if (!inspection.targetSha) {
    const { owner, repo } = splitRepository(inspection.repository);
    const { data: currentDefault } = await writeGh.rest.git.getRef({ owner, repo, ref: `heads/${inspection.defaultBranch}` });
    if (currentDefault.object.sha !== inspection.defaultSha) throw new Rejection("managed files default branch moved before branch creation");
    await writeGh.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: inspection.defaultSha });
  }
  if (input.generated) {
    const { owner, repo } = splitRepository(input.repository);
    const { data: currentDefault } = await gh.rest.git.getRef({ owner, repo, ref: `heads/${input.defaultBranch}` });
    if (currentDefault.object.sha !== inspection.defaultSha) throw new Rejection("generated workflows default branch moved before commit creation");
    const deletions = await generatedDeletions(gh, { owner, repo, defaultSha: inspection.defaultSha, generated: input.generated, additional: input.files });
    if (JSON.stringify(deletions) !== JSON.stringify(inspection.deletions)) throw new Rejection("generated workflows deletions changed before commit creation");
  }
  let commit: string;
  if (rebuild) {
    const { owner, repo } = splitRepository(inspection.repository);
    try {
      commit = await rebuildBranchWithLease({
        remote: `https://github.com/${inspection.repository}.git`,
        sourceBranch: inspection.defaultBranch,
        sourceSha: inspection.defaultSha,
        targetBranch: BRANCH,
        expectedTargetSha: inspection.targetSha,
        token: input.writeToken,
        temporaryName: "managed",
        commit: (temporaryBranch) => createCommit(writeGh, inspection, temporaryBranch),
        deleteBranch: async (temporaryBranch) => { await writeGh.rest.git.deleteRef({ owner, repo, ref: `heads/${temporaryBranch}` }); },
      });
    } catch (error) {
      if (error instanceof GitRefChanged) throw new Rejection("managed files branch or default branch moved before the conditional reset");
      throw error;
    }
  } else {
    commit = await createCommit(writeGh, inspection, BRANCH);
  }
  const pullRequest = await ensurePullRequest(writeGh, inspection, commit);
  return pullRequest === undefined ? { status: "applied", commit } : { status: "applied", commit, pullRequest };
}

async function createCommit(gh: GitHub, inspection: ManagedFilesInspection, branch: string): Promise<string> {
  const additions = inspection.files.filter(({ path }) => inspection.changedPaths.includes(path)).map(({ path, content }) => ({ path, contents: Buffer.from(content, "utf8").toString("base64") }));
  const result = await gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    { input: {
      branch: { repositoryNameWithOwner: inspection.repository, branchName: branch },
      expectedHeadOid: inspection.defaultSha,
      message: { headline: MANAGED_FILES_TITLE },
      fileChanges: { additions, deletions: (inspection.deletions ?? []).map((path) => ({ path })) },
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
  const pullBody = inspection.pullBody ?? PULL_BODY;
  if (current) {
    if (current.title === MANAGED_FILES_TITLE && current.body === pullBody) return current.number;
    const { data } = await gh.rest.pulls.update({ owner, repo, pull_number: current.number, title: MANAGED_FILES_TITLE, body: pullBody });
    return data.number;
  }
  if (headSha === inspection.defaultSha) return undefined;
  const { data } = await gh.rest.pulls.create({ owner, repo, title: MANAGED_FILES_TITLE, body: pullBody, head: BRANCH, base: inspection.defaultBranch });
  return data.number;
}
