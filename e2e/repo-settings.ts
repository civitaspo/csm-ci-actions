import { z } from "zod";
import { type GitHub, splitRepository } from "../src/lib/github.ts";
import { inspectRepoSettingsPreflight } from "../src/lib/repo-settings.ts";
import { assert, CLIENT, dispatch, hasStatus, jobLog, SERVER, SERVER_BOT_ID, type Ctx, type Scenario, until, withServerConfig } from "./harness.ts";
import { withCleanup } from "./cleanup.ts";
import { parseCreatedRulesets, rulesetCleanupPlan } from "./repo-settings-ownership.ts";

const BRANCH = "csm-ci/repo-settings";
const MANAGED_MARKER = "<!-- csm-ci:repo-settings:managed-files -->";
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
type RepoSnapshot = { settings: SettingsSnapshot; rulesets: RuleSet[]; immutableReleases: boolean };
type ManagedPull = { number: number; headSha: string };

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
  const [{ data: repositoryInfo }, rawRulesets, immutableReleases] = await Promise.all([
    gh.rest.repos.get(address),
    gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 }),
    immutableReleaseState(gh, repository),
  ]);
  const settings = SettingsSnapshotSchema.parse(repositoryInfo);
  const rulesets = await listManagedRulesets(gh, repository, rawRulesets);
  const snapshot = { settings, rulesets, immutableReleases };
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
  let restored: RepoSnapshot | undefined;
  await attempt(async () => { restored = await snapshotRepository(gh, repository, "restored"); });
  if (failures.length > 0) throw new AggregateError(failures, `restoring ${repository} failed in ${failures.length} step(s)`);
  assert(restored, `could not read restored repository state for ${repository}`);
  assert(JSON.stringify(restored.settings) === JSON.stringify(snapshot.settings), `repository settings were not restored for ${repository}`);
  assert(restored.immutableReleases === snapshot.immutableReleases, `immutable releases were not restored for ${repository}`);
  assert(JSON.stringify(normalizeRuleSets(restored.rulesets)) === JSON.stringify(normalizeRuleSets(snapshot.rulesets)), `rulesets were not restored for ${repository}`);
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

