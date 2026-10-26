import { z } from "zod";
import { digest, ReleasedRevision, STANDARD_PATHS } from "./generated-workflows.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { readFileAtRef } from "./managed-files.ts";
import { Rejection } from "./request.ts";
import { isServerMadeCommit } from "./server-owned-history.ts";

export const GENERATED_MARKER = "csm-ci-generated-workflows-v1";
const GeneratedRecord = z.strictObject({
  repositoryId: z.number().int().positive(),
  release: ReleasedRevision,
  files: z.record(z.string().refine((path) => STANDARD_PATHS.includes(path)), z.string().regex(/^[a-f0-9]{64}$/u)),
});
export type GeneratedRecord = z.infer<typeof GeneratedRecord>;
export type GeneratedWorkflows = { release: ReleasedRevision; files: Record<string, string>; adoption: Readonly<Record<string, string>> };
export const ownershipBody = (record: GeneratedRecord): string => `${GENERATED_MARKER}\n${JSON.stringify({ ...record, files: Object.fromEntries(Object.entries(record.files).sort(([a], [b]) => a.localeCompare(b))) })}`;

export function parseOwnership(message: string, repositoryId: number): GeneratedRecord | null {
  if (!message.includes(GENERATED_MARKER)) return null;
  const parts = message.split(`\n\n${GENERATED_MARKER}\n`);
  if (parts.length !== 2 || !parts[1]) throw new Rejection("generated workflows ownership record is malformed; preserve files and inspect the original managed head");
  let record: GeneratedRecord;
  try { record = GeneratedRecord.parse(JSON.parse(parts[1])); } catch { throw new Rejection("generated workflows ownership record is malformed; preserve files and inspect the original managed head"); }
  if (record.repositoryId !== repositoryId) throw new Rejection("generated workflows ownership repository ID does not match");
  return record;
}

type Candidate = { number: number; head: string; merge: string };
export async function recoverWorkflowOwnership(gh: GitHub, input: { repository: string; repositoryId: number; defaultBranch: string; defaultSha: string; serverBotId: number }): Promise<{ record: GeneratedRecord | null; legacyPaths: Set<string> }> {
  const address = splitRepository(input.repository);
  const candidates: Candidate[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page++) {
    const { data: pulls } = await gh.rest.pulls.list({ ...address, state: "closed", per_page: 100, page });
    if (!Array.isArray(pulls)) throw new Rejection("generated workflows merged PR pagination is incomplete");
    for (const pull of pulls) {
      if (seen.has(pull.number)) throw new Rejection("generated workflows merged PR pagination is incomplete");
      seen.add(pull.number);
      if (!pull.merged_at || pull.user?.id !== input.serverBotId || pull.head.ref !== "csm-ci/repo-settings" || pull.head.repo?.id !== input.repositoryId || pull.base.repo.id !== input.repositoryId) continue;
      if (!pull.merge_commit_sha || !/^[a-f0-9]{40}$/u.test(pull.merge_commit_sha) || !/^[a-f0-9]{40}$/u.test(pull.head.sha)) throw new Rejection("generated workflows merged PR has unavailable immutable head evidence");
      if (await ancestor(pull.merge_commit_sha, input.defaultSha)) candidates.push({ number: pull.number, head: pull.head.sha, merge: pull.merge_commit_sha });
    }
    if (pulls.length < 100) break;
  }
  async function ancestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const { data } = await gh.rest.repos.compareCommitsWithBasehead({ ...address, basehead: `${base}...${head}`, per_page: 1 });
    if (!data.merge_base_commit?.sha) throw new Rejection("generated workflows default ancestry evidence is incomplete");
    return data.merge_base_commit.sha === base;
  }
  // Rank by actual ancestry rather than mutable PR ordering or branch refs.
  const ranked: Candidate[] = [];
  for (const candidate of candidates) {
    let index = 0;
    for (; index < ranked.length; index++) {
      const other = ranked[index]!;
      if (candidate.merge === other.merge) throw new Rejection("generated workflows merged PR ancestry is ambiguous");
      if (await ancestor(other.merge, candidate.merge)) break;
      if (!await ancestor(candidate.merge, other.merge)) throw new Rejection("generated workflows merged PR ancestry is ambiguous");
    }
    ranked.splice(index, 0, candidate);
  }
  async function authenticate(candidate: Candidate): Promise<GeneratedRecord | null> {
    if (!await isServerMadeCommit(gh, { ...address, sha: candidate.head, serverBotId: input.serverBotId })) throw new Rejection("generated workflows original managed head is not GitHub-signed by the configured Server bot");
    const { data: commit } = await gh.rest.repos.getCommit({ ...address, ref: candidate.head });
    const record = parseOwnership(commit.commit.message, input.repositoryId);
    if (record) {
      for (const [path, expected] of Object.entries(record.files)) {
        const value = await readFileAtRef(gh, address.owner, address.repo, path, candidate.head);
        if (value.content === null || digest(value.content) !== expected) throw new Rejection(`generated workflows original head tree does not bind ${JSON.stringify(path)}`);
      }
    }
    return record;
  }
  const newest = ranked[0];
  if (!newest) return { record: null, legacyPaths: new Set() };
  const record = await authenticate(newest);
  const legacyPaths = new Set<string>();
  if (!record) for (const older of ranked.slice(1)) {
    const prior = await authenticate(older);
    for (const path of Object.keys(prior?.files ?? {})) legacyPaths.add(path);
  }
  return { record, legacyPaths };
}

