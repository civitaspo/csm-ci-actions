import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GENERATED_HEADER, hasGeneratedHeader } from "../src/lib/generated-workflows.ts";
import { resolveWorkflowRelease } from "../src/lib/workflow-release.ts";
import { MANAGED_FILES_TITLE, readFileAtRef } from "../src/lib/managed-files.ts";
import { isServerMadeCommit } from "../src/lib/server-owned-history.ts";
import { prCase } from "./harness.ts";
import { annotatePr, assertManagedMetadata, labelPr, ownedAnnotationNumber } from "./pr-metadata.ts";
import { z } from "zod";
import { type GitHub, splitRepository } from "../src/lib/github.ts";
import { inspectRepoSettingsPreflight } from "../src/lib/repo-settings.ts";
import { assert, CLIENT, dispatch, drainWorkflowRuns, hasStatus, jobLog, SERVER, SERVER_BOT_ID, type Ctx, type Scenario, until, withServerConfig } from "./harness.ts";
import { withCleanup } from "./cleanup.ts";
import { onceAsync } from "./drain.ts";
import { parseCreatedRulesets, rulesetCleanupPlan } from "./repo-settings-ownership.ts";
import { parseAutomergePayload } from "./merge.ts";

const BRANCH = "csm-ci/repo-settings";
const MANAGED_MARKER = "<!-- csm-ci:repo-settings:managed-files -->";
// Earlier server releases used the legacy subject; cleanup still recognizes their branches.
const MANAGED_SUBJECTS = new Set([MANAGED_FILES_TITLE, "Sync managed files"]);
const RULESET_NAMES = new Set(["integrity", "review-and-checks", "controlled-merges", "release-tags"]);
export const UNMANAGED_SQUASH_SETTINGS = {
  squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
  squash_merge_commit_message: "COMMIT_MESSAGES",
} satisfies Pick<NonNullable<Parameters<GitHub["rest"]["repos"]["update"]>[0]>, "squash_merge_commit_title" | "squash_merge_commit_message">;
const SettingsSnapshotSchema = z.object({
  delete_branch_on_merge: z.boolean(),
  allow_auto_merge: z.boolean(),
  allow_squash_merge: z.boolean(),
  allow_merge_commit: z.boolean(),
  allow_rebase_merge: z.boolean(),
  has_wiki: z.boolean(),
  has_projects: z.boolean(),
  allow_update_branch: z.boolean(),
  squash_merge_commit_title: z.enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"]),
  squash_merge_commit_message: z.enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"]),
});

type RulesetUpdate = NonNullable<Parameters<GitHub["rest"]["repos"]["updateRepoRuleset"]>[0]>;
type RuleSet = {
  id: number;
  name: string;
  source_type?: string;
  updated_at?: string;
  target: NonNullable<RulesetUpdate["target"]>;
  enforcement: NonNullable<RulesetUpdate["enforcement"]>;
  conditions: NonNullable<RulesetUpdate["conditions"]>;
  rules: NonNullable<RulesetUpdate["rules"]>;
  bypass_actors: NonNullable<RulesetUpdate["bypass_actors"]>;
};
type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;
type RuleSetSnapshot = Omit<RuleSet, "id" | "source_type">;
type RepoSnapshot = { settings: SettingsSnapshot; rulesets: RuleSet[]; immutableReleases: boolean; dependabotSecurityUpdates: boolean };
type ManagedPull = { number: number; headSha: string };
type ManagedCompletionPull = ManagedPull & { authorId: number | bigint | undefined; headRef: string; baseRef: string };
type ManagedReservationState = "active" | "success" | "failure" | "inactive";

const RuleSetSummarySchema = z.object({ id: z.number().int().positive(), name: z.string(), source_type: z.string().optional() }).passthrough();
const RuleSetDetailsSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  source_type: z.string().optional(),
  updated_at: z.string().optional(),
  target: z.enum(["branch", "push", "tag"]),
  enforcement: z.enum(["active", "disabled", "evaluate"]),
  conditions: z.record(z.string(), z.unknown()),
  rules: z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()),
  bypass_actors: z.array(z.object({ actor_id: z.number().nullable().optional(), actor_type: z.string(), bypass_mode: z.string().optional() }).passthrough()),
}).passthrough();

export async function snapshotRepository(gh: GitHub, repository: string, phase: "baseline" | "restored" | "observed" = "baseline"): Promise<RepoSnapshot> {
  const address = splitRepository(repository);
  const [{ data: repositoryInfo }, rawRulesets, immutableReleases, dependabotSecurityUpdates] = await Promise.all([
    gh.rest.repos.get(address),
    gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 }),
    immutableReleaseState(gh, repository),
    dependabotSecurityUpdatesState(gh, repository),
  ]);
  const settings = SettingsSnapshotSchema.parse(repositoryInfo);
  const rulesets = await listManagedRulesets(gh, repository, rawRulesets);
  const snapshot = { settings, rulesets, immutableReleases, dependabotSecurityUpdates };
  console.log(`repo-settings-snapshot ${JSON.stringify({ repository, phase, snapshot })}`);
  return snapshot;
}

async function immutableReleaseState(gh: GitHub, repository: string): Promise<boolean> {
  try {
    const result = await gh.request("GET /repos/{owner}/{repo}/immutable-releases", splitRepository(repository));
    return (result.data as { enabled?: boolean }).enabled === true;
  } catch (error) {
    if (hasStatus(error, 404)) return false;
    throw error;
  }
}

async function dependabotSecurityUpdatesState(gh: GitHub, repository: string): Promise<boolean> {
  try {
    const { data } = await gh.request("GET /repos/{owner}/{repo}/automated-security-fixes", splitRepository(repository));
    return z.object({ enabled: z.boolean() }).parse(data).enabled;
  } catch (error) {
    if (hasStatus(error, 404)) return false;
    throw error;
  }
}

// A read right after the write can still return the previous value, so this waits until the write is visible.
async function setDependabotSecurityUpdates(gh: GitHub, repository: string, enabled: boolean): Promise<void> {
  await gh.request(enabled ? "PUT /repos/{owner}/{repo}/automated-security-fixes" : "DELETE /repos/{owner}/{repo}/automated-security-fixes", splitRepository(repository));
  await until(`Dependabot security updates ${enabled ? "enabled" : "disabled"} in ${repository}`, async () => await dependabotSecurityUpdatesState(gh, repository) === enabled ? true : undefined);
}

async function listManagedRulesets(gh: GitHub, repository = CLIENT, raw?: unknown[]): Promise<RuleSet[]> {
  raw ??= await gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...splitRepository(repository), per_page: 100 });
  return listManagedRuleSetDetails(gh, repository, raw);
}

async function listManagedRuleSetDetails(gh: GitHub, repository: string, raw: unknown[]): Promise<RuleSet[]> {
  const summaries = raw.map((entry) => RuleSetSummarySchema.parse(entry)).filter((entry) => entry.source_type === "Repository" && RULESET_NAMES.has(entry.name));
  return Promise.all(summaries.map(async (summary) => {
    const { data } = await gh.rest.repos.getRepoRuleset({ ...splitRepository(repository), ruleset_id: summary.id });
    const checked = RuleSetDetailsSchema.parse(data);
    assert(checked.id === summary.id && checked.name === summary.name, `ruleset summary changed while reading ${repository}#${summary.id}`);
    return {
      id: checked.id,
      name: checked.name,
      ...(checked.source_type ? { source_type: checked.source_type } : {}),
      ...(checked.updated_at ? { updated_at: checked.updated_at } : {}),
      target: checked.target,
      enforcement: checked.enforcement,
      conditions: data.conditions ?? {},
      rules: data.rules ?? [],
      bypass_actors: data.bypass_actors ?? [],
    };
  }));
}

