import { z } from "zod";
import { type GitHub, splitRepository } from "../src/lib/github.ts";
import { assert, CLIENT, dispatch, hasStatus, SERVER, SERVER_BOT_ID, type Ctx, type Scenario, until, withServerConfig } from "./harness.ts";

const BRANCH = "csm-ci/repo-settings";
const MANAGED_MARKER = "<!-- csm-ci:repo-settings:managed-files -->";
const RULESET_NAMES = new Set(["integrity", "review-and-checks", "controlled-merges", "release-tags"]);
const SETTINGS = ["delete_branch_on_merge", "allow_auto_merge", "allow_squash_merge", "allow_merge_commit", "allow_rebase_merge"] as const;

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
type SettingsSnapshot = { [K in (typeof SETTINGS)[number]]: boolean };
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

async function snapshotRepository(gh: GitHub, repository: string): Promise<RepoSnapshot> {
  const address = splitRepository(repository);
  const [{ data: repositoryInfo }, rawRulesets, immutableReleases] = await Promise.all([
    gh.rest.repos.get(address),
    gh.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 }),
    immutableReleaseState(gh, repository),
  ]);
  const settings = Object.fromEntries(SETTINGS.map((key) => [key, repositoryInfo[key] as boolean])) as SettingsSnapshot;
  const rulesets = await listManagedRulesets(gh, repository, rawRulesets);
  return { settings, rulesets, immutableReleases };
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
async function restoreRepository(gh: GitHub, repository: string, snapshot: RepoSnapshot): Promise<void> {
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
    for (const ruleset of await listManagedRulesets(gh, repository)) {
      if (!originalIds.has(ruleset.id)) await attempt(() => gh.rest.repos.deleteRepoRuleset({ ...address, ruleset_id: ruleset.id }));
    }
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
  await attempt(() => gh.rest.repos.update({ ...address, ...snapshot.settings } as Parameters<GitHub["rest"]["repos"]["update"]>[0]));
  if (!snapshot.immutableReleases) await attempt(() => gh.request("DELETE /repos/{owner}/{repo}/immutable-releases", address));
  if (failures.length > 0) throw new AggregateError(failures, `restoring ${repository} failed in ${failures.length} step(s)`);
  const restored = await snapshotRepository(gh, repository);
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

async function dispatchReconciliation(ctx: Ctx, repository: string, mode: "schedule" | "dispatch", configPath?: string): Promise<{ id: number; url: string; stepConclusions: Map<string, string | null> }> {
  const run = await dispatch(ctx, SERVER, "csm-ci-repo-settings.yml", { repository, "event-mode": mode, ...(configPath ? { "config-path": configPath } : {}) });
  assert(run.conclusion === "success", `repo-settings ${mode} run concluded ${run.conclusion} (${run.html_url})`);
  const namedJobs = await until(`repo-settings jobs for ${run.html_url}`, async () => {
    const result = await ctx.gh.rest.actions.listJobsForWorkflowRun({ ...splitRepository(SERVER), run_id: run.id });
    return result.data.jobs.length > 0 ? result.data.jobs : undefined;
  });
  assert(namedJobs.some((job) => job.name.includes("reconcile") && job.conclusion === "success"), `repo-settings reconcile job did not succeed (${run.html_url})`);
  const reconcileJob = namedJobs.find((job) => job.name.includes("reconcile"));
  const steps = reconcileJob?.steps ?? [];
  return {
    id: run.id,
    url: run.html_url,
    stepConclusions: new Map(steps.map((step) => [step.name, step.conclusion])),
  };
}

async function ensureNoPreviousManagedState(ctx: Ctx): Promise<void> {
  assert((await managedBranchHead(ctx.gh)) === undefined, `ref ${BRANCH} already exists in ${CLIENT}; refusing to reuse it`);
  assert((await openManagedPull(ctx.gh)).length === 0, `an open managed-files pull request already exists in ${CLIENT}`);
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
  await ctx.gh.rest.repos.update({ ...address, delete_branch_on_merge: !desired.delete_branch_on_merge, allow_auto_merge: !desired.allow_auto_merge });
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
  assert(data.allow_merge_commit === false, "allow_merge_commit was not reconciled");
  assert(data.allow_rebase_merge === false, "allow_rebase_merge was not reconciled");
}

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
    bypass_actors: ruleset.bypass_actors,
  });
}

async function assertControlledMergesDisabled(ctx: Ctx): Promise<void> {
  const ruleset = (await listManagedRulesets(ctx.gh)).find((item) => item.name === "controlled-merges");
  assert(ruleset?.enforcement === "disabled", `schedule reconciliation changed controlled-merges to ${ruleset?.enforcement ?? "missing"}`);
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
      let observedHead: string | undefined;
      let managedPull: ManagedPull | undefined;
      try {
        await makeSettingsDrift(ctx);
        const initial = await dispatchReconciliation(ctx, CLIENT, "dispatch");
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
        const repeat = await dispatchReconciliation(ctx, CLIENT, "dispatch");
        assert(await managedBranchHead(ctx.gh) === observedHead, "the repeated run changed the managed-files branch head");
        const repeatedPulls = await openManagedPull(ctx.gh);
        assert(repeatedPulls.length === 1 && repeatedPulls[0]?.number === managedPull.number && repeatedPulls[0]?.headSha === managedPull.headSha, "the repeated run did not preserve the existing managed-files pull request head");
        const afterRepeat = await rulesetUpdateTimes(ctx.gh);
        assert(JSON.stringify([...afterRepeat].sort(([a], [b]) => a - b)) === JSON.stringify([...beforeRepeat].sort(([a], [b]) => a - b)), "the repeated run updated a ruleset");
        for (const name of ["Apply repository settings", "Apply managed files", "Mint approver contents token", "Mint managed contents token", "Mint managed workflows token"]) {
          assert(repeat.stepConclusions.get(name) === "skipped", `the repeated run did not skip ${name} (${repeat.url})`);
        }

        await disableControlledMerges(ctx);
        await dispatchReconciliation(ctx, CLIENT, "schedule");
        await assertControlledMergesDisabled(ctx);
      } finally {
        try {
          await cleanupManagedState(ctx, observedHead, managedPull);
        } finally {
          await restoreRepository(ctx.gh, CLIENT, snapshot);
        }
      }

      const serverSnapshot = await snapshotRepository(ctx.gh, SERVER);
      assert(await managedBranchHead(ctx.gh, SERVER) === undefined, `ref ${BRANCH} already exists in ${SERVER}; refusing to reuse it`);
      assert((await openManagedPull(ctx.gh, SERVER)).length === 0, `an open managed-files pull request already exists in ${SERVER}`);
      await withServerConfig(ctx, (text) => {
        const changed = text.replace('  managed_files:\n    e2e/repo-settings-managed.txt: "managed by csm-ci e2e\\n"', "  managed_files: {}");
        assert(changed !== text, "could not set managed_files to empty for the server schedule scenario");
        return changed;
      }, async () => {
        try {
          const originalControlled = serverSnapshot.rulesets.find((ruleset) => ruleset.name === "controlled-merges");
          const serverSchedule = await dispatchReconciliation(ctx, SERVER, "schedule");
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
        } finally {
          await restoreRepository(ctx.gh, SERVER, serverSnapshot);
        }
      });
    },
  },
];