export async function inspectGeneratedWorkflows(gh: GitHub, input: { repository: string; defaultBranch: string; defaultSha: string; serverBotId: number; generated: GeneratedWorkflows; additional: Readonly<Record<string, string>> }): Promise<{ record: GeneratedRecord; deletions: string[]; ownershipNeeded: boolean }> {
  const address = splitRepository(input.repository);
  const { data: repository } = await gh.rest.repos.get(address);
  const repositoryId = z.number().int().positive().parse(repository.id);
  if (repository.default_branch !== input.defaultBranch) throw new Rejection("generated workflows repository default branch changed");
  const { record: prior, legacyPaths } = await recoverWorkflowOwnership(gh, { ...input, repositoryId });
  const paths = new Set([...Object.keys(prior?.files ?? {}), ...Object.keys(input.generated.files), ...Object.keys(input.generated.adoption)]);
  const deletions: string[] = [];
  for (const path of paths) {
    const active = Object.hasOwn(input.generated.files, path);
    const priorDigest = prior?.files[path];
    const value = await readFileAtRef(gh, address.owner, address.repo, path, input.defaultSha);
    if (priorDigest !== undefined) {
      if (value.content !== null && digest(value.content) !== priorDigest) throw new Rejection(`generated workflow ${JSON.stringify(path)} was customized; preserve it and review ownership`);
      if (!active && value.content !== null) deletions.push(path);
    } else {
      const adoption = input.generated.adoption[path];
      if (adoption !== undefined && (value.content === null || digest(value.content) !== adoption)) throw new Rejection(`workflow adoption digest is stale or file is absent for ${JSON.stringify(path)}`);
      if (active && value.content !== null && (adoption === undefined || legacyPaths.has(path))) throw new Rejection(`generated workflow ${JSON.stringify(path)} requires authenticated ownership or explicit first adoption`);
    }
    if ((active || deletions.includes(path)) && Object.hasOwn(input.additional, path)) throw new Rejection(`managed files contain duplicate producer destination ${JSON.stringify(path)}`);
  }
  const record = { repositoryId, release: input.generated.release, files: Object.fromEntries(Object.entries(input.generated.files).map(([path, text]) => [path, digest(text)])) };
  const ownershipNeeded = (Object.keys(record.files).length > 0 || Object.keys(prior?.files ?? {}).length > 0) && (prior === null || ownershipBody(prior) !== ownershipBody(record));
  return { record, deletions: deletions.sort(), ownershipNeeded };
}