// Each step runs even when an earlier one fails, so one failed call cannot leave the rest unrestored.
export async function restoreRepository(gh: GitHub, repository: string, snapshot: RepoSnapshot, createdRulesetIds: ReadonlySet<number>): Promise<void> {
  const address = splitRepository(repository);
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  const originalIds = new Set(snapshot.rulesets.map((ruleset) => ruleset.id));
  await attempt(async () => {
    const current = await listManagedRulesets(gh, repository);
    const plan = rulesetCleanupPlan(current, originalIds, createdRulesetIds);
    for (const message of plan.errors) failures.push(new Error(message));
    for (const id of plan.deleteIds) await attempt(() => gh.rest.repos.deleteRepoRuleset({ ...address, ruleset_id: id }));
  });
  for (const ruleset of snapshot.rulesets) {
    const body: RuleSetSnapshot = {
      name: ruleset.name,
      target: ruleset.target,
      enforcement: ruleset.enforcement,
      conditions: ruleset.conditions,
      rules: ruleset.rules,
      bypass_actors: ruleset.bypass_actors,
    };
    await attempt(() => gh.rest.repos.updateRepoRuleset({ ...address, ruleset_id: ruleset.id, ...body }));
  }
  await attempt(() => gh.rest.repos.update({ ...address, ...snapshot.settings }));
  if (!snapshot.immutableReleases) await attempt(() => gh.request("DELETE /repos/{owner}/{repo}/immutable-releases", address));
  // GitHub rejects both writes while Dependabot alerts are disabled, so restore writes only on a difference.
  await attempt(async () => { if (await dependabotSecurityUpdatesState(gh, repository) !== snapshot.dependabotSecurityUpdates) await setDependabotSecurityUpdates(gh, repository, snapshot.dependabotSecurityUpdates); });
  let restored: RepoSnapshot | undefined;
  await attempt(async () => { restored = await snapshotRepository(gh, repository, "restored"); });
  if (failures.length > 0) throw new AggregateError(failures, `restoring ${repository} failed in ${failures.length} step(s)`);
  assert(restored, `could not read restored repository state for ${repository}`);
  assert(isDeepStrictEqual(restored.settings, snapshot.settings), `repository settings were not restored for ${repository}`);
  assert(restored.immutableReleases === snapshot.immutableReleases, `immutable releases were not restored for ${repository}`);
  assert(restored.dependabotSecurityUpdates === snapshot.dependabotSecurityUpdates, `Dependabot security updates were not restored for ${repository}`);
  assert(isDeepStrictEqual(normalizeRuleSets(restored.rulesets), normalizeRuleSets(snapshot.rulesets)), `rulesets were not restored for ${repository}`);
}

function normalizeRuleSets(rulesets: RuleSet[]): Omit<RuleSet, "id" | "source_type" | "updated_at">[] {
  return rulesets.map(({ id, source_type: _sourceType, updated_at: _updatedAt, ...ruleset }) => ruleset).sort((a, b) => a.name.localeCompare(b.name));
}

async function managedBranchHead(gh: GitHub, repository = CLIENT): Promise<string | undefined> {
  try {
    const { data } = await gh.rest.git.getRef({ ...splitRepository(repository), ref: `heads/${BRANCH}` });
    return data.object.sha;
  } catch (error) {
    if (hasStatus(error, 404)) return undefined;
    throw error;
  }
}

async function openManagedPull(gh: GitHub, repository = CLIENT): Promise<ManagedPull[]> {
  const { data } = await gh.rest.pulls.list({
    ...splitRepository(repository),
    state: "open",
    head: `${splitRepository(repository).owner}:${BRANCH}`,
    base: "main",
    per_page: 100,
  });
  return data.filter((pull) => pull.body?.includes(MANAGED_MARKER)).map((pull) => ({ number: pull.number, headSha: pull.head.sha }));
}

async function recentManagedPulls(ctx: Ctx, since: Date): Promise<ManagedCompletionPull[]> {
  const { data } = await ctx.gh.rest.pulls.list({
    ...splitRepository(CLIENT), state: "all", head: `${splitRepository(CLIENT).owner}:${BRANCH}`, base: "main", per_page: 100,
  });
  return data.filter((pull) => pull.body?.includes(MANAGED_MARKER) && Date.parse(pull.created_at) >= since.getTime()).map((pull) => ({
    number: pull.number,
    headSha: pull.head.sha,
    authorId: pull.user?.id,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
  }));
}

export function enableManagedFileAutoCompletion(configText: string, driftPath: string): string {
  let updated = configText;
  const flagLines = [...updated.matchAll(/^  auto_merge_managed_files: ([^\n]+)$/gmu)];
  assert(flagLines.length <= 1, "trusted Server fixture has duplicate auto_merge_managed_files fields");
  if (flagLines.length === 1) {
    assert(flagLines[0]![1] === "true" || flagLines[0]![1] === "false", "trusted Server fixture has a non-boolean auto_merge_managed_files value");
    updated = updated.replace(/^  auto_merge_managed_files: (?:true|false)$/mu, "  auto_merge_managed_files: true");
  } else {
    assert(/^repo_settings:\s*$/mu.test(updated), "trusted Server fixture has no repo_settings section");
    updated = updated.replace(/^repo_settings:\s*$/mu, "repo_settings:\n  auto_merge_managed_files: true");
  }

  const escapedPath = driftPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const driftMapping = [...updated.matchAll(new RegExp(`^    ${escapedPath}: ([^\\n]+)$`, "gmu"))];
  assert(driftMapping.length <= 1, `trusted Server fixture has duplicate ${driftPath} mappings`);
  if (driftMapping.length === 1) {
    assert(driftMapping[0]![1] === "managed-files/repo-settings-managed.txt", `trusted Server fixture maps ${driftPath} to an unexpected source`);
  } else {
    const sourceMapping = "    e2e/repo-settings-managed.txt: managed-files/repo-settings-managed.txt";
    assert(updated.split(sourceMapping).length === 2, "trusted Server fixture has no unique managed-file source mapping");
    updated = updated.replace(sourceMapping, `${sourceMapping}\n    ${driftPath}: managed-files/repo-settings-managed.txt`);
  }
  return updated;
}

async function managedReservations(ctx: Ctx, pullNumber: number): Promise<{ id: number; payload: Record<string, unknown>; state: ManagedReservationState }[]> {
  const data = await ctx.gh.graphql<{
    client: { databaseId: number };
    server: { deployments: { nodes: { databaseId: number; task: string; payload: unknown; creator: { __typename: string; databaseId: number } | null }[] } };
  }>("query{client:repository(owner:\"civitaspo\",name:\"testing-csm-ci-client\"){databaseId} server:repository(owner:\"civitaspo\",name:\"testing-csm-ci-server\"){deployments(environments:[\"csm-ci-automerge\"],first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{id databaseId task payload creator{__typename ... on Bot{databaseId}}}}}}");
  const matches = data.server.deployments.nodes.flatMap((deployment) => {
    let payload: unknown;
    try { payload = parseAutomergePayload(deployment.payload); } catch { return []; }
    if (deployment.task !== "csm-ci:automerge" || deployment.creator?.__typename !== "Bot" || deployment.creator.databaseId !== SERVER_BOT_ID ||
      typeof payload !== "object" || payload === null || !("kind" in payload) || payload.kind !== "managed-files" ||
      !("repository_id" in payload) || payload.repository_id !== data.client.databaseId || !("pull_number" in payload) || payload.pull_number !== pullNumber) return [];
    return [{ deployment, payload: payload as Record<string, unknown> }];
  });
  return Promise.all(matches.map(async ({ deployment, payload }) => {
    const statuses = await ctx.gh.paginate(ctx.gh.rest.repos.listDeploymentStatuses, { ...splitRepository(SERVER), deployment_id: deployment.databaseId, per_page: 100 });
    const terminal = statuses.filter((status) => status.creator?.id === SERVER_BOT_ID && status.creator.type === "Bot" && ["success", "failure", "inactive"].includes(status.state))
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || Number(right.id) - Number(left.id))[0];
    const state: ManagedReservationState = terminal?.state === "success" ? "success" : terminal?.state === "failure" ? "failure" : terminal?.state === "inactive" ? "inactive" : "active";
    return { id: deployment.databaseId, payload, state };
  }));
}

