import { repositoryEntry } from "./config.ts";
import { generateWorkflows, selectedCallers } from "./generated-workflows.ts";
import { type GitHub, loadConfig, splitRepository } from "./github.ts";
import { inspectManagedFiles, type ManagedFilesInspection } from "./managed-files.ts";
import { attestManagedPull, type ManagedPullAttestation } from "./managed-pull.ts";
import { Rejection } from "./request.ts";
import { loadAdditionalManagedFiles } from "./additional-managed-files.ts";
import { findReservationsForPull, type ReservationRecord } from "./automerge-github.ts";
import type { ManagedReservationPayload } from "./automerge.ts";
import { resolveWorkflowRelease, verifyWorkflowReleaseRevision } from "./workflow-release.ts";
import { ReleasedRevision, type Caller } from "./generated-workflows.ts";

const MANAGED_REF = "csm-ci/repo-settings";
const SHA = /^[0-9a-f]{40}$/u;

export type DeriveManagedPullAttestationInput = {
  /** Read access to the trusted server repository. */
  source: GitHub;
  /** Server App read access scoped to the pull request repository. */
  target: GitHub;
  /** Values from the server workflow environment and declared workflow input. */
  serverRepository: string;
  configSha: string;
  configPath: string;
  /** Trusted pin from repo-settings discovery or an active reservation. */
  workflowRelease?: ReleasedRevision;
  /** Server-repository-only deployments:read client for resolving an active reservation. */
  deployments?: GitHub;
  repository: string;
  pullNumber: number;
};
export type ManagedPullSourceContext = Pick<DeriveManagedPullAttestationInput, "source" | "serverRepository" | "configSha" | "configPath" | "workflowRelease" | "deployments">;

/** Recomputes managed-file provenance from the current trusted server configuration. */
export async function deriveManagedPullAttestation(input: DeriveManagedPullAttestationInput): Promise<ManagedPullAttestation | undefined> {
  const repository = normalizeRepository(input.repository);
  const { owner, repo } = splitRepository(repository);
  const { data: pull } = await input.target.rest.pulls.get({ owner, repo, pull_number: input.pullNumber });
  if (pull.head.ref !== MANAGED_REF) return undefined;

  if (!SHA.test(input.configSha)) throw new Rejection("managed pull configuration revision is invalid");
  const serverRepository = normalizeRepository(input.serverRepository);
  const serverAddress = splitRepository(serverRepository);
  const { data: server } = await input.source.rest.repos.get(serverAddress);
  if (!server.default_branch) throw new Rejection("managed pull server default branch is unavailable");
  const { data: serverRef } = await input.source.rest.git.getRef({ ...serverAddress, ref: `heads/${server.default_branch}` });
  if (serverRef.object.sha !== input.configSha) throw new Rejection("managed pull configuration is no longer at the server default-branch head");

  const config = await loadConfig(input.source, serverRepository, input.configSha, input.configPath);
  if (config.server_repository !== serverRepository) throw new Rejection("managed pull configuration identifies a different server repository");
  const entry = repositoryEntry(config, repository);
  if (!entry) throw new Rejection(`managed pull target ${repository} is not configured`);
  if (config.repo_settings?.auto_merge_managed_files !== true) return undefined;
  if (!entry.ops.includes("approve") || !entry.ops.includes("policy-check") || !entry.ops.includes("merge")) {
    throw new Rejection("managed pull automatic completion requires approve, policy-check, and merge operations");
  }

  const { data: targetInfo } = await input.target.rest.repos.get({ owner, repo });
  const repositoryId = Number(targetInfo.id);
  if (targetInfo.full_name?.toLowerCase() !== repository || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Rejection("managed pull target repository identity is invalid");
  }
  if (pull.base.repo?.id !== targetInfo.id || pull.head.repo?.id !== targetInfo.id || pull.base.ref !== targetInfo.default_branch || pull.head.repo?.full_name?.toLowerCase() !== repository || pull.base.repo?.full_name?.toLowerCase() !== repository) {
    throw new Rejection("managed pull repository or base identity changed");
  }

  const callers = selectedCallers(config, repository);
  const headerRelease = await releaseCandidateFromPull(input.target, owner, repo, pull.head.sha, callers);
  const releaseContext = await resolveManagedPullRelease(input, {
    repository,
    repositoryId,
    pullNumber: pull.number,
    pullNodeId: pull.node_id,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    serverBotId: config.apps.server_bot_id,
    headerRelease,
    callers,
  });
  const release = releaseContext.release;
  const additional = await loadAdditionalManagedFiles(input.source, { repository: serverRepository, sha: input.configSha, settings: config.repo_settings });
  const generated = { release, files: generateWorkflows(config, repository, targetInfo.default_branch, release) };
  const inspection = await inspectManagedFiles(input.target, {
    repository,
    defaultBranch: targetInfo.default_branch,
    serverBotId: config.apps.server_bot_id,
    generated,
    files: additional,
  });
  assertManagedPullProposalMatches(inspection, input.pullNumber, pull.head.sha);

  await assertManagedPullContextCurrent({ source: input.source, serverRepository, defaultBranch: server.default_branch, configSha: input.configSha, callers, release });
  await revalidateManagedPullRelease(input, {
    repository,
    repositoryId,
    pullNumber: pull.number,
    pullNodeId: pull.node_id,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    serverBotId: config.apps.server_bot_id,
    headerRelease,
    callers,
  }, releaseContext);

  return attestManagedPull(input.target, {
    repository,
    repositoryId,
    pullNumber: pull.number,
    pullNodeId: pull.node_id,
    defaultBranch: targetInfo.default_branch,
    defaultSha: inspection.defaultSha,
    headSha: pull.head.sha,
    serverBotId: config.apps.server_bot_id,
    configSha: input.configSha,
    releaseSha: release.sha,
    releaseVersion: release.version,
    inspection,
  });
}

