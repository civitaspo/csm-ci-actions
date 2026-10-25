import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { type Config, type RepoSettingsConfig, repositoryEntry } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";
import { Rejection } from "./request.ts";

export type RepoSettingsMode = "schedule" | "dispatch";
export type RepoSettingsTarget = { name: string; isServer: boolean };
export type RepoSettingsTargets = { clients: RepoSettingsTarget[]; server: RepoSettingsTarget | null };

const InstalledRepository = z.object({ name: z.string().min(1), owner: z.object({ login: z.string().min(1) }) });

export function discoverRepoSettingsTargets(args: {
  config: Config;
  installedRepositories: unknown[];
  serverRepository: string;
  requestedRepository?: string;
  actionsRepository?: string;
}): RepoSettingsTargets {
  if (!args.config.repo_settings) throw new Rejection("repo_settings is not configured");
  const serverName = args.serverRepository.toLowerCase();
  const actionsRepository = (args.actionsRepository ?? "civitaspo/csm-ci-actions").toLowerCase();
  if (args.config.server_repository !== serverName) throw new Rejection("server repository does not match the pinned configuration");
  const installed = args.installedRepositories.map((value) => {
    const repository = InstalledRepository.parse(value);
    return `${repository.owner.login}/${repository.name}`.toLowerCase();
  });
  const installedNames = new Set(installed);
  if (!installedNames.has(serverName)) throw new Rejection(`server repository ${serverName} is not installed`);
  const candidates = [...new Set([...installedNames].filter((name) => name !== actionsRepository && repositoryEntry(args.config, name) !== undefined))];
  if (!candidates.includes(serverName)) throw new Rejection(`server repository ${serverName} is not configured`);

  if (args.requestedRepository !== undefined) {
    const requested = args.requestedRepository.toLowerCase();
    if (requested === actionsRepository || !repositoryEntry(args.config, requested) || !installedNames.has(requested)) {
      throw new Rejection(`requested repository ${requested} is not installed and configured`);
    }
    if (requested === serverName) return { clients: [], server: { name: serverName, isServer: true } };
    return { clients: [{ name: requested, isServer: false }], server: null };
  }

  const clients = candidates.filter((name) => name !== serverName).map((name) => ({ name, isServer: false }));
  return { clients, server: { name: serverName, isServer: true } };
}

export type DispatchPreflight = {
  callerDistributed: boolean;
  approverCanWrite: boolean;
  autoMergeQueueCount: number;
};

export async function inspectRepoSettingsPreflight(args: {
  readGH: GitHub;
  target: RepoSettingsTarget;
  actionsRepository?: string;
}): Promise<Pick<DispatchPreflight, "callerDistributed" | "autoMergeQueueCount">> {
  const actionsRepository = (args.actionsRepository ?? "civitaspo/csm-ci-actions").toLowerCase();
  const repo = await args.readGH.rest.repos.get(splitRepository(args.target.name));
  const callerDistributed = await hasDistributedCaller(args.readGH, args.target, repo.data.default_branch, actionsRepository);
  const autoMergeQueueCount = await countAutoMergeQueue(args.readGH, args.target.name);
  return { callerDistributed, autoMergeQueueCount };
}

export async function verifyRepoSettingsApprover(args: { readGH: GitHub; config: Config; approverAppSlug: string }): Promise<boolean> {
  if (!/^[A-Za-z0-9-]+$/u.test(args.approverAppSlug)) throw new Rejection("approver App slug is invalid");
  const bot = await args.readGH.rest.users.getByUsername({ username: `${args.approverAppSlug}[bot]` });
  return Number(bot.data.id) === args.config.approver.id && bot.data.login.toLowerCase() === args.config.approver.login.toLowerCase();
}