async function managedReservation(ctx: Ctx, pullNumber: number): Promise<{ id: number; payload: Record<string, unknown>; state: ManagedReservationState } | undefined> {
  const matches = await managedReservations(ctx, pullNumber);
  if (matches.length > 1) throw new Error(`multiple managed-file reservations found for pull request #${pullNumber}`);
  return matches[0];
}

async function createManagedMergeGate(ctx: Ctx): Promise<() => Promise<void>> {
  const address = splitRepository(CLIENT);
  const name = `csm-ci-e2e-managed-${randomUUID()}`;
  const context = `${name}/hold`;
  const conditions = { ref_name: { include: ["refs/heads/main"], exclude: [] } };
  const rules = [{ type: "required_status_checks", parameters: {
    do_not_enforce_on_create: false,
    strict_required_status_checks_policy: false,
    required_status_checks: [{ context }],
  } }] satisfies NonNullable<RulesetUpdate["rules"]>;
  // The owner token writes the base drift directly; the Server App is an Integration,
  // not a repository-role member, so it still cannot bypass this merge gate.
  const bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] satisfies NonNullable<RulesetUpdate["bypass_actors"]>;
  const before = await ctx.gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 });
  assert(!before.some((entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === name), `a ruleset named ${name} already exists`);
  const created = await ctx.gh.rest.repos.createRepoRuleset({
    ...address,
    name,
    target: "branch",
    enforcement: "active",
    conditions,
    rules,
    bypass_actors: bypassActors,
  });
  let released = false;
  const verifyOwnedGate = async (): Promise<void> => {
    const { data } = await ctx.gh.rest.repos.getRepoRuleset({ ...address, ruleset_id: created.data.id });
    assert(data.id === created.data.id && data.name === name && data.target === "branch" && data.enforcement === "active", `owned managed-merge gate ${created.data.id} changed identity or enforcement`);
    assert(isDeepStrictEqual(data.conditions, conditions), `owned managed-merge gate ${created.data.id} changed its target`);
    assert(Array.isArray(data.bypass_actors) && data.bypass_actors.length === 1 && data.bypass_actors[0]?.actor_id === 5 && data.bypass_actors[0]?.actor_type === "RepositoryRole" && data.bypass_actors[0]?.bypass_mode === "always", `owned managed-merge gate ${created.data.id} changed its owner-only bypass`);
    const required = data.rules?.find((rule) => rule.type === "required_status_checks");
    const requiredChecks = required?.parameters?.required_status_checks;
    assert(Array.isArray(requiredChecks) && requiredChecks.length === 1 && requiredChecks[0]?.context === context, `owned managed-merge gate ${created.data.id} changed its required check`);
  };
  try {
    await verifyOwnedGate();
    const after = await ctx.gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 });
    const ids = new Set(after.flatMap((entry) => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "number" ? [entry.id] : []));
    assert(before.every((entry) => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "number" && ids.has(entry.id)), "creating the managed-merge gate removed an existing repository ruleset");
  } catch (error) {
    try {
      await verifyOwnedGate();
      await ctx.gh.rest.repos.deleteRepoRuleset({ ...address, ruleset_id: created.data.id });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `managed merge gate ${created.data.id} verification failed and safe cleanup could not be completed`);
    }
    throw error;
  }
  return async () => {
    if (released) return;
    await verifyOwnedGate();
    await ctx.gh.rest.repos.deleteRepoRuleset({ ...address, ruleset_id: created.data.id });
    released = true;
  };
}

export async function ownedManagedHead(ctx: Pick<Ctx, "gh">, repository = CLIENT, managedPaths: readonly string[] = ["e2e/repo-settings-managed.txt"]): Promise<{ sha: string; pull?: ManagedPull } | undefined> {
  const sha = await managedBranchHead(ctx.gh, repository);
  if (!sha) return undefined;
  const { data: commit } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(repository), ref: sha });
  const changedPaths = commit.files?.map((file) => file.filename) ?? [];
  const [headline] = commit.commit.message.split("\n");
  if (!MANAGED_SUBJECTS.has(headline ?? "")) return undefined;
  // Generated callers are recognized by their first-line header: written files carry it at the head, deleted files carried it at the parent.
  const address = splitRepository(repository);
  const generatedPaths: string[] = [];
  for (const file of commit.files ?? []) {
    if (managedPaths.includes(file.filename) || !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.filename)) continue;
    const removed = file.status === "removed";
    const ref = removed ? commit.parents?.[0]?.sha : sha;
    if (!ref) return undefined;
    const value = await readFileAtRef(ctx.gh, address.owner, address.repo, file.filename, ref);
    if (value.content === null || !hasGeneratedHeader(value.content)) return undefined;
    if (removed && (await readFileAtRef(ctx.gh, address.owner, address.repo, file.filename, sha)).content !== null) return undefined;
    generatedPaths.push(file.filename);
  }
  if (generatedPaths.length > 0 && !await isServerMadeCommit(ctx.gh, { ...address, sha, serverBotId: SERVER_BOT_ID })) return undefined;
  if (commit.author?.id !== SERVER_BOT_ID || (changedPaths.length === 0 && generatedPaths.length === 0) || changedPaths.some((path) => !managedPaths.includes(path) && !generatedPaths.includes(path))) return undefined;
  if (commit.commit.verification?.verified !== true || commit.commit.verification.reason !== "valid") return undefined;
  const pulls = await openManagedPull(ctx.gh, repository);
  if (pulls.length > 1) return undefined;
  const pull = pulls[0];
  if (pull && pull.headSha !== sha) return undefined;
  return { sha, ...(pull ? { pull } : {}) };
}

async function dispatchReconciliation(
  ctx: Ctx,
  repository: string,
  eventMode: "schedule" | "dispatch",
  configPath?: string,
  options: { targets?: string; createdRulesetIds?: Set<number>; expectedConclusion?: "success" | "failure" } = {},
): Promise<{ id: number; url: string; stepConclusions: Map<string, string | null>; reconcileLog: string }> {
  const expectedConclusion = options.expectedConclusion ?? "success";
  const run = await dispatch(ctx, SERVER, "csm-ci-repo-settings.yml", {
    repository,
    "event-mode": eventMode,
    targets: options.targets ?? "all",
    ...(configPath ? { "config-path": configPath } : {}),
    // The schedule branch calls the target workflow directly, so it supplies what discovery would resolve.
    ...(eventMode === "schedule" ? { "workflow-release": JSON.stringify(await resolveWorkflowRelease(ctx.gh, [])) } : {}),
  });
  const namedJobs = await until(`repo-settings jobs for ${run.html_url}`, async () => {
    const result = await ctx.gh.rest.actions.listJobsForWorkflowRun({ ...splitRepository(SERVER), run_id: run.id });
    return result.data.jobs.length > 0 ? result.data.jobs : undefined;
  });
  const reconcileJob = namedJobs.find((job) => job.name.includes("reconcile"));
  assert(reconcileJob, `repo-settings reconcile job is missing (${run.html_url})`);
  let reconcileLog: string;
  try {
    reconcileLog = await jobLog(ctx, SERVER, reconcileJob.id);
  } catch (error) {
    throw new Error(`could not read repo-settings reconcile log for ruleset ownership (${run.html_url}): ${String(error)}`);
  }
  const created = parseCreatedRulesets(reconcileLog, repository);
  for (const ruleset of created.rulesets) options.createdRulesetIds?.add(ruleset.id);
  assert(created.errors.length === 0, `repo-settings ruleset ownership records are invalid: ${created.errors.join("; ")} (${run.html_url})`);
  assert(run.conclusion === expectedConclusion, `repo-settings ${eventMode} run concluded ${run.conclusion}, expected ${expectedConclusion} (${run.html_url})`);
  if (expectedConclusion === "success") assert(reconcileJob.conclusion === "success", `repo-settings reconcile job did not succeed (${run.html_url})`);
  const steps = reconcileJob?.steps ?? [];
  return {
    id: run.id,
    url: run.html_url,
    stepConclusions: new Map(steps.map((step) => [step.name, step.conclusion])),
    reconcileLog,
  };
}

