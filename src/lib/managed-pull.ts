import { createHash } from "node:crypto";
import { Rejection } from "./request.ts";
import { findTreeEntry, generatedManagedDeletionsAtRef, readFileAtRef, validateManagedFiles, type ManagedFilesInspection } from "./managed-files.ts";
import { loadConfig, splitRepository, type GitHub } from "./github.ts";
import { generateWorkflows, selectedCallers } from "./generated-workflows.ts";
import { loadAdditionalManagedFiles } from "./additional-managed-files.ts";
import { verifyWorkflowReleaseRevision } from "./workflow-release.ts";
import { repositoryEntry } from "./config.ts";
import { loadServerOwnedHistory } from "./server-owned-history.ts";
import type { ManagedReservationPayload } from "./automerge.ts";

const MANAGED_REF = "csm-ci/repo-settings";
const SHA = /^[0-9a-f]{40}$/u;
const GITHUB_ACTIONS_BOT_ID = 41898282;

export type ManagedDriftWorkflowRun = {
  displayTitle: string;
  headBranch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  actorId: number | null;
  actorLogin: string | null;
  createdAt: string;
};

/** Returns whether an exact prior drift dispatch makes another dispatch unnecessary. */
export function managedDriftDispatchState(input: {
  runs: readonly ManagedDriftWorkflowRun[];
  repository: string;
  mergeCommit: string;
  defaultBranch: string;
  now?: Date;
  notBefore?: Date;
}): "dispatch" | "already-running" | "already-succeeded" | "previous-failed" {
  const repository = normalizeRepository(input.repository);
  if (!SHA.test(input.mergeCommit)) reject("managed drift merge commit SHA is invalid");
  const key = createHash("sha256").update(`${repository}#${input.mergeCommit}`).digest("hex");
  const expectedTitle = `csm-ci-repo-settings ${repository} ${key}`;
  const now = (input.now ?? new Date()).getTime();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  let succeeded = false;
  let failed = false;
  for (const run of input.runs) {
    if (run.displayTitle !== expectedTitle) continue;
    const createdAt = Date.parse(run.createdAt);
    if (!Number.isFinite(createdAt)) reject("matching managed-drift workflow run has an invalid creation time");
    if (createdAt > now + 5 * 60 * 1000) reject("matching managed-drift workflow run has a future creation time");
    if (createdAt < cutoff) continue;
    if (input.notBefore && createdAt < input.notBefore.getTime()) continue;
    if (run.headBranch !== input.defaultBranch || run.event !== "workflow_dispatch" || run.actorId !== GITHUB_ACTIONS_BOT_ID || run.actorLogin !== "github-actions[bot]") {
      reject("a matching managed-drift run has ambiguous workflow identity");
    }
    if (["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status)) return "already-running";
    if (run.status !== "completed") reject("matching managed-drift workflow run has an unknown status");
    if (run.conclusion === "success") succeeded = true;
    else failed = true;
  }
  return succeeded ? "already-succeeded" : failed ? "previous-failed" : "dispatch";
}

export type ManagedPullExpectation = {
  repository: string;
  repositoryId: number;
  pullNumber: number;
  pullNodeId: string;
  defaultBranch: string;
  defaultSha: string;
  headSha: string;
  serverBotId: number;
  configSha: string;
  releaseSha: string;
  releaseVersion: string;
  inspection: ManagedFilesInspection;
};

export type ManagedPullAttestation = {
  repositoryId: number;
  repository: string;
  pullNumber: number;
  pullNodeId: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  configSha: string;
  releaseSha: string;
  releaseVersion: string;
  manifestDigest: string;
};

/** Verifies that the actual merge preserved every path in the accepted managed PR diff. */
export async function verifyManagedMergeTree(input: {
  source: GitHub;
  target: GitHub;
  serverRepository: string;
  serverBotId: number;
  configPath: string;
  reservation: ManagedReservationPayload;
  mergeCommit: string;
}): Promise<{ matches: boolean; reason?: string }> {
  const payload = input.reservation;
  const repository = normalizeRepository(payload.repository);
  if (!SHA.test(input.mergeCommit)) return { matches: false, reason: "merge commit SHA is invalid" };
  try {
    const { owner, repo } = splitRepository(repository);
    const [repositoryInfo, pullResult] = await Promise.all([
      input.target.rest.repos.get({ owner, repo }),
      input.target.rest.pulls.get({ owner, repo, pull_number: payload.pull_number }),
    ]);
    const pull = pullResult.data;
    if (Number(repositoryInfo.data.id) !== payload.repository_id || repositoryInfo.data.full_name?.toLowerCase() !== repository) {
      return { matches: false, reason: "merged managed pull repository identity changed" };
    }
    if (pull.state !== "closed" || pull.merged !== true || pull.merge_commit_sha !== input.mergeCommit || pull.node_id !== payload.pull_node_id ||
      pull.head.sha !== payload.accepted_head || pull.base.ref !== payload.base_ref || pull.head.ref !== payload.managed_ref ||
      Number(pull.base.repo?.id) !== payload.repository_id || Number(pull.head.repo?.id) !== payload.repository_id) {
      return { matches: false, reason: "merged pull does not match the accepted managed reservation" };
    }
    const history = await loadServerOwnedHistory(input.target, {
      owner, repo, baseSha: payload.accepted_base, headSha: payload.accepted_head, serverBotId: input.serverBotId,
      messages: { incomplete: "accepted managed pull history is incomplete", untrusted: "accepted managed pull contains a commit not made by the server", changesIncomplete: "accepted managed pull change list is incomplete", nonLinear: "accepted managed pull contains a merge or root commit" },
    });
    const serverRepository = normalizeRepository(input.serverRepository);
    const config = await loadConfig(input.source, serverRepository, payload.configuration_sha, input.configPath);
    if (config.server_repository !== serverRepository) return { matches: false, reason: "accepted managed configuration identifies a different server repository" };
    if (config.repo_settings?.auto_merge_managed_files !== true) return { matches: false, reason: "accepted managed configuration no longer enables managed completion" };
    const configured = repositoryEntry(config, repository);
    if (!configured || !configured.ops.includes("approve") || !configured.ops.includes("policy-check") || !configured.ops.includes("merge")) {
      return { matches: false, reason: "accepted managed configuration no longer authorizes managed completion" };
    }
    const callers = selectedCallers(config, repository);
    // Contract validation was part of acceptance; post-merge only needs to prove this pinned stable version still resolves to the same immutable commit.
    const release = await verifyWorkflowReleaseRevision(input.source, { version: payload.release_version, sha: payload.release_sha }, []);
    const additional = await loadAdditionalManagedFiles(input.source, { repository: serverRepository, sha: payload.configuration_sha, settings: config.repo_settings });
    const generated = { release, files: generateWorkflows(config, repository, payload.base_ref, release) };
    const deletions = await generatedManagedDeletionsAtRef(input.target, { repository, baseSha: payload.accepted_base, generated, additional });
    if (Object.keys(additional).some((path) => Object.hasOwn(generated.files, path))) return { matches: false, reason: "accepted managed manifest has duplicate producer paths" };
    const desired: ManifestChange[] = [
      ...validateManagedFiles({ ...additional, ...generated.files }),
      ...deletions.map((path) => ({ path, content: null })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const desiredPaths = new Set(desired.map(({ path }) => path));
    if (desiredPaths.size !== desired.length || history.some((commit) => commit.files.some((file) => file.status === "renamed" || file.previous_filename || !desiredPaths.has(file.filename)))) {
      return { matches: false, reason: "accepted managed pull changed paths outside the regenerated managed manifest" };
    }
    if (managedManifestDigest(desired) !== payload.manifest_digest) return { matches: false, reason: "accepted manifest digest does not match its pinned configuration and release" };
    return compareManagedManifestTrees(input.target, { owner, repo, expectedRef: payload.accepted_head, actualRef: input.mergeCommit, desired });
  } catch (error) {
    if (error instanceof Rejection) return { matches: false, reason: error.message };
    throw error;
  }
}

/** Compares every regenerated managed path, including paths unchanged in the accepted PR diff. */
export async function compareManagedManifestTrees(gh: GitHub, input: {
  owner: string;
  repo: string;
  expectedRef: string;
  actualRef: string;
  desired: readonly ManifestChange[];
}): Promise<{ matches: boolean; reason?: string }> {
  for (const { path, content } of input.desired) {
    const [expectedFile, actualFile, expectedEntry, actualEntry] = await Promise.all([
      readFileAtRef(gh, input.owner, input.repo, path, input.expectedRef),
      readFileAtRef(gh, input.owner, input.repo, path, input.actualRef),
      findTreeEntry(gh, input.owner, input.repo, path, input.expectedRef),
      findTreeEntry(gh, input.owner, input.repo, path, input.actualRef),
    ]);
    const expectedMatchesDesired = content === null ? expectedFile.content === null && expectedEntry === null : expectedFile.content === content && expectedEntry?.mode === "100644";
    if (!expectedMatchesDesired || expectedFile.content !== actualFile.content || expectedEntry?.mode !== actualEntry?.mode) {
      return { matches: false, reason: `merged tree differs from the accepted managed pull at ${JSON.stringify(path)}` };
    }
  }
  return { matches: true };
}

type ManifestChange = { path: string; content: string } | { path: string; content: null };

/** Proves that the pinned PR is precisely the server-generated managed-file proposal. */
export async function attestManagedPull(gh: GitHub, expectation: ManagedPullExpectation): Promise<ManagedPullAttestation> {
  const repository = normalizeRepository(expectation.repository);
  if (!Number.isSafeInteger(expectation.repositoryId) || expectation.repositoryId <= 0) reject("managed pull repository identity is invalid");
  if (!Number.isSafeInteger(expectation.pullNumber) || expectation.pullNumber <= 0 || !expectation.pullNodeId) reject("managed pull identity is invalid");
  for (const [name, sha] of [["base", expectation.defaultSha], ["head", expectation.headSha], ["configuration", expectation.configSha], ["release", expectation.releaseSha]] as const) {
    if (!SHA.test(sha)) reject(`managed pull ${name} SHA is invalid`);
  }
  if (expectation.inspection.repository.toLowerCase() !== repository || expectation.inspection.defaultBranch !== expectation.defaultBranch || expectation.inspection.defaultSha !== expectation.defaultSha || expectation.inspection.targetSha !== expectation.headSha) reject("managed pull does not match the inspected managed-files state");
  const desired = desiredChanges(expectation.inspection);
  const initial = await readPullState(gh, expectation, repository);
  const history = await loadServerOwnedHistory(gh, {
    ...splitRepository(repository), baseSha: expectation.defaultSha, headSha: expectation.headSha, serverBotId: expectation.serverBotId,
    messages: { incomplete: "managed pull commit list is incomplete", untrusted: "managed pull contains a commit not made by the server", changesIncomplete: "managed pull change list is incomplete", nonLinear: "managed pull contains a merge or root commit" },
  });
  if (history.length === 0 || history[0]?.parentSha !== expectation.defaultSha) reject("managed pull history does not start at the current default branch");
  const allowed = new Set(desired.map(({ path }) => path));
  for (const commit of history) {
    for (const change of commit.files) {
      if (!allowed.has(change.filename) || change.previous_filename && !allowed.has(change.previous_filename)) reject(`managed pull history changed an unexpected path ${JSON.stringify(change.previous_filename ?? change.filename)}`);
    }
  }
  const { owner, repo } = splitRepository(repository);
  const changed = await gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: expectation.pullNumber, per_page: 100 });
  const actualPaths = changed.map((file) => file.filename).sort();
  const expectedPaths = desired.map(({ path }) => path).sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index]) || changed.some((file) => file.status === "renamed" || file.previous_filename)) reject("managed pull diff does not exactly match the managed manifest");
  for (const entry of desired) {
    const current = await readFileAtRef(gh, owner, repo, entry.path, expectation.headSha);
    const treeEntry = await findTreeEntry(gh, owner, repo, entry.path, expectation.headSha);
    if (entry.content === null ? current.content !== null || treeEntry !== null : current.content !== entry.content || treeEntry?.mode !== "100644") reject(`managed pull content or mode differs from the managed manifest at ${JSON.stringify(entry.path)}`);
  }
  const final = await readPullState(gh, expectation, repository);
  if (JSON.stringify(initial) !== JSON.stringify(final)) reject("managed pull state changed during validation");
  return {
    repositoryId: expectation.repositoryId, repository, pullNumber: expectation.pullNumber, pullNodeId: expectation.pullNodeId,
    baseRef: expectation.defaultBranch, baseSha: expectation.defaultSha, headSha: expectation.headSha,
    configSha: expectation.configSha, releaseSha: expectation.releaseSha, releaseVersion: expectation.releaseVersion, manifestDigest: managedManifestDigest(allDesiredChanges(expectation.inspection)),
  };
}