async function hasDistributedCaller(gh: GitHub, target: RepoSettingsTarget, defaultBranch: string, actionsRepository: string): Promise<boolean> {
  const address = splitRepository(target.name);
  let entries: unknown;
  try {
    ({ data: entries } = await gh.rest.repos.getContent({ ...address, path: ".github/workflows", ref: defaultBranch }));
  } catch (error) {
    if (status(error) === 404) return false;
    throw error;
  }
  const parsedEntries = z.array(z.object({ name: z.string(), type: z.string() })).safeParse(entries);
  if (!parsedEntries.success) return false;
  const files = parsedEntries.data.filter((entry) => entry.type === "file" && /\.ya?ml$/iu.test(entry.name));
  const requirements = target.isServer
    ? [{ workflow: "client-merge.yml", event: "issue_comment" }, { workflow: "server.yml", event: "label" }]
    : [{ workflow: "client-merge.yml", event: "issue_comment" }];
  const distributed = new Set<string>();
  for (const file of files) {
    const path = `.github/workflows/${file.name}`;
    let raw: unknown;
    try {
      ({ data: raw } = await gh.rest.repos.getContent({ ...address, path, ref: defaultBranch, mediaType: { format: "raw" } }));
    } catch (error) {
      if (status(error) === 404) continue;
      throw error;
    }
    if (typeof raw !== "string") continue;
    let workflow: unknown;
    try {
      workflow = parseYaml(raw);
    } catch {
      continue;
    }
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) continue;
    for (const requirement of requirements) {
      const expectedUses = `${actionsRepository}/.github/workflows/${requirement.workflow}@`;
      if (!hasCreatedEvent(workflow.on, requirement.event)) continue;
      for (const job of Object.values(workflow.jobs)) {
        if (!isRecord(job) || typeof job.uses !== "string" || !job.uses.toLowerCase().startsWith(expectedUses) || job.uses.length === expectedUses.length || "if" in job) continue;
        if (job.secrets === "inherit") distributed.add(requirement.workflow);
      }
    }
  }
  return requirements.every((requirement) => distributed.has(requirement.workflow));
}

async function countAutoMergeQueue(gh: GitHub, fullName: string): Promise<number> {
  const { owner, repo } = splitRepository(fullName);
  const page = z.object({ repository: z.object({ pullRequests: z.object({ nodes: z.array(z.object({ autoMergeRequest: z.unknown().nullable() })), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }).nullable() }).nullable() });
  let cursor: string | null = null;
  let total = 0;
  const seenCursors = new Set<string>();
  do {
    const response = await gh.graphql<unknown>("query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,after:$cursor){nodes{autoMergeRequest{enabledAt}} pageInfo{hasNextPage endCursor}}}}", { owner, name: repo, cursor });
    const result = page.parse(response);
    const connection = result.repository?.pullRequests;
    if (!connection) throw new Rejection(`repository ${fullName} is unavailable for auto-merge preflight`);
    total += connection.nodes.filter((node) => node.autoMergeRequest !== null).length;
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && cursor === null) throw new Error("GitHub returned a next page without a cursor");
    if (cursor !== null && seenCursors.has(cursor)) throw new Error("GitHub repeated an auto-merge queue cursor");
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);
  return total;
}

function hasCreatedEvent(value: unknown, event: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => entry === event);
  if (value === event) return true;
  if (!isRecord(value) || !(event in value)) return false;
  const configuration = value[event];
  if (!isRecord(configuration) || !("types" in configuration)) return true;
  return Array.isArray(configuration.types) && configuration.types.includes("created");
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RuleSetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  source_type: z.string().optional(),
  enforcement: z.enum(["active", "disabled", "evaluate"]),
  target: z.string(),
  conditions: z.record(z.string(), z.unknown()),
  rules: z.array(z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() })),
  bypass_actors: z.array(z.object({ actor_id: z.number(), actor_type: z.string(), bypass_mode: z.string() })),
});
type RuleSet = z.infer<typeof RuleSetSchema>;

type RuleSetDefinition = {
  name: "integrity" | "review-and-checks" | "controlled-merges" | "release-tags";
  enforcement: "active";
  target: "branch" | "tag";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  // Rules are written exactly as GitHub returns them, so an unchanged ruleset compares equal.
  rules: ({ type: "deletion" | "non_fast_forward" | "required_linear_history" | "required_signatures" | "creation" | "update" } | { type: "pull_request"; parameters: Record<string, unknown> } | { type: "required_status_checks"; parameters: Record<string, unknown> })[];
  bypass_actors: { actor_id: number; actor_type: "Integration"; bypass_mode: "pull_request" | "always" }[];
};

export function repoSettingsRuleSets(config: Config): RuleSetDefinition[] {
  const defaultBranch = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
  const serverBypass = [{ actor_id: config.apps.server_app_id, actor_type: "Integration" as const, bypass_mode: "pull_request" as const }];
  return [
    { name: "integrity", enforcement: "active", target: "branch", conditions: defaultBranch, rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }, { type: "required_signatures" }], bypass_actors: [] },
    { name: "review-and-checks", enforcement: "active", target: "branch", conditions: defaultBranch, rules: [
      { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, required_reviewers: [], require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, require_extra_approval_for_unattributed_changes: true, allowed_merge_methods: ["squash"] } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: [{ context: "csm-ci/policy", integration_id: config.apps.server_app_id }, ...config.merge.required_checks.map((check) => ({ context: check.name, integration_id: check.app_id }))] } },
    ], bypass_actors: [] },
    { name: "controlled-merges", enforcement: "active", target: "branch", conditions: defaultBranch, rules: [{ type: "update" }], bypass_actors: serverBypass },
    { name: "release-tags", enforcement: "active", target: "tag", conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }], bypass_actors: [{ actor_id: config.apps.server_app_id, actor_type: "Integration", bypass_mode: "always" }] },
  ];
}

