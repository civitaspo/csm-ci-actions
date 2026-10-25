import * as core from "@actions/core";
import { applyManagedFiles, inspectManagedFiles } from "../lib/managed-files.ts";
import { applyRepoSettings, discoverRepoSettingsTargets, inspectRepoSettings, inspectRepoSettingsPreflight } from "../lib/repo-settings.ts";
import { github, loadConfig, splitRepository } from "../lib/github.ts";
import { validateRepoSettingsContext } from "./context.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function input(name: string, required = false): string {
  return core.getInput(name, { required });
}

async function main(): Promise<void> {
  const serverRepository = env("GITHUB_REPOSITORY");
  const configPath = input("config-path") || "csm-ci.yaml";
  const actionsRepository = input("actions-repository", true);
  const configGH = github(input("github-token") || env("GITHUB_TOKEN"));
  const config = await loadConfig(configGH, serverRepository, env("GITHUB_SHA"), configPath);
  const { data: server } = await configGH.rest.repos.get(splitRepository(serverRepository));
  const mode = input("mode", true);
  const repository = input("repository");
  const target = repository ? { name: repository.toLowerCase(), isServer: repository.toLowerCase() === serverRepository.toLowerCase() } : undefined;
  validateRepoSettingsContext({ config, serverRepository, serverRef: env("GITHUB_REF"), serverDefaultBranch: server.default_branch, actionsRepository, ...(target ? { targetRepository: target.name } : {}) });
  if (mode === "discover") {
    const discoveryGH = github(input("discovery-token", true));
    const installed = await discoveryGH.paginate("GET /installation/repositories", { per_page: 100 });
    const requested = input("requested-repository");
    const targets = discoverRepoSettingsTargets({ config, installedRepositories: installed, serverRepository, actionsRepository, ...(requested ? { requestedRepository: requested } : {}) });
    core.setOutput("clients", JSON.stringify(targets.clients));
    core.setOutput("client-count", String(targets.clients.length));
    core.setOutput("server", JSON.stringify(targets.server));
    core.setOutput("has-server", String(targets.server !== null));
    core.setOutput("has-clients", String(targets.clients.length > 0));
    core.info(`discovered ${targets.clients.length} configured client repositories`);
    return;
  }
  if (!target) throw new Error("repository is required for this mode");
  const address = splitRepository(target.name);
  if (mode === "validate-target") {
    core.setOutput("target-owner", address.owner);
    core.setOutput("target-name", address.repo);
    core.setOutput("is-server", String(target.isServer));
    return;
  }
  const readGH = github(input("read-token", true));
  if (mode === "preflight") {
    const result = await inspectRepoSettingsPreflight({ readGH, target, actionsRepository: input("actions-repository", true) });
    if (!result.callerDistributed) throw new Error(`caller workflow is not distributed on ${target.name}`);
    if (result.autoMergeQueueCount !== 0) throw new Error(`auto-merge queue is not empty for ${target.name} (${result.autoMergeQueueCount} pull requests)`);
    core.setOutput("caller-distributed", String(result.callerDistributed));
    core.setOutput("auto-merge-queue-count", String(result.autoMergeQueueCount));
    core.info(`preflight for ${target.name} completed`);
    return;
  }
  if (mode === "inspect" || mode === "apply") {
    const approverAppSlug = input("approver-app-slug");
    if (mode === "inspect") {
      const result = await inspectRepoSettings({ readGH, config, target, mode: eventMode(input("event-mode", true)), ...(approverAppSlug ? { approverAppSlug } : {}), actionsRepository });
      core.setOutput("changes", JSON.stringify(result.changes));
      core.setOutput("has-changes", String(result.changes.settings || result.changes.immutableReleases || result.changes.rulesets.length > 0));
      return;
    }
    const result = await applyRepoSettings({ readGH, adminGH: github(input("admin-token", true)), config, target, mode: eventMode(input("event-mode", true)), ...(approverAppSlug ? { approverAppSlug } : {}), actionsRepository });
    core.setOutput("result", JSON.stringify(result));
    return;
  }
  if (mode === "managed-inspect" || mode === "managed-apply") {
    const { data: repo } = await readGH.rest.repos.get(address);
    const files = config.repo_settings?.managed_files ?? {};
    if (mode === "managed-inspect") {
      const result = await inspectManagedFiles(readGH, { repository: target.name, defaultBranch: repo.default_branch, serverBotId: config.apps.server_bot_id, files });
      core.setOutput("result", result.status);
      core.setOutput("requires-workflows-write", String(result.requiresWorkflowsWrite));
      core.setOutput("changed-paths", JSON.stringify(result.changedPaths));
      core.setOutput("has-changes", String(result.status === "ready"));
      return;
    }
    const result = await applyManagedFiles(readGH, { repository: target.name, defaultBranch: repo.default_branch, serverBotId: config.apps.server_bot_id, files, writeToken: input("contents-token", true) });
    core.setOutput("result", JSON.stringify(result));
    return;
  }
  throw new Error(`unknown repo-settings mode ${mode}`);
}

function eventMode(value: string): "schedule" | "dispatch" {
  if (value !== "schedule" && value !== "dispatch") throw new Error(`unknown event mode ${value}`);
  return value;
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