function desiredChanges(inspection: ManagedFilesInspection): ManifestChange[] {
  const deletions = inspection.deletions ?? [];
  const changes: ManifestChange[] = [
    ...inspection.files.filter(({ path }) => inspection.changedPaths.includes(path)),
    ...deletions.map((path) => ({ path, content: null })),
  ];
  const paths = changes.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path) => !inspection.changedPaths.includes(path))) reject("managed pull inspection has an invalid change manifest");
  if (inspection.changedPaths.length !== paths.length || inspection.changedPaths.some((path) => !paths.includes(path))) reject("managed pull inspection has an incomplete change manifest");
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function allDesiredChanges(inspection: ManagedFilesInspection): ManifestChange[] {
  return [...inspection.files, ...(inspection.deletions ?? []).map((path) => ({ path, content: null }))];
}

export function managedManifestDigest(changes: readonly ManifestChange[]): string {
  const hash = createHash("sha256");
  for (const { path, content } of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
    const pathBytes = Buffer.from(path, "utf8");
    const contentBytes = content === null ? null : Buffer.from(content, "utf8");
    hash.update(contentBytes === null ? "D" : "F");
    hash.update(String(pathBytes.length)); hash.update(":"); hash.update(pathBytes);
    if (contentBytes) { hash.update(String(contentBytes.length)); hash.update(":"); hash.update(contentBytes); }
  }
  return hash.digest("hex");
}