export type RepoSettingsInspection = {
  target: RepoSettingsTarget;
  changes: { settings: string[]; immutableReleases: boolean; rulesets: string[] };
  // A dispatch that would create controlled-merges or move it to active; only this needs the preflight.
  activation: boolean;
  rulesetIds: Record<string, number | undefined>;
  rulesetEnforcements: Record<string, RuleSet["enforcement"] | undefined>;
};

export type RepoSettingsApplyResult = { settingsUpdated: number; immutableReleasesEnabled: number; rulesetsUpdated: number; rulesetsCreated: number };

// GitHub returns ruleset bypass_actors only to callers with write access to the ruleset, so
// repository state is read with the administration token.
export async function inspectRepoSettings(args: {
  adminGH: GitHub;
  config: Config;
  target: RepoSettingsTarget;
  mode: RepoSettingsMode;
}): Promise<RepoSettingsInspection> {
  const repoSettings = args.config.repo_settings;
  if (!repoSettings) throw new Rejection("repo_settings is not configured");
  const address = { ...splitRepository(args.target.name) };
  const [repositoryResponse, ruleSets, immutableEnabled] = await Promise.all([
    args.adminGH.rest.repos.get(address),
    args.adminGH.paginate("GET /repos/{owner}/{repo}/rulesets", { ...address, per_page: 100 }),
    isImmutableReleasesEnabled(args.adminGH, address),
  ]);
  const definitions = repoSettingsRuleSets(args.config);
  const summaries = z.array(z.object({ id: z.number().int().positive(), name: z.string(), source_type: z.string().optional() })).parse(ruleSets);
  const managed = await Promise.all(summaries.filter((set) => set.source_type === "Repository" && definitions.some((definition) => definition.name === set.name)).map(async (set) => {
    const response = await args.adminGH.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { ...address, ruleset_id: set.id });
    if (!("bypass_actors" in response.data)) throw new Rejection(`ruleset ${set.name} hides its bypass actors; inspection requires administration write access`);
    return RuleSetSchema.parse(response.data);
  }));
  const byName = new Map<string, RuleSet[]>();
  for (const ruleset of managed) byName.set(ruleset.name, [...(byName.get(ruleset.name) ?? []), ruleset]);
  for (const [name, matches] of byName) if (matches.length > 1) throw new Rejection(`multiple Repository rulesets named ${name}`);
  const ids: Record<string, number | undefined> = {};
  const enforcements: Record<string, RuleSet["enforcement"] | undefined> = {};
  const rulesetsToChange: string[] = [];
  let activation = false;
  for (const definition of definitions) {
    const existing = byName.get(definition.name)?.[0];
    ids[definition.name] = existing?.id;
    enforcements[definition.name] = existing?.enforcement;
    const controlled = definition.name === "controlled-merges";
    if (controlled && args.mode === "schedule" && !existing) continue;
    if (controlled && args.mode === "dispatch" && existing?.enforcement !== "active") {
      if (existing && !sameServerPullRequestBypass(existing.bypass_actors, args.config.apps.server_app_id)) {
        throw new Rejection("controlled-merges bypass must contain only the Server App pull_request bypass");
      }
      activation = true;
    }
    if (!existing || !sameRuleSet(existing, definition, controlled && args.mode === "schedule" ? existing.enforcement : undefined)) rulesetsToChange.push(definition.name);
  }
  return {
    target: args.target,
    changes: { settings: changedSettings(repositoryResponse.data, repoSettings.settings ?? {}), immutableReleases: !immutableEnabled, rulesets: rulesetsToChange },
    activation,
    rulesetIds: ids,
    rulesetEnforcements: enforcements,
  };
}

