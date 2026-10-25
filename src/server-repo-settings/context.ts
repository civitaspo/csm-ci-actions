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
  if (targetRepository === actionsRepository) throw new Error("the csm-ci-actions repository cannot be a repo-settings target");
  if (!repositoryEntry(args.config, targetRepository)) throw new Error(`repository ${targetRepository} is not configured`);
}

export function repoSettingsEventMode(value: string, eventName: string): "schedule" | "dispatch" {
  if (value !== "schedule" && value !== "dispatch") throw new Error(`unknown event mode ${value}`);
  if (value === "dispatch" && eventName === "schedule") throw new Error("a scheduled run cannot use dispatch mode");
  return value;
}

export type RepoSettingsOperationMode = "reconcile" | "managed-files-only";

export function repoSettingsOperationMode(value: string | undefined, eventName: string, eventMode?: string): RepoSettingsOperationMode {
  const operationMode = value || "reconcile";
  if (operationMode !== "reconcile" && operationMode !== "managed-files-only") {
    throw new Error(`unknown repo-settings operation mode ${operationMode}`);
  }
  if (operationMode === "managed-files-only" && (eventName === "schedule" || eventMode === "schedule")) {
    throw new Error("a scheduled run cannot use managed-files-only mode");
  }
  if (operationMode === "managed-files-only" && eventName !== "workflow_dispatch") {
    throw new Error("managed-files-only mode requires a workflow_dispatch event");
  }
  return operationMode;
}

export function validateRepoSettingsStage(stage: string, operationMode: RepoSettingsOperationMode): void {
  if (operationMode === "managed-files-only" && ["inspect", "preflight", "apply"].includes(stage)) {
    throw new Error(`repo-settings stage ${stage} is unavailable in managed-files-only mode`);
  }
}