async function readPullState(gh: GitHub, expected: ManagedPullExpectation, repository: string): Promise<string> {
  const { owner, repo } = splitRepository(repository);
  const [pulls, { data: currentPull }, { data: defaultRef }, { data: headRef }] = await Promise.all([
    gh.paginate(gh.rest.pulls.list, { owner, repo, state: "open", head: `${owner}:${MANAGED_REF}`, per_page: 100 }),
    gh.rest.pulls.get({ owner, repo, pull_number: expected.pullNumber }),
    gh.rest.git.getRef({ owner, repo, ref: `heads/${expected.defaultBranch}` }),
    gh.rest.git.getRef({ owner, repo, ref: `heads/${MANAGED_REF}` }),
  ]);
  const pull = currentPull as typeof currentPull & { node_id?: string; draft?: boolean; head: typeof currentPull.head & { ref?: string; repo?: { id?: number; full_name?: string } | null }; base: typeof currentPull.base & { repo?: { id?: number; full_name?: string; default_branch?: string } | null } };
  if (pulls.length !== 1 || pulls[0]?.number !== expected.pullNumber) reject("managed pull branch does not have exactly one open pull request");
  if (pull.state !== "open" || pull.merged || pull.draft || pull.node_id !== expected.pullNodeId || pull.number !== expected.pullNumber) reject("managed pull identity or state changed");
  if (pull.base.repo?.id !== expected.repositoryId || pull.head.repo?.id !== expected.repositoryId || pull.base.repo?.full_name?.toLowerCase() !== repository || pull.head.repo?.full_name?.toLowerCase() !== repository) reject("managed pull repository identity changed");
  if (pull.base.ref !== expected.defaultBranch || pull.base.repo?.default_branch !== expected.defaultBranch || pull.head.ref !== MANAGED_REF) reject("managed pull base or head ref changed");
  if (pull.head.sha !== expected.headSha || headRef.object.sha !== expected.headSha || defaultRef.object.sha !== expected.defaultSha) reject("managed pull base or head moved");
  return JSON.stringify({ repositoryId: pull.base.repo.id, pullNumber: pull.number, pullNodeId: pull.node_id, baseRef: pull.base.ref, baseSha: defaultRef.object.sha, headRef: pull.head.ref, headSha: pull.head.sha, draft: pull.draft });
}

function normalizeRepository(value: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) reject("managed pull repository is invalid");
  return value.toLowerCase();
}

function reject(message: string): never { throw new Rejection(message); }