export async function applyRepoSettings(args: {
  readGH: GitHub;
  adminGH: GitHub;
  config: Config;
  target: RepoSettingsTarget;
  mode: RepoSettingsMode;
  approverAppSlug?: string;
  actionsRepository?: string;
}): Promise<RepoSettingsApplyResult> {
  const inspection = await inspectRepoSettings({ adminGH: args.adminGH, config: args.config, target: args.target, mode: args.mode });
  if (inspection.activation) {
    if (!args.approverAppSlug) throw new Rejection("approver App slug is required for dispatch preflight");
    const basic = await inspectRepoSettingsPreflight({ readGH: args.readGH, target: args.target, ...(args.actionsRepository ? { actionsRepository: args.actionsRepository } : {}) });
    const approverCanWrite = await verifyRepoSettingsApprover({ readGH: args.readGH, config: args.config, approverAppSlug: args.approverAppSlug });
    validateDispatchPreflight({ ...basic, approverCanWrite });
  }
  const repoSettings = args.config.repo_settings;
  if (!repoSettings) throw new Rejection("repo_settings is not configured");
  const address = { ...splitRepository(args.target.name) };
  let settingsUpdated = 0;
  let immutableReleasesEnabled = 0;
  let rulesetsUpdated = 0;
  let rulesetsCreated = 0;
  if (inspection.changes.settings.length > 0 && repoSettings.settings) {
    const desired = repoSettings.settings;
    await args.adminGH.rest.repos.update({
      ...address,
      ...(desired.delete_branch_on_merge !== undefined ? { delete_branch_on_merge: desired.delete_branch_on_merge } : {}),
      ...(desired.allow_auto_merge !== undefined ? { allow_auto_merge: desired.allow_auto_merge } : {}),
      ...(desired.allow_squash_merge !== undefined ? { allow_squash_merge: desired.allow_squash_merge } : {}),
      ...(desired.allow_merge_commit !== undefined ? { allow_merge_commit: desired.allow_merge_commit } : {}),
      ...(desired.allow_rebase_merge !== undefined ? { allow_rebase_merge: desired.allow_rebase_merge } : {}),
    });
    settingsUpdated = 1;
  }
  if (inspection.changes.immutableReleases) {
    await args.adminGH.request("PUT /repos/{owner}/{repo}/immutable-releases", address);
    immutableReleasesEnabled = 1;
  }
  const definitions = repoSettingsRuleSets(args.config);
  for (const name of inspection.changes.rulesets) {
    const definition = definitions.find((entry) => entry.name === name);
    if (!definition) throw new Error(`missing fixed ruleset definition: ${name}`);
    const id = inspection.rulesetIds[name];
    if (id === undefined) {
      if (name === "controlled-merges" && args.mode === "schedule") continue;
      await args.adminGH.request({ method: "POST", url: "/repos/{owner}/{repo}/rulesets", ...address, ...definition });
      rulesetsCreated++;
    } else {
      // A PUT without enforcement keeps the live value, so a stop set after inspection survives.
      const { enforcement: _enforcement, ...withoutEnforcement } = definition;
      const body = name === "controlled-merges" && args.mode === "schedule" ? withoutEnforcement : definition;
      await args.adminGH.request({ method: "PUT", url: "/repos/{owner}/{repo}/rulesets/{ruleset_id}", ...address, ruleset_id: id, ...body });
      rulesetsUpdated++;
    }
  }
  return { settingsUpdated, immutableReleasesEnabled, rulesetsUpdated, rulesetsCreated };
}

function validateDispatchPreflight(preflight: DispatchPreflight): void {
  const checks: [boolean, string][] = [
    [preflight.callerDistributed, "caller workflow has not been distributed"],
    [preflight.approverCanWrite, "approver bot does not have write permission"],
    [Number.isInteger(preflight.autoMergeQueueCount) && preflight.autoMergeQueueCount === 0, "auto-merge queue is not empty"],
  ];
  for (const [valid, message] of checks) if (!valid) throw new Rejection(message);
}

function sameServerPullRequestBypass(bypassActors: RuleSet["bypass_actors"], serverAppId: number): boolean {
  return bypassActors.length === 1 && bypassActors[0]?.actor_id === serverAppId && bypassActors[0]?.actor_type === "Integration" && bypassActors[0]?.bypass_mode === "pull_request";
}

function changedSettings(repository: Record<string, unknown>, desired: NonNullable<RepoSettingsConfig["settings"]>): string[] {
  return Object.entries(desired).filter(([key, value]) => {
    if (!(key in repository)) throw new Rejection(`repository setting ${key} is not visible to the inspection token`);
    return repository[key] !== value;
  }).map(([key]) => key);
}

function sameRuleSet(existing: RuleSet, desired: RuleSetDefinition, preserveEnforcement?: RuleSet["enforcement"]): boolean {
  return canonical({ enforcement: preserveEnforcement ?? existing.enforcement, target: existing.target, conditions: existing.conditions, rules: existing.rules, bypass_actors: existing.bypass_actors }) ===
    canonical({ enforcement: preserveEnforcement ?? desired.enforcement, target: desired.target, conditions: desired.conditions, rules: desired.rules, bypass_actors: desired.bypass_actors });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value).filter(([key]) => key !== "id" && key !== "_links" && key !== "source" && key !== "source_type").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

async function isImmutableReleasesEnabled(gh: GitHub, address: ReturnType<typeof splitRepository>): Promise<boolean> {
  try {
    const response = await gh.request("GET /repos/{owner}/{repo}/immutable-releases", address);
    return z.object({ enabled: z.boolean() }).passthrough().parse(response.data).enabled;
  } catch (error) {
    if (status(error) === 404) return false;
    throw error;
  }
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}
