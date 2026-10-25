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