async function ensureNoPreviousManagedState(ctx: Ctx, repository = CLIENT): Promise<void> {
  assert((await managedBranchHead(ctx.gh, repository)) === undefined, `ref ${BRANCH} already exists in ${repository}; refusing to reuse it`);
  assert((await openManagedPull(ctx.gh, repository)).length === 0, `an open managed-files pull request already exists in ${repository}`);
}

async function cleanupManagedState(ctx: Ctx, observedHead: string | undefined, pull: ManagedPull | undefined, repository = CLIENT, managedPaths: readonly string[] = ["e2e/repo-settings-managed.txt"]): Promise<void> {
  const owned = await ownedManagedHead(ctx, repository, managedPaths);
  if (!observedHead) {
    if (!owned) {
      assert((await managedBranchHead(ctx.gh, repository)) === undefined, `ref ${BRANCH} exists in ${repository}, but its ownership cannot be verified; refusing cleanup`);
      return;
    }
    observedHead = owned.sha;
    pull = owned.pull;
  }
  assert(owned, `ref ${BRANCH} exists in ${repository}, but its ownership cannot be verified; refusing cleanup`);
  assert(owned.sha === observedHead, `ref ${BRANCH} moved in ${repository}; refusing cleanup`);
  pull ??= owned.pull;
  assert(pull, `ref ${BRANCH} in ${repository} has no matching managed pull request; refusing cleanup`);
  const address = splitRepository(repository);
  const currentHead = await managedBranchHead(ctx.gh, repository);
  assert(currentHead === observedHead, `ref ${BRANCH} moved in ${repository}; refusing cleanup`);
  if (pull) {
    const { data } = await ctx.gh.rest.pulls.get({ ...address, pull_number: pull.number });
    if (data.state === "open" && data.head.ref === BRANCH && data.head.sha === observedHead && data.body?.includes(MANAGED_MARKER)) {
      await ctx.gh.rest.pulls.update({ ...address, pull_number: pull.number, state: "closed" });
    }
  }
  const verifiedHead = await managedBranchHead(ctx.gh, repository);
  assert(verifiedHead === observedHead, `ref ${BRANCH} moved in ${repository}; refusing cleanup`);
  await ctx.gh.rest.git.deleteRef({ ...address, ref: `heads/${BRANCH}` });
}