export function assertManagedPullProposalMatches(inspection: ManagedFilesInspection, pullNumber: number, headSha: string): void {
  if ((inspection.status !== "ready" && inspection.status !== "already-applied") ||
    inspection.pullRequest !== pullNumber || inspection.targetSha !== headSha) {
    throw new Rejection("managed pull does not match the current trusted managed-file proposal");
  }
}

export type ManagedPullReleaseFacts = {
  repository: string;
  repositoryId: number;
  pullNumber: number;
  pullNodeId: string;
  headSha: string;
  baseRef: string;
  serverBotId: number;
  headerRelease: ReleasedRevision;
  callers: readonly Caller[];
};
export type ManagedPullReleaseContext = { release: ReleasedRevision; reservation?: { deploymentId: number; idempotencyKey: string } };

export function assertManagedPullReleaseContextCurrent(previous: ManagedPullReleaseContext, current: ManagedPullReleaseContext): void {
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Rejection("managed pull reservation or release pin changed during validation");
}

export async function revalidateManagedPullRelease(
  input: Pick<DeriveManagedPullAttestationInput, "source" | "serverRepository" | "configSha" | "workflowRelease" | "deployments">,
  facts: ManagedPullReleaseFacts,
  previous: ManagedPullReleaseContext,
): Promise<void> {
  const current = await resolveManagedPullRelease(input, facts);
  assertManagedPullReleaseContextCurrent(previous, current);
}

export async function resolveManagedPullRelease(input: Pick<DeriveManagedPullAttestationInput, "source" | "serverRepository" | "configSha" | "workflowRelease" | "deployments">, facts: ManagedPullReleaseFacts): Promise<ManagedPullReleaseContext> {
  if (input.workflowRelease) {
    await verifyWorkflowReleaseRevision(input.source, input.workflowRelease, facts.callers);
    return { release: input.workflowRelease };
  }

  if (input.deployments) {
    const records = await findReservationsForPull({
      server: input.deployments,
      serverRepository: input.serverRepository,
      serverBotId: facts.serverBotId,
      repositoryId: facts.repositoryId,
      pullNumber: facts.pullNumber,
      now: new Date(),
    });
    const active = records.filter((record) => record.state.kind === "active");
    const managed = active.filter((record): record is ReservationRecord & { payload: ManagedReservationPayload } => record.payload.version === 2 && record.payload.kind === "managed-files");
    if (active.some((record) => record.payload.version === 1) || managed.length > 1) {
      throw new Rejection("managed pull has an ambiguous active reservation");
    }
    if (managed.length === 1) {
      const payload = managed[0]!.payload;
      if (
        payload.repository.toLowerCase() !== facts.repository || payload.repository_id !== facts.repositoryId ||
        payload.pull_number !== facts.pullNumber || payload.pull_node_id !== facts.pullNodeId ||
        payload.base_ref !== facts.baseRef || payload.accepted_head !== facts.headSha ||
        payload.configuration_sha !== input.configSha
      ) throw new Rejection("active managed reservation does not match the current pull request and configuration");
      if (Date.parse(payload.expires_at) <= Date.now()) throw new Rejection("active managed reservation has expired");
      const pinned = { version: payload.release_version, sha: payload.release_sha };
      await verifyWorkflowReleaseRevision(input.source, pinned, facts.callers);
      return { release: pinned, reservation: { deploymentId: managed[0]!.deploymentId, idempotencyKey: payload.idempotency_key } };
    }
  }

  const latest = await resolveWorkflowRelease(input.source, facts.callers);
  if (latest.version !== facts.headerRelease.version || latest.sha !== facts.headerRelease.sha) {
    throw new Rejection("managed pull workflow release is not the current stable release and has no active reservation pin");
  }
  return { release: latest };
}

export async function assertManagedPullContextCurrent(input: {
  source: GitHub;
  serverRepository: string;
  defaultBranch: string;
  configSha: string;
  callers: readonly Caller[];
  release: ReleasedRevision;
}): Promise<void> {
  const serverAddress = splitRepository(input.serverRepository);
  const [currentServerRef] = await Promise.all([
    input.source.rest.git.getRef({ ...serverAddress, ref: `heads/${input.defaultBranch}` }),
  ]);
  if (currentServerRef.data.object.sha !== input.configSha) throw new Rejection("managed pull configuration changed during validation");
  await verifyWorkflowReleaseRevision(input.source, input.release, input.callers);
}

async function releaseCandidateFromPull(gh: GitHub, owner: string, repo: string, ref: string, callers: readonly Caller[]): Promise<ReleasedRevision> {
  // This is an untrusted lookup hint; pinned release APIs and exact generated bytes authorize it.
  const path = `.github/workflows/csm-ci-${callers[0]}.yml`;
  const { data } = await gh.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Rejection("managed pull has no generated workflow release pin");
  }
  const encoded = data.content.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Rejection("managed pull generated workflow has malformed base64");
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return parseManagedWorkflowReleaseHint(content);
}

export function parseManagedWorkflowReleaseHint(content: string): ReleasedRevision {
  const header = /^# Generated by csm-ci from (v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?) \(([a-f0-9]{40})\)\.$/mu.exec(content);
  if (!header) throw new Rejection("managed pull has no valid generated workflow release pin");
  return ReleasedRevision.parse({ version: header[1], sha: header[2] });
}

function normalizeRepository(value: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) throw new Rejection("managed pull repository is invalid");
  return value.toLowerCase();
}
