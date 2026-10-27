import { repositoryEntry, type Config } from "../lib/config.ts";
import { splitRepository } from "../lib/github.ts";

export function validateRepoSettingsContext(args: {
  config: Config;
  serverRepository: string;
  serverRef: string;
  serverDefaultBranch: string;
  actionsRepository: string;
  targetRepository?: string;
}): void {
  const serverRepository = args.serverRepository.toLowerCase();
  const actionsRepository = args.actionsRepository.toLowerCase();
  if (args.config.server_repository !== serverRepository) {
    throw new Error(`server repository does not match the pinned configuration: ${serverRepository}`);
  }
  if (serverRepository === actionsRepository) throw new Error("the csm-ci-actions repository cannot be the server repository");
  if (args.serverRef !== `refs/heads/${args.serverDefaultBranch}`) {
    throw new Error("repo-settings may run only from the server repository default branch");
  }
  if (!args.config.repo_settings) throw new Error("repo_settings is not configured");
  if (args.targetRepository === undefined) return;

  const targetRepository = args.targetRepository.toLowerCase();
  splitRepository(targetRepository);
  if (!repositoryEntry(args.config, targetRepository)) throw new Error(`repository ${targetRepository} is not configured`);
}

export function repoSettingsEventMode(value: string, eventName: string): "schedule" | "dispatch" {
  if (value !== "schedule" && value !== "dispatch") throw new Error(`unknown event mode ${value}`);
  if (value === "dispatch" && eventName === "schedule") throw new Error("a scheduled run cannot use dispatch mode");
  return value;
}

export const REPO_SETTINGS_TARGETS = ["settings", "rulesets", "releases", "managed-files"] as const;
export type RepoSettingsTargetName = (typeof REPO_SETTINGS_TARGETS)[number];
export type RepoSettingsSelection = ReadonlySet<RepoSettingsTargetName>;

// Parses the comma-separated targets input. The result keeps the canonical processing order.
export function repoSettingsSelection(value: string, eventName: string, eventMode?: string): RepoSettingsSelection {
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) throw new Error(`repo-settings targets must be a comma-separated list of ${[...REPO_SETTINGS_TARGETS, "all"].join(", ")}: ${JSON.stringify(value)}`);
  const selected = new Set<RepoSettingsTargetName>();
  for (const entry of entries) {
    if (entry === "all") REPO_SETTINGS_TARGETS.forEach((target) => selected.add(target));
    else if ((REPO_SETTINGS_TARGETS as readonly string[]).includes(entry)) selected.add(entry as RepoSettingsTargetName);
    else throw new Error(`unknown repo-settings target ${entry}; use ${[...REPO_SETTINGS_TARGETS, "all"].join(", ")}`);
  }
  const all = selected.size === REPO_SETTINGS_TARGETS.length;
  if (!all && (eventName === "schedule" || eventMode === "schedule")) throw new Error("a scheduled run must select all repo-settings targets");
  if (!all && eventName !== "workflow_dispatch") throw new Error("selecting repo-settings targets other than all requires a workflow_dispatch event");
  return new Set(REPO_SETTINGS_TARGETS.filter((target) => selected.has(target)));
}

export function formatRepoSettingsSelection(selection: RepoSettingsSelection): string {
  return REPO_SETTINGS_TARGETS.filter((target) => selection.has(target)).join(",");
}

export function selectsAdministration(selection: RepoSettingsSelection): boolean {
  return selection.has("settings") || selection.has("rulesets") || selection.has("releases");
}

export function validateRepoSettingsStage(stage: string, selection: RepoSettingsSelection): void {
  const allowed = ["inspect", "apply"].includes(stage) ? selectsAdministration(selection)
    : stage === "preflight" ? selection.has("rulesets")
      : ["managed-inspect", "managed-apply"].includes(stage) ? selection.has("managed-files")
        : true;
  if (!allowed) throw new Error(`repo-settings stage ${stage} is unavailable for targets ${formatRepoSettingsSelection(selection)}`);
}