// Captures a client main file so a scenario can change it and restore the original bytes afterwards.
async function clientMainFile(ctx: Ctx, path: string): Promise<{ write: (content: string) => Promise<void>; restore: () => Promise<void> }> {
  const address = splitRepository(CLIENT);
  let original: string | null = null;
  try {
    original = (await readFileAtRef(ctx.gh, address.owner, address.repo, path, "main")).content;
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
  const currentSha = async (): Promise<string | undefined> => {
    try {
      const { data } = await ctx.gh.rest.repos.getContent({ ...address, path, ref: "main" });
      assert(!Array.isArray(data) && data.type === "file", `${path} is not a file`);
      return data.sha;
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
      return undefined;
    }
  };
  const put = async (content: string, message: string, sha: string | undefined) => {
    await ctx.gh.rest.repos.createOrUpdateFileContents({ ...address, path, message, content: Buffer.from(content).toString("base64"), branch: "main", ...(sha ? { sha } : {}) });
  };
  return {
    write: async (content) => put(content, "Exercise managed-file drift", await currentSha()),
    restore: async () => {
      const sha = await currentSha();
      if (original === null) {
        if (sha) await ctx.gh.rest.repos.deleteFile({ ...address, path, message: "Restore managed-file e2e fixture", sha, branch: "main" });
      } else {
        assert(sha, `${path} disappeared before cleanup`);
        await put(original, "Restore managed-file e2e fixture", sha);
      }
    },
  };
}

async function makeSettingsDrift(ctx: Ctx): Promise<void> {
  const address = splitRepository(CLIENT);
  const desired = {
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
  await ctx.gh.rest.repos.update({ ...address, delete_branch_on_merge: !desired.delete_branch_on_merge, allow_auto_merge: !desired.allow_auto_merge, allow_squash_merge: true, squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "COMMIT_MESSAGES", has_wiki: true, has_projects: true, allow_update_branch: false });
  await setDependabotSecurityUpdates(ctx.gh, CLIENT, true);
  const existing = (await listManagedRulesets(ctx.gh)).find((ruleset) => ruleset.name === "integrity");
  if (existing) {
    await ctx.gh.rest.repos.updateRepoRuleset({
      ...address,
      ruleset_id: existing.id,
      name: existing.name,
      target: existing.target,
      enforcement: "disabled",
      conditions: existing.conditions,
      rules: existing.rules,
      bypass_actors: existing.bypass_actors,
    });
  }
}

async function assertSettingsReconciled(ctx: Ctx, repository = CLIENT): Promise<void> {
  await assertRepositorySettings(ctx, repository);
  assert(await dependabotSecurityUpdatesState(ctx.gh, repository) === false, `Dependabot security updates are still enabled in ${repository} after dispatch reconciliation`);
  const rulesets = await listManagedRulesets(ctx.gh, repository);
  for (const name of RULESET_NAMES) {
    const named = rulesets.filter((ruleset) => ruleset.name === name);
    assert(named.length === 1, `expected exactly one Repository ruleset named ${name}, found ${named.length}`);
    if (name !== "controlled-merges") assert(named[0]?.enforcement === "active", `${name} is not active after dispatch reconciliation`);
  }
}

export async function assertRepositorySettings(ctx: Ctx, repository: string): Promise<void> {
  const expected = {
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    has_wiki: false,
    has_projects: false,
    allow_update_branch: true,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  } satisfies SettingsSnapshot;
  await until(`reconciled repository settings in ${repository}`, async () => {
    const { data } = await ctx.gh.rest.repos.get(splitRepository(repository));
    const actual = SettingsSnapshotSchema.parse(data);
    const mismatches = SettingsSnapshotSchema.keyof().options.filter((key) => actual[key] !== expected[key])
      .map((key) => ({ key, expected: expected[key], actual: actual[key] }));
    console.log(`repo-settings-observation ${JSON.stringify({ repository, mismatches })}`);
    return mismatches.length === 0 ? true : undefined;
  });
}

// Stops controlled-merges and drifts its bypass, so the schedule must repair it without reactivating it.
async function disableControlledMerges(ctx: Ctx): Promise<void> {
  const ruleset = (await listManagedRulesets(ctx.gh)).find((item) => item.name === "controlled-merges");
  assert(ruleset, "controlled-merges ruleset is missing after dispatch reconciliation");
  await ctx.gh.rest.repos.updateRepoRuleset({
    ...splitRepository(CLIENT),
    ruleset_id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    enforcement: "disabled",
    conditions: ruleset.conditions,
    rules: ruleset.rules,
    bypass_actors: ruleset.bypass_actors.map((actor) => ({ ...actor, bypass_mode: "always" as const })),
  });
}

async function assertControlledMergesDisabled(ctx: Ctx): Promise<void> {
  const ruleset = (await listManagedRulesets(ctx.gh)).find((item) => item.name === "controlled-merges");
  assert(ruleset?.enforcement === "disabled", `schedule reconciliation changed controlled-merges to ${ruleset?.enforcement ?? "missing"}`);
  assert(ruleset.bypass_actors.length === 1 && ruleset.bypass_actors[0]?.bypass_mode === "pull_request", "schedule reconciliation did not repair the controlled-merges bypass");
}

async function rulesetUpdateTimes(gh: GitHub, repository = CLIENT): Promise<Map<number, string | undefined>> {
  return new Map((await listManagedRulesets(gh, repository)).map((ruleset) => [ruleset.id, ruleset.updated_at]));
}

const SponsorState = z.object({ repository: z.object({ id: z.string().min(1), hasSponsorshipsEnabled: z.boolean() }) });
async function sponsorState(gh: GitHub) {
  const { owner, repo } = splitRepository(CLIENT);
  return SponsorState.parse(await gh.graphql<unknown>("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id hasSponsorshipsEnabled}}", { owner, name: repo })).repository;
}

export const repoSettings: Scenario[] = [
  ...([true, false, "managed-files"] as const).map((setting): Scenario => ({
    id: `repo-settings.funding-${setting}`,
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: `sponsorship funding PR and repeat with ${setting}`,
        classification: "positive",
        checks: [
          "repository-settings",
          "metadata-refresh",
          "replay"
        ],
        steps: [
          {
            "operation": "repo-settings",
            "outcome": "permitted",
            "expected": "The managed funding PR contains configured funding bytes; repeat preserves its PR and head"
          }
        ],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes configured managed funding files."
        ]
      }
    },
    name: `sponsorship funding PR and repeat with ${setting}`,
    serial: true,
    run: async (ctx) => {
      await ensureNoPreviousManagedState(ctx);
      const snapshot = await snapshotRepository(ctx.gh, CLIENT);
      const sponsorship = await sponsorState(ctx.gh);
      const createdRulesetIds = new Set<number>();
      const enabled = setting === "managed-files" ? !sponsorship.hasSponsorshipsEnabled : setting;
      const targets = setting === "managed-files" ? setting : "all";
      await withCleanup(async () => {
        if (targets === "all") {
          await ctx.gh.graphql("mutation($id:ID!,$enabled:Boolean!){updateRepository(input:{repositoryId:$id,hasSponsorshipsEnabled:$enabled}){repository{id}}}", { id: sponsorship.id, enabled: !enabled });
        }
        await withServerConfig(ctx, (text) => {
          const changed = text.replace("repo_settings:\n", `repo_settings:\n  sponsorships: { enabled: ${enabled}, github: [civitaspo] }\n`);
          assert(changed !== text, "could not add explicit sponsorship e2e configuration");
          return changed;
        }, async () => {
          const first = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds, targets });
          assert((await sponsorState(ctx.gh)).hasSponsorshipsEnabled === (targets === "all" ? enabled : sponsorship.hasSponsorshipsEnabled), `incorrect Sponsor button setting (${first.url})`);
          const head = await managedBranchHead(ctx.gh);
          const pulls = await openManagedPull(ctx.gh);
          assert(head && pulls.length === 1 && pulls[0]?.headSha === head, `missing funding PR (${first.url})`);
          const owned = await ownedManagedHead(ctx, CLIENT, ["e2e/repo-settings-managed.txt", ".github/FUNDING.yml"]);
          const ownedNumber = ownedAnnotationNumber(owned, pulls[0]!.number);
          await labelPr(ctx.gh, CLIENT, ownedNumber, ctx.run, prCase(ctx, "fixture"));
          const funding = await ctx.gh.rest.repos.getContent({ ...splitRepository(CLIENT), path: ".github/FUNDING.yml", ref: head, mediaType: { format: "raw" } });
          const fundingContent: unknown = funding.data;
          assert(fundingContent === 'github: ["civitaspo"]\n', `incorrect generated funding content (${first.url})`);
          const repeat = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds, targets });
          const repeated = await openManagedPull(ctx.gh);
          assert(await managedBranchHead(ctx.gh) === head && repeated.length === 1 && repeated[0]?.number === pulls[0]?.number, `funding replay changed its PR or head (${repeat.url})`);
          for (const step of ["Apply repository settings", "Apply managed files"]) assert(repeat.stepConclusions.get(step) === "skipped", `funding repeat did not skip ${step} (${repeat.url})`);
          await assertManagedMetadata(ctx.gh, CLIENT, ownedNumber);
          await annotatePr(ctx.gh, CLIENT, ownedNumber, ctx.run, prCase(ctx, "fixture"));
          if (targets === "managed-files") {
            assert(first.stepConclusions.get("Mint administration write token") === "skipped", `funding-only minted an administration token (${first.url})`);
          }
        });
      }, [
        () => cleanupManagedState(ctx, undefined, undefined, CLIENT, ["e2e/repo-settings-managed.txt", ".github/FUNDING.yml"]),
        () => restoreRepository(ctx.gh, CLIENT, snapshot, createdRulesetIds),
        async () => {
          const live = await sponsorState(ctx.gh);
          if (live.hasSponsorshipsEnabled !== sponsorship.hasSponsorshipsEnabled) await ctx.gh.graphql("mutation($id:ID!,$enabled:Boolean!){updateRepository(input:{repositoryId:$id,hasSponsorshipsEnabled:$enabled}){repository{id}}}", { id: sponsorship.id, enabled: sponsorship.hasSponsorshipsEnabled });
          assert((await sponsorState(ctx.gh)).hasSponsorshipsEnabled === sponsorship.hasSponsorshipsEnabled, "Sponsor button setting was not restored");
        },
      ]);
    },
  })),
  {
    id: "repo-settings.managed-auto-completion",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "validated managed files are approved and merged through csm-ci",
        classification: "positive",
        checks: ["repository-settings", "branch-ownership", "approval-policy", "required-checks"],
        steps: [{
          operation: "repo-settings",
          outcome: "permitted",
          expected: "With auto_merge_managed_files enabled, a base change invalidates the old reservation, reconciliation rebuilds the managed PR from the new default head, and the freshly approved PR merges through csm-ci without changing rulesets",
        }],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Approval identity: testing-csm-ci-approver[bot] (ID 347401524). The Server App creates the managed reservation and performs the protected squash merge.",
          "Request producer: the owner-triggered fixture workflow. The scenario temporarily enables auto_merge_managed_files in the trusted Server configuration.",
        ],
      },
    },
    name: "validated managed files are approved and merged through csm-ci",
    serial: true,
    run: async (ctx) => {
      await ensureNoPreviousManagedState(ctx);
      const snapshot = await snapshotRepository(ctx.gh, CLIENT);
      const createdRulesetIds = new Set<number>();
      const driftPath = "e2e/repo-settings-managed-drift.txt";
      const driftFile = await clientMainFile(ctx, driftPath);
      const startedAt = new Date(Date.now() - 2_000);
      const drainManagedWorkflows = onceAsync(() => drainWorkflowRuns(ctx.gh, startedAt, { timeoutMs: 30 * 60_000 }));
      let observedPull: ManagedCompletionPull | undefined;
      let releaseManagedMergeGate: (() => Promise<void>) | undefined;
      let completed = false;
      await withServerConfig(ctx, (text) => {
        return enableManagedFileAutoCompletion(text, driftPath);
      }, async () => withCleanup(async () => {
        releaseManagedMergeGate = await createManagedMergeGate(ctx);
        // The required check keeps the PR open until its first reservation is observable.
        await driftFile.write("managed by csm-ci e2e\n");
        const initial = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { targets: "managed-files", createdRulesetIds, expectedConclusion: "failure" });
        assert(initial.stepConclusions.get("Apply managed files") === "success", `managed-files stage did not complete (${initial.url})`);
        observedPull = await until("automatic managed-files pull request", async () => {
          const pulls = await recentManagedPulls(ctx, startedAt);
          return pulls.length === 1 ? pulls[0] : undefined;
        });
        assert(observedPull, `automatic managed-files pull request was not created (${initial.url})`);
        assert(Number(observedPull.authorId) === SERVER_BOT_ID && observedPull.headRef === BRANCH && observedPull.baseRef === "main", "managed PR identity or branch does not match the configured target");
        const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: observedPull.number });
        assert(!pull.draft && pull.head.sha === observedPull.headSha, "managed pull request is draft or its observed head changed");
        const initialFiles = await ctx.gh.paginate(ctx.gh.rest.pulls.listFiles, { ...splitRepository(CLIENT), pull_number: observedPull.number, per_page: 100 });
        assert(!initialFiles.some((file) => file.filename === driftPath), "the second managed path unexpectedly appears in the approved PR diff");
        const { data: commit } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(CLIENT), ref: observedPull.headSha });
        assert(commit.author?.id === SERVER_BOT_ID && commit.commit.verification?.verified === true && commit.commit.verification.reason === "valid", "managed proposal is not a verified Server Bot commit");
        const content = await readFileAtRef(ctx.gh, splitRepository(CLIENT).owner, splitRepository(CLIENT).repo, "e2e/repo-settings-managed.txt", observedPull.headSha);
        assert(content.content === "managed by csm-ci e2e\n", "managed proposal does not contain the expected Server-source bytes");

        await until("head-bound Approver App review", async () => {
          const current = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { ...splitRepository(CLIENT), pull_number: observedPull!.number, per_page: 100 });
          return current.some((review) => review.user?.id === 347401524 && review.state === "APPROVED" && review.commit_id === observedPull!.headSha) ? true : undefined;
        });
        const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { ...splitRepository(CLIENT), pull_number: observedPull.number, per_page: 100 });
        assert(!reviews.some((review) => Number(review.user?.id) === SERVER_BOT_ID && review.state === "APPROVED" && review.commit_id === observedPull!.headSha), "Server Bot self-approved the managed PR");

        const policy = await until("successful policy check for managed PR head", async () => {
          const checks = await ctx.gh.paginate(ctx.gh.rest.checks.listForRef, { ...splitRepository(CLIENT), ref: observedPull!.headSha, per_page: 100 });
          return checks.find((check) => check.name === "csm-ci/policy" && check.external_id === observedPull!.headSha && check.status === "completed");
        });
        assert(policy.conclusion === "success" && Number(policy.app?.id) === 5455185, "managed PR policy check did not succeed under the Server App");

        const reservation = await until("managed-file reservation", async () => managedReservation(ctx, observedPull!.number));
        assert(reservation.state === "active", "managed reservation did not remain active behind the pending main-branch gate");
        assert(reservation.payload.accepted_head === observedPull.headSha, "managed reservation is not pinned to the observed PR head");
        assert(reservation.payload.repository === CLIENT && reservation.payload.base_ref === "main" && reservation.payload.managed_ref === BRANCH, "managed reservation has the wrong repository or refs");
        const { data: serverMain } = await ctx.gh.rest.git.getRef({ ...splitRepository(SERVER), ref: "heads/main" });
        assert(reservation.payload.configuration_sha === serverMain.object.sha, "managed reservation does not pin the enabled Server configuration revision");
        const { data: heldPull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: observedPull.number });
        assert(!heldPull.merged, "managed pull request merged despite the pending main-branch gate");

        await driftFile.write("drift introduced after the managed reservation was accepted\n");
        const { data: driftedBase } = await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: "heads/main" });
        const reconciled = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { targets: "managed-files", createdRulesetIds, expectedConclusion: "failure" });
        assert(reconciled.stepConclusions.get("Apply managed files") === "success", `managed-files retry did not complete after base drift (${reconciled.url})`);
        const replacement = await until("old reservation invalidated and a fresh reservation accepted", async () => {
          const current = await managedReservations(ctx, observedPull!.number);
          const prior = current.find((item) => item.id === reservation.id);
          const next = current.find((item) => item.id !== reservation.id && item.state === "active");
          return prior?.state === "inactive" && next ? { prior, next } : undefined;
        });
        assert(replacement.prior.state === "inactive", "base drift did not invalidate the prior managed reservation");
        assert(replacement.next.payload.accepted_base === driftedBase.object.sha, "replacement reservation does not pin the updated default-branch head");
        const { data: refreshedPull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: observedPull.number });
        assert(!refreshedPull.merged && refreshedPull.head.sha !== observedPull.headSha, "reconciliation did not update the managed pull request from the new base");
        assert(replacement.next.payload.accepted_head === refreshedPull.head.sha, "replacement reservation does not pin the reconciled PR head");
        await until("head-bound Approver App review for the reconciled head", async () => {
          const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { ...splitRepository(CLIENT), pull_number: observedPull!.number, per_page: 100 });
          return reviews.some((review) => review.user?.id === 347401524 && review.state === "APPROVED" && review.commit_id === refreshedPull.head.sha) ? true : undefined;
        });
        const refreshedPolicy = await until("successful policy check for reconciled managed PR head", async () => {
          const checks = await ctx.gh.paginate(ctx.gh.rest.checks.listForRef, { ...splitRepository(CLIENT), ref: refreshedPull.head.sha, per_page: 100 });
          return checks.find((check) => check.name === "csm-ci/policy" && check.external_id === refreshedPull.head.sha && check.status === "completed");
        });
        assert(refreshedPolicy.conclusion === "success" && Number(refreshedPolicy.app?.id) === 5455185, "reconciled managed PR policy check did not succeed under the Server App");
        await releaseManagedMergeGate();

        const sweep = await dispatch(ctx, SERVER, "csm-ci-automerge.yml");
        assert(sweep.conclusion === "success", `managed reservation sweep concluded ${sweep.conclusion} (${sweep.html_url})`);
        const merged = await until("managed pull request to merge", async () => {
          const { data: current } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: observedPull!.number });
          return current.merged ? current : undefined;
        });
        assert(merged.merge_commit_sha, "managed pull request has no squash merge SHA");
        const mergedContent = await readFileAtRef(ctx.gh, splitRepository(CLIENT).owner, splitRepository(CLIENT).repo, "e2e/repo-settings-managed.txt", merged.merge_commit_sha);
        assert(mergedContent.content === "managed by csm-ci e2e\n", "merged commit does not contain the expected managed bytes");
        const mergedDrift = await readFileAtRef(ctx.gh, splitRepository(CLIENT).owner, splitRepository(CLIENT).repo, driftPath, merged.merge_commit_sha);
        assert(mergedDrift.content === "managed by csm-ci e2e\n", "the replacement managed merge did not restore the desired bytes after base drift");
        assert(await managedBranchHead(ctx.gh, CLIENT) === undefined, "the managed branch remains after its pull request merged");
        const after = await snapshotRepository(ctx.gh, CLIENT, "observed");
        assert(isDeepStrictEqual(normalizeRuleSets(after.rulesets), normalizeRuleSets(snapshot.rulesets)), "automatic managed completion changed repository rulesets or bypass actors");
        completed = true;
        await annotatePr(ctx.gh, CLIENT, observedPull.number, ctx.run, prCase(ctx, "fixture"));
      }, [async () => {
        if (!completed) {
          // A failed or timed-out dispatch can leave a server workflow operating on this branch.
          // Do not close/delete its PR or restore its inputs until all workflows in the test window
          // have finished; if drain cannot prove that, retain the e2e lock and test state for review.
          await drainManagedWorkflows();
        }
        const failures: unknown[] = [];
        for (const cleanup of [
          async () => {
            if (!completed) {
              const head = await managedBranchHead(ctx.gh, CLIENT);
              if (head) await cleanupManagedState(ctx, head, observedPull ? { number: observedPull.number, headSha: observedPull.headSha } : undefined, CLIENT, ["e2e/repo-settings-managed.txt", driftPath]);
            }
          },
          driftFile.restore,
          async () => { if (releaseManagedMergeGate) await releaseManagedMergeGate(); },
          () => restoreRepository(ctx.gh, CLIENT, snapshot, createdRulesetIds),
        ]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "managed auto-completion cleanup failed");
      }]), async () => drainManagedWorkflows());
    },
  },
  {
    id: "repo-settings.reconciliation",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "dispatch repairs settings and ruleset drift, managed files create one stable PR, and schedule preserves the disabled stop",
        classification: "positive",
        checks: [
          "repository-settings",
          "branch-ownership",
          "replay"
        ],
        steps: [
          {
            "operation": "repo-settings",
            "outcome": "permitted",
            "expected": "Dispatch repairs settings and managed files; repeat preserves the PR and schedule preserves the disabled stop"
          }
        ],
        identity: [
          "PR author and effective generated commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow. The Server App writes only the configured managed branch and paths."
        ]
      },
      "server-bootstrap": {
        id: "server-bootstrap",
        target: "server",
        title: "Managed-files-only bootstrap PR for the testing server",
        classification: "mixed",
        checks: [
          "repository-settings",
          "branch-ownership",
          "replay"
        ],
        steps: [
          {
            operation: "repo-settings",
            outcome: "permitted",
            expected: "Managed-files-only creates one server managed-file PR; repeating preserves its PR and head without minting administration credentials"
          },
          {
            operation: "repo-settings",
            outcome: "rejected",
            expected: "Later normal dispatch rejects the missing caller before writes"
          }
        ],
        identity: [
          "PR author and effective commit identity: testing-csm-ci-server[bot] (ID 347400474).",
          "Request producer: the owner-triggered fixture workflow; this PR manages only e2e/repo-settings-managed.txt; server callers remain undistributed."
        ]
      }
    },
    name: "dispatch repairs settings and ruleset drift, managed files create one stable PR, and schedule preserves the disabled stop",
    serial: true,
    run: async (ctx) => {
      await ensureNoPreviousManagedState(ctx);
      const snapshot = await snapshotRepository(ctx.gh, CLIENT);
      const createdRulesetIds = new Set<number>();
      const managedFile = await clientMainFile(ctx, "e2e/repo-settings-managed.txt");
      let observedHead: string | undefined;
      let managedPull: ManagedPull | undefined;
      await withCleanup(async () => {
        // An earlier managed merge can leave the client in sync, so the scenario creates its own managed-file drift
        // while the snapshot rulesets still allow the harness to write main.
        await managedFile.write("drift before managed-files reconciliation\n");
        await makeSettingsDrift(ctx);
        const initial = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
        assert(initial.reconcileLog.includes('"dependabotSecurityUpdatesUpdated":1'), `client dispatch did not disable Dependabot security updates (${initial.url})`);
        assert(initial.stepConclusions.get("Mint approver contents token") === "success", `client dispatch did not verify the Approver App installation (${initial.url})`);
        assert((await listManagedRulesets(ctx.gh)).find((ruleset) => ruleset.name === "controlled-merges")?.enforcement === "active", "controlled-merges was not active before the schedule stop test");
        await assertSettingsReconciled(ctx);
        observedHead = await until(`managed ${BRANCH} branch in ${CLIENT}`, async () => await managedBranchHead(ctx.gh));
        const pulls = await until(`managed-files pull request in ${CLIENT}`, async () => {
          const found = await openManagedPull(ctx.gh);
          return found.length === 1 ? found : undefined;
        });
        managedPull = pulls[0];
        assert(managedPull, "managed-files pull request was not created");
        const { data: createdPull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: managedPull.number });
        const { data: createdCommit } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(CLIENT), ref: observedHead });
        assert(createdPull.title === MANAGED_FILES_TITLE && createdCommit.commit.message.split("\n")[0] === MANAGED_FILES_TITLE, `managed-files pull request or commit subject is not ${MANAGED_FILES_TITLE} (${initial.url})`);
        const owned = await ownedManagedHead(ctx);
        ownedAnnotationNumber(owned, managedPull.number);
        await labelPr(ctx.gh, CLIENT, managedPull.number, ctx.run, prCase(ctx, "fixture"));

        const { data: generatedCommit } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(CLIENT), ref: observedHead });
        const expectedCallers = ["approve", "policy-check", "merge", "release", "release-pr"].map((name) => `.github/workflows/csm-ci-${name}.yml`).sort();
        const { data: managedPullInfo } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: managedPull.number });
        const release = /Standard client workflows: (v\S+) \(([a-f0-9]{40})\)\./u.exec(managedPullInfo.body ?? "");
        assert(release, "managed-files pull request does not name the standard client workflows release");
        assert(generatedCommit.commit.message === MANAGED_FILES_TITLE, "managed commit carries more than the managed-files subject");
        for (const path of expectedCallers) {
          const content = await readFileAtRef(ctx.gh, splitRepository(CLIENT).owner, splitRepository(CLIENT).repo, path, observedHead);
          assert(content.content !== null && content.content.startsWith(`${GENERATED_HEADER}${release[1]} (${release[2]}).\n`) && content.content.includes(`@${release[2]}`), `generated workflow ${path} has inconsistent released revision`);
          assert(content.content.includes("CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}"), `generated workflow ${path} does not use the minimal named secret map`);
        }

        const beforeRepeat = await rulesetUpdateTimes(ctx.gh);
        const repeat = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
        assert(await managedBranchHead(ctx.gh) === observedHead, "the repeated run changed the managed-files branch head");
        const repeatedPulls = await openManagedPull(ctx.gh);
        assert(repeatedPulls.length === 1 && repeatedPulls[0]?.number === managedPull.number && repeatedPulls[0]?.headSha === managedPull.headSha, "the repeated run did not preserve the existing managed-files pull request head");
        await assertRepositorySettings(ctx, CLIENT);
        const afterRepeat = await rulesetUpdateTimes(ctx.gh);
        assert(JSON.stringify([...afterRepeat].sort(([a], [b]) => a - b)) === JSON.stringify([...beforeRepeat].sort(([a], [b]) => a - b)), "the repeated run updated a ruleset");
        for (const name of ["Apply repository settings", "Apply managed files", "Mint approver contents token", "Mint managed contents token", "Mint managed workflows token"]) {
          assert(repeat.stepConclusions.get(name) === "skipped", `the repeated run did not skip ${name} (${repeat.url})`);
        }

        const { data: managedContent } = await ctx.gh.rest.repos.getContent({ ...splitRepository(CLIENT), path: "e2e/repo-settings-managed.txt", ref: observedHead });
        assert(!Array.isArray(managedContent) && managedContent.type === "file" && Buffer.from(managedContent.content, "base64").toString("utf8") === "managed by csm-ci e2e\n", "Server-source managed file bytes differ");

        await withServerConfig(ctx, (text) => {
          const changed = text.replace("    has_wiki: false\n    has_projects: false\n    allow_update_branch: true\n    dependabot_security_updates: false\n", "");
          assert(changed !== text, "could not omit feature settings for the unmanaged settings scenario");
          return changed;
        }, async () => {
          await ctx.gh.rest.repos.update({ ...splitRepository(CLIENT), has_wiki: true, has_projects: true, allow_update_branch: false });
          await setDependabotSecurityUpdates(ctx.gh, CLIENT, true);
          const omitted = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
          assert(omitted.stepConclusions.get("Apply repository settings") === "skipped", `omitted feature settings caused a settings write (${omitted.url})`);
          const { data } = await ctx.gh.rest.repos.get(splitRepository(CLIENT));
          assert(data.has_wiki === true && data.has_projects === true && data.allow_update_branch === false, "omitted feature settings were changed");
          assert(await dependabotSecurityUpdatesState(ctx.gh, CLIENT), `omitted dependabot_security_updates was changed (${omitted.url})`);
        });
        await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: managedPull.number, title: "Sync managed files" });
        const retitled = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
        await assertRepositorySettings(ctx, CLIENT);
        const { data: refreshedPull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: managedPull.number });
        assert(refreshedPull.title === MANAGED_FILES_TITLE && refreshedPull.head.sha === observedHead && await managedBranchHead(ctx.gh) === observedHead, `legacy managed-files title was not refreshed in place (${retitled.url})`);

        await withServerConfig(ctx, (text) => {
          const changed = text.replace("    allow_squash_merge: true\n", "");
          assert(changed !== text, "could not omit allow_squash_merge for the unmanaged settings scenario");
          return changed;
        }, async () => {
          await ctx.gh.rest.repos.update({ ...splitRepository(CLIENT), ...UNMANAGED_SQUASH_SETTINGS });
          const omitted = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
          assert(omitted.stepConclusions.get("Apply repository settings") === "skipped", `omitted squash setting caused a settings write (${omitted.url})`);
          assert(omitted.stepConclusions.get("Apply managed files") === "skipped", `the run after the title refresh updated managed files (${omitted.url})`);
          const { data } = await ctx.gh.rest.repos.get(splitRepository(CLIENT));
          assert(data.allow_squash_merge === true && data.squash_merge_commit_title === UNMANAGED_SQUASH_SETTINGS.squash_merge_commit_title && data.squash_merge_commit_message === UNMANAGED_SQUASH_SETTINGS.squash_merge_commit_message, "omitted squash setting changed the squash commit format");
        });
        await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
        await assertRepositorySettings(ctx, CLIENT);

        await disableControlledMerges(ctx);
        await dispatchReconciliation(ctx, CLIENT, "schedule", undefined, { createdRulesetIds });
        await assertRepositorySettings(ctx, CLIENT);
        await assertControlledMergesDisabled(ctx);
        await assertManagedMetadata(ctx.gh, CLIENT, managedPull.number);
        await annotatePr(ctx.gh, CLIENT, managedPull.number, ctx.run, prCase(ctx, "fixture"));
      }, [
        () => cleanupManagedState(ctx, observedHead, managedPull),
        () => restoreRepository(ctx.gh, CLIENT, snapshot, createdRulesetIds),
        // Reconciled rulesets block direct writes to main, so restore the file after the snapshot rulesets.
        managedFile.restore,
      ]);

      const serverSnapshot = await snapshotRepository(ctx.gh, SERVER);
      const serverCreatedRulesetIds = new Set<number>();
      assert(await managedBranchHead(ctx.gh, SERVER) === undefined, `ref ${BRANCH} already exists in ${SERVER}; refusing to reuse it`);
      assert((await openManagedPull(ctx.gh, SERVER)).length === 0, `an open managed-files pull request already exists in ${SERVER}`);
      await withServerConfig(ctx, (text) => {
        const changed = text.replace('  additional_managed_files:\n    e2e/repo-settings-managed.txt: managed-files/repo-settings-managed.txt', "  additional_managed_files: {}");
        assert(changed !== text, "could not set additional_managed_files to empty for the server schedule scenario");
        return changed;
      }, async () => {
        await withCleanup(async () => {
          const originalControlled = serverSnapshot.rulesets.find((ruleset) => ruleset.name === "controlled-merges");
          const serverSchedule = await dispatchReconciliation(ctx, SERVER, "schedule", undefined, { createdRulesetIds: serverCreatedRulesetIds });
          assert(serverSchedule.stepConclusions.get("Mint approver contents token") === "skipped", `server schedule tried to mint an Approver App token (${serverSchedule.url})`);
          await assertRepositorySettings(ctx, SERVER);
          assert(await dependabotSecurityUpdatesState(ctx.gh, SERVER) === false, `server schedule did not disable Dependabot security updates (${serverSchedule.url})`);
          for (const name of ["integrity", "review-and-checks", "release-tags"]) {
            const rulesets = await listManagedRulesets(ctx.gh, SERVER);
            const named = rulesets.filter((ruleset) => ruleset.name === name);
            assert(named.length === 1 && named[0]?.enforcement === "active", `server schedule did not reconcile ${name}`);
          }
          const controlledAfter = (await listManagedRulesets(ctx.gh, SERVER)).find((ruleset) => ruleset.name === "controlled-merges");
          assert(controlledAfter?.enforcement === originalControlled?.enforcement, "server schedule created or changed controlled-merges");
          assert(await managedBranchHead(ctx.gh, SERVER) === undefined, `empty additional_managed_files created ${BRANCH} in ${SERVER}`);
          assert(await immutableReleaseState(ctx.gh, SERVER), `server schedule did not enable immutable releases in ${SERVER}`);
        }, [() => restoreRepository(ctx.gh, SERVER, serverSnapshot, serverCreatedRulesetIds)]);
      });

      // Restoration verified this snapshot; a fresh read can still return the preceding reconciled settings.
      const bootstrapSnapshot = serverSnapshot;
      const bootstrapCreatedRulesetIds = new Set<number>();
      await ensureNoPreviousManagedState(ctx, SERVER);
      await withCleanup(async () => {
        const preflight = await inspectRepoSettingsPreflight({ readGH: ctx.gh, target: { name: SERVER, isServer: true } });
        assert(!preflight.callerDistributed, "the server caller workflows are already distributed in " + SERVER + "; bootstrap precondition changed");
        assert(!bootstrapSnapshot.rulesets.some((ruleset) => ruleset.name === "controlled-merges"), "controlled-merges already exists in " + SERVER + "; bootstrap precondition changed");

        const first = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          targets: "managed-files",
          createdRulesetIds: bootstrapCreatedRulesetIds,
        });
        assert(first.stepConclusions.get("Mint administration write token") === "skipped", "targets managed-files minted an administration token (" + first.url + ")");
        assert(first.stepConclusions.get("Mint approver contents token") === "skipped", "targets managed-files minted an approver token (" + first.url + ")");
        assert(first.stepConclusions.get("Apply repository settings") === "skipped", "targets managed-files applied repository settings (" + first.url + ")");
        assert(first.stepConclusions.get("Apply managed files") === "success", "targets managed-files did not apply managed files (" + first.url + ")");
        const bootstrapHead = await until("managed " + BRANCH + " branch in " + SERVER, async () => await managedBranchHead(ctx.gh, SERVER));
        const bootstrapPulls = await until("managed-files pull request in " + SERVER, async () => {
          const found = await openManagedPull(ctx.gh, SERVER);
          return found.length === 1 ? found : undefined;
        });
        const bootstrapPull = bootstrapPulls[0];
        assert(bootstrapPull?.headSha === bootstrapHead, "targets managed-files pull request head does not match its branch (" + first.url + ")");

        const bootstrapOwned = await ownedManagedHead(ctx, SERVER);
        ownedAnnotationNumber(bootstrapOwned, bootstrapPull.number);
        await labelPr(ctx.gh, SERVER, bootstrapPull.number, ctx.run, prCase(ctx, "server-bootstrap"));
        const second = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          targets: "managed-files",
          createdRulesetIds: bootstrapCreatedRulesetIds,
        });
        assert(await managedBranchHead(ctx.gh, SERVER) === bootstrapHead, "repeated targets managed-files changed the branch head (" + second.url + ")");
        const repeatedPulls = await openManagedPull(ctx.gh, SERVER);
        assert(repeatedPulls.length === 1 && repeatedPulls[0]?.number === bootstrapPull.number && repeatedPulls[0]?.headSha === bootstrapHead, "repeated targets managed-files did not preserve its pull request (" + second.url + ")");
        for (const name of ["Mint administration write token", "Mint approver contents token", "Apply repository settings", "Apply managed files"]) {
          assert(second.stepConclusions.get(name) === "skipped", "repeated targets managed-files did not skip " + name + " (" + second.url + ")");
        }

        await assertManagedMetadata(ctx.gh, SERVER, bootstrapPull.number);
        await annotatePr(ctx.gh, SERVER, bootstrapPull.number, ctx.run, prCase(ctx, "server-bootstrap"));
        const normal = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          createdRulesetIds: bootstrapCreatedRulesetIds,
          expectedConclusion: "failure",
        });
        assert(normal.reconcileLog.includes("caller workflow is not distributed on " + SERVER), "normal dispatch did not reject the missing caller before writes (" + normal.url + ")");
        assert(normal.stepConclusions.get("Apply repository settings") === "skipped", "normal dispatch applied repository settings before rejecting the caller (" + normal.url + ")");
        assert(await managedBranchHead(ctx.gh, SERVER) === bootstrapHead, "normal dispatch changed the managed branch after caller rejection (" + normal.url + ")");
        const after = await snapshotRepository(ctx.gh, SERVER, "observed");
        assert(isDeepStrictEqual(after.settings, bootstrapSnapshot.settings)
          && after.immutableReleases === bootstrapSnapshot.immutableReleases
          && after.dependabotSecurityUpdates === bootstrapSnapshot.dependabotSecurityUpdates
          && isDeepStrictEqual(normalizeRuleSets(after.rulesets), normalizeRuleSets(bootstrapSnapshot.rulesets)),
        "targets managed-files or rejected normal dispatch changed server administration state (" + normal.url + ")");
      }, [
        () => cleanupManagedState(ctx, undefined, undefined, SERVER),
        () => restoreRepository(ctx.gh, SERVER, bootstrapSnapshot, bootstrapCreatedRulesetIds),
      ]);
    },
  },
];