async function ownedManagedHead(ctx: Ctx, repository = CLIENT): Promise<{ sha: string; pull?: ManagedPull } | undefined> {
  const sha = await managedBranchHead(ctx.gh, repository);
  if (!sha) return undefined;
  const { data: commit } = await ctx.gh.rest.repos.getCommit({ ...splitRepository(repository), ref: sha });
  const changedPaths = commit.files?.map((file) => file.filename) ?? [];
  if (commit.author?.id !== SERVER_BOT_ID || commit.commit.message !== "Sync managed files" || changedPaths.length !== 1 || changedPaths[0] !== "e2e/repo-settings-managed.txt") return undefined;
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
  options: { operationMode?: "reconcile" | "managed-files-only"; createdRulesetIds?: Set<number>; expectedConclusion?: "success" | "failure" } = {},
): Promise<{ id: number; url: string; stepConclusions: Map<string, string | null>; reconcileLog: string }> {
  const operationMode = options.operationMode ?? "reconcile";
  const expectedConclusion = options.expectedConclusion ?? "success";
  const run = await dispatch(ctx, SERVER, "csm-ci-repo-settings.yml", {
    repository,
    "event-mode": eventMode,
    mode: operationMode,
    ...(configPath ? { "config-path": configPath } : {}),
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

async function cleanupManagedState(ctx: Ctx, observedHead: string | undefined, pull: ManagedPull | undefined, repository = CLIENT): Promise<void> {
  const owned = await ownedManagedHead(ctx, repository);
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

async function makeSettingsDrift(ctx: Ctx): Promise<void> {
  const address = splitRepository(CLIENT);
  const desired = {
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
  await ctx.gh.rest.repos.update({ ...address, delete_branch_on_merge: !desired.delete_branch_on_merge, allow_auto_merge: !desired.allow_auto_merge, allow_squash_merge: true, squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "COMMIT_MESSAGES" });
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
  const rulesets = await listManagedRulesets(ctx.gh, repository);
  for (const name of RULESET_NAMES) {
    const named = rulesets.filter((ruleset) => ruleset.name === name);
    assert(named.length === 1, `expected exactly one Repository ruleset named ${name}, found ${named.length}`);
    if (name !== "controlled-merges") assert(named[0]?.enforcement === "active", `${name} is not active after dispatch reconciliation`);
  }
}

async function assertRepositorySettings(ctx: Ctx, repository: string): Promise<void> {
  const { data } = await ctx.gh.rest.repos.get(splitRepository(repository));
  assert(data.delete_branch_on_merge === true, "delete_branch_on_merge drift was not repaired");
  assert(data.allow_auto_merge === true, "allow_auto_merge drift was not repaired");
  assert(data.allow_squash_merge === true, "allow_squash_merge was not reconciled");
  assert(data.squash_merge_commit_title === "PR_TITLE", "squash_merge_commit_title drift was not repaired");
  assert(data.squash_merge_commit_message === "PR_BODY", "squash_merge_commit_message drift was not repaired");
  assert(data.allow_merge_commit === false, "allow_merge_commit was not reconciled");
  assert(data.allow_rebase_merge === false, "allow_rebase_merge was not reconciled");
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

export const repoSettings: Scenario[] = [
  {
    name: "dispatch repairs settings and ruleset drift, managed files create one stable PR, and schedule preserves the disabled stop",
    serial: true,
    run: async (ctx) => {
      await ensureNoPreviousManagedState(ctx);
      const snapshot = await snapshotRepository(ctx.gh, CLIENT);
      const createdRulesetIds = new Set<number>();
      let observedHead: string | undefined;
      let managedPull: ManagedPull | undefined;
      await withCleanup(async () => {
        await makeSettingsDrift(ctx);
        const initial = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
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

        await withServerConfig(ctx, (text) => {
          const changed = text.replace("    allow_squash_merge: true\n", "");
          assert(changed !== text, "could not omit allow_squash_merge for the unmanaged settings scenario");
          return changed;
        }, async () => {
          await ctx.gh.rest.repos.update({ ...splitRepository(CLIENT), ...UNMANAGED_SQUASH_SETTINGS });
          const omitted = await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
          assert(omitted.stepConclusions.get("Apply repository settings") === "skipped", `omitted squash setting caused a settings write (${omitted.url})`);
          const { data } = await ctx.gh.rest.repos.get(splitRepository(CLIENT));
          assert(data.allow_squash_merge === true && data.squash_merge_commit_title === UNMANAGED_SQUASH_SETTINGS.squash_merge_commit_title && data.squash_merge_commit_message === UNMANAGED_SQUASH_SETTINGS.squash_merge_commit_message, "omitted squash setting changed the squash commit format");
        });
        await dispatchReconciliation(ctx, CLIENT, "dispatch", undefined, { createdRulesetIds });
        await assertRepositorySettings(ctx, CLIENT);

        await disableControlledMerges(ctx);
        await dispatchReconciliation(ctx, CLIENT, "schedule", undefined, { createdRulesetIds });
        await assertControlledMergesDisabled(ctx);
      }, [
        () => cleanupManagedState(ctx, observedHead, managedPull),
        () => restoreRepository(ctx.gh, CLIENT, snapshot, createdRulesetIds),
      ]);

      const serverSnapshot = await snapshotRepository(ctx.gh, SERVER);
      const serverCreatedRulesetIds = new Set<number>();
      assert(await managedBranchHead(ctx.gh, SERVER) === undefined, `ref ${BRANCH} already exists in ${SERVER}; refusing to reuse it`);
      assert((await openManagedPull(ctx.gh, SERVER)).length === 0, `an open managed-files pull request already exists in ${SERVER}`);
      await withServerConfig(ctx, (text) => {
        const changed = text.replace('  managed_files:\n    e2e/repo-settings-managed.txt: "managed by csm-ci e2e\\n"', "  managed_files: {}");
        assert(changed !== text, "could not set managed_files to empty for the server schedule scenario");
        return changed;
      }, async () => {
        await withCleanup(async () => {
          const originalControlled = serverSnapshot.rulesets.find((ruleset) => ruleset.name === "controlled-merges");
          const serverSchedule = await dispatchReconciliation(ctx, SERVER, "schedule", undefined, { createdRulesetIds: serverCreatedRulesetIds });
          assert(serverSchedule.stepConclusions.get("Mint approver contents token") === "skipped", `server schedule tried to mint an Approver App token (${serverSchedule.url})`);
          await assertRepositorySettings(ctx, SERVER);
          for (const name of ["integrity", "review-and-checks", "release-tags"]) {
            const rulesets = await listManagedRulesets(ctx.gh, SERVER);
            const named = rulesets.filter((ruleset) => ruleset.name === name);
            assert(named.length === 1 && named[0]?.enforcement === "active", `server schedule did not reconcile ${name}`);
          }
          const controlledAfter = (await listManagedRulesets(ctx.gh, SERVER)).find((ruleset) => ruleset.name === "controlled-merges");
          assert(controlledAfter?.enforcement === originalControlled?.enforcement, "server schedule created or changed controlled-merges");
          assert(await managedBranchHead(ctx.gh, SERVER) === undefined, `empty managed_files created ${BRANCH} in ${SERVER}`);
          assert(await immutableReleaseState(ctx.gh, SERVER), `server schedule did not enable immutable releases in ${SERVER}`);
        }, [() => restoreRepository(ctx.gh, SERVER, serverSnapshot, serverCreatedRulesetIds)]);
      });

      const bootstrapSnapshot = await snapshotRepository(ctx.gh, SERVER);
      const bootstrapCreatedRulesetIds = new Set<number>();
      await ensureNoPreviousManagedState(ctx, SERVER);
      await withCleanup(async () => {
        const preflight = await inspectRepoSettingsPreflight({ readGH: ctx.gh, target: { name: SERVER, isServer: true } });
        assert(!preflight.callerDistributed, "the server caller workflows are already distributed in " + SERVER + "; bootstrap precondition changed");
        assert(!bootstrapSnapshot.rulesets.some((ruleset) => ruleset.name === "controlled-merges"), "controlled-merges already exists in " + SERVER + "; bootstrap precondition changed");

        const first = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          operationMode: "managed-files-only",
          createdRulesetIds: bootstrapCreatedRulesetIds,
        });
        assert(first.stepConclusions.get("Mint administration write token") === "skipped", "managed-files-only minted an administration token (" + first.url + ")");
        assert(first.stepConclusions.get("Mint approver contents token") === "skipped", "managed-files-only minted an approver token (" + first.url + ")");
        assert(first.stepConclusions.get("Apply repository settings") === "skipped", "managed-files-only applied repository settings (" + first.url + ")");
        assert(first.stepConclusions.get("Apply managed files") === "success", "managed-files-only did not apply managed files (" + first.url + ")");
        const bootstrapHead = await until("managed " + BRANCH + " branch in " + SERVER, async () => await managedBranchHead(ctx.gh, SERVER));
        const bootstrapPulls = await until("managed-files pull request in " + SERVER, async () => {
          const found = await openManagedPull(ctx.gh, SERVER);
          return found.length === 1 ? found : undefined;
        });
        const bootstrapPull = bootstrapPulls[0];
        assert(bootstrapPull?.headSha === bootstrapHead, "managed-files-only pull request head does not match its branch (" + first.url + ")");

        const second = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          operationMode: "managed-files-only",
          createdRulesetIds: bootstrapCreatedRulesetIds,
        });
        assert(await managedBranchHead(ctx.gh, SERVER) === bootstrapHead, "repeated managed-files-only changed the branch head (" + second.url + ")");
        const repeatedPulls = await openManagedPull(ctx.gh, SERVER);
        assert(repeatedPulls.length === 1 && repeatedPulls[0]?.number === bootstrapPull.number && repeatedPulls[0]?.headSha === bootstrapHead, "repeated managed-files-only did not preserve its pull request (" + second.url + ")");
        for (const name of ["Mint administration write token", "Mint approver contents token", "Apply repository settings", "Apply managed files"]) {
          assert(second.stepConclusions.get(name) === "skipped", "repeated managed-files-only did not skip " + name + " (" + second.url + ")");
        }

        const normal = await dispatchReconciliation(ctx, SERVER, "dispatch", undefined, {
          createdRulesetIds: bootstrapCreatedRulesetIds,
          expectedConclusion: "failure",
        });
        assert(normal.reconcileLog.includes("caller workflow is not distributed on " + SERVER), "normal dispatch did not reject the missing caller before writes (" + normal.url + ")");
        assert(normal.stepConclusions.get("Apply repository settings") === "skipped", "normal dispatch applied repository settings before rejecting the caller (" + normal.url + ")");
        assert(await managedBranchHead(ctx.gh, SERVER) === bootstrapHead, "normal dispatch changed the managed branch after caller rejection (" + normal.url + ")");
        const after = await snapshotRepository(ctx.gh, SERVER, "observed");
        assert(JSON.stringify(after.settings) === JSON.stringify(bootstrapSnapshot.settings)
          && after.immutableReleases === bootstrapSnapshot.immutableReleases
          && JSON.stringify(normalizeRuleSets(after.rulesets)) === JSON.stringify(normalizeRuleSets(bootstrapSnapshot.rulesets)),
        "managed-files-only or rejected normal dispatch changed server administration state (" + normal.url + ")");
      }, [
        () => cleanupManagedState(ctx, undefined, undefined, SERVER),
        () => restoreRepository(ctx.gh, SERVER, bootstrapSnapshot, bootstrapCreatedRulesetIds),
      ]);
    },
  },
];
