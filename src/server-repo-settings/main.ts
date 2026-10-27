import * as core from "@actions/core";
import { generateWorkflows, ReleasedRevision, selectedCallers } from "../lib/generated-workflows.ts";
import { resolveWorkflowRelease } from "../lib/workflow-release.ts";
import { loadAdditionalManagedFiles } from "../lib/additional-managed-files.ts";
import { applyManagedFiles, inspectManagedFiles } from "../lib/managed-files.ts";
import { applyRepoSettings, discoverRepoSettingsTargets, inspectRepoSettings, inspectRepoSettingsPreflight } from "../lib/repo-settings.ts";
import { github, loadConfig, splitRepository } from "../lib/github.ts";
import { repoSettingsEventMode, repoSettingsOperationMode, validateRepoSettingsContext, validateRepoSettingsStage } from "./context.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function input(name: string, required = false): string {
  return core.getInput(name, { required });
}

async function main(): Promise<void> {
  const mode = input("mode", true);
  const operationMode = repoSettingsOperationMode(input("operation-mode"), env("GITHUB_EVENT_NAME"), input("event-mode") || undefined);
  validateRepoSettingsStage(mode, operationMode);
  core.setOutput("operation-mode", operationMode);
  if (mode === "validate-mode") {
    return;
  }
  const serverRepository = env("GITHUB_REPOSITORY");
  const configPath = input("config-path") || "csm-ci.yaml";
  const actionsRepository = input("actions-repository", true);
  const configGH = github(input("github-token") || env("GITHUB_TOKEN"));
  const config = await loadConfig(configGH, serverRepository, env("GITHUB_SHA"), configPath);
  const { data: server } = await configGH.rest.repos.get(splitRepository(serverRepository));
  const repository = input("repository");
  const target = repository ? { name: repository.toLowerCase(), isServer: repository.toLowerCase() === serverRepository.toLowerCase() } : undefined;
  validateRepoSettingsContext({ config, serverRepository, serverRef: env("GITHUB_REF"), serverDefaultBranch: server.default_branch, actionsRepository, ...(target ? { targetRepository: target.name } : {}) });
  if (mode === "discover") {
    const discoveryGH = github(input("discovery-token", true));
    const installed = await discoveryGH.paginate("GET /installation/repositories", { per_page: 100 });
    const requested = input("requested-repository");
    const targets = discoverRepoSettingsTargets({ config, installedRepositories: installed, serverRepository, ...(requested ? { requestedRepository: requested } : {}) });
    const selected = [...targets.clients, ...(targets.server ? [targets.server] : [])];
    const release = await resolveWorkflowRelease(configGH, selected.flatMap((target) => selectedCallers(config, target.name)));
    core.setOutput("workflow-release", JSON.stringify(release));
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
  if (mode === "inspect") {
    const result = await inspectRepoSettings({ adminGH: github(input("admin-token", true)), config, target, mode: repoSettingsEventMode(input("event-mode", true), env("GITHUB_EVENT_NAME")) });
    core.info(`drift for ${target.name}: ${JSON.stringify(result.changes)}; activation required: ${result.activation}`);
    core.setOutput("changes", JSON.stringify(result.changes));
    core.setOutput("activation-required", String(result.activation));
    core.setOutput("has-changes", String(result.changes.settings.length > 0 || result.changes.immutableReleases || result.changes.sponsorships || result.changes.rulesets.length > 0));
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
  if (mode === "apply") {
    const approverAppSlug = input("approver-app-slug");
    const result = await applyRepoSettings({
      readGH,
      adminGH: github(input("admin-token", true)),
      config,
      target,
      mode: repoSettingsEventMode(input("event-mode", true), env("GITHUB_EVENT_NAME")),
      ...(approverAppSlug ? { approverAppSlug } : {}),
      actionsRepository,
      onRulesetCreated: ({ id, name }) => core.info(`created-repo-settings-ruleset ${JSON.stringify({ repository: target.name, id, name })}`),
    });
    core.info(`applied to ${target.name}: ${JSON.stringify(result)}`);
    core.setOutput("result", JSON.stringify(result));
    return;
  }
  if (mode === "managed-inspect" || mode === "managed-apply") {
    const { data: repo } = await readGH.rest.repos.get(address);
    const files = await loadAdditionalManagedFiles(configGH, { repository: serverRepository, sha: env("GITHUB_SHA"), settings: config.repo_settings });
    const release = ReleasedRevision.parse(JSON.parse(input("workflow-release", true)));
    const generated = { release, files: generateWorkflows(config, target.name, repo.default_branch, release) };
    if (mode === "managed-inspect") {
      const result = await inspectManagedFiles(readGH, { repository: target.name, defaultBranch: repo.default_branch, serverBotId: config.apps.server_bot_id, generated, files });
      core.setOutput("result", result.status);
      core.setOutput("requires-workflows-write", String(result.requiresWorkflowsWrite));
      core.setOutput("changed-paths", JSON.stringify(result.changedPaths));
      core.setOutput("has-changes", String(result.status === "ready"));
      return;
    }
    const result = await applyManagedFiles(readGH, { repository: target.name, defaultBranch: repo.default_branch, serverBotId: config.apps.server_bot_id, generated, files, writeToken: input("contents-token", true) });
    core.setOutput("result", JSON.stringify(result));
    return;
  }
  throw new Error(`unknown repo-settings mode ${mode}`);
}


main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
