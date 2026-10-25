import { describe, expect, test } from "bun:test";
import { CONFIG_YAML, config, fakeFetch } from "./testing.ts";
import { parseConfig } from "./config.ts";
import { github } from "./github.ts";
import { discoverRepoSettingsTargets, inspectRepoSettings, inspectRepoSettingsPreflight, repoSettingsRuleSets, type RepoSettingsTarget } from "./repo-settings.ts";

describe("discoverRepoSettingsTargets", () => {
  const installed = [
    { name: "server", owner: { login: "owner" }, id: 1 },
    { name: "client", owner: { login: "OWNER" }, id: 2 },
    { name: "csm-ci-actions", owner: { login: "owner" }, id: 3 },
    { name: "unconfigured", owner: { login: "owner" }, id: 4 },
  ];

  test("selects configured installed repositories and keeps the server last", () => {
    expect(discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", actionsRepository: "owner/csm-ci-actions" })).toEqual({
      clients: [{ name: "owner/client", isServer: false }, { name: "owner/unconfigured", isServer: false }],
      server: { name: "owner/server", isServer: true },
    });
  });

  test("a requested client does not implicitly select the server", () => {
    expect(discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", actionsRepository: "owner/csm-ci-actions", requestedRepository: "OWNER/client" })).toEqual({
      clients: [{ name: "owner/client", isServer: false }], server: null,
    });
  });

  const rejects: [string, Parameters<typeof discoverRepoSettingsTargets>[0], string][] = [
    ["server config identity mismatch", { config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/other" }, "server repository does not match the pinned configuration"],
    ["server not installed", { config: configWithSettings(), installedRepositories: installed.slice(1), serverRepository: "owner/server" }, "server repository owner/server is not installed"],
    ["server not configured", { config: configWithoutServer(), installedRepositories: installed, serverRepository: "owner/server" }, "server repository owner/server is not configured"],
    ["requested repository missing", { config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", requestedRepository: "owner/missing" }, "requested repository owner/missing is not installed and configured"],
    ["actions repository excluded", { config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", actionsRepository: "owner/csm-ci-actions", requestedRepository: "owner/csm-ci-actions" }, "requested repository owner/csm-ci-actions is not installed and configured"],
  ];
  test.each(rejects)("rejects %s", (_, args, message) => {
    expect(() => discoverRepoSettingsTargets(args)).toThrow(message);
  });

  test("requires repo_settings config before discovering targets", () => {
    const incomplete = { ...config(), repo_settings: undefined };
    expect(() => discoverRepoSettingsTargets({ config: incomplete, installedRepositories: installed, serverRepository: "owner/server" })).toThrow("repo_settings is not configured");
  });

  test("rejects malformed installation repository metadata", () => {
    expect(() => discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: [{ name: "server", owner: null }], serverRepository: "owner/server" })).toThrow();
  });
});

describe("inspectRepoSettings", () => {
  const target: RepoSettingsTarget = { name: "owner/client", isServer: false };
  const repository = { default_branch: "main", delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false };
  const disabledControlled = {
    id: 81,
    name: "controlled-merges",
    source_type: "Repository",
    enforcement: "disabled",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }],
    bypass_actors: [{ actor_id: 1, actor_type: "Integration", bypass_mode: "pull_request" }],
  };

  test("schedule preserves a disabled controlled-merges emergency stop", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: disabledControlled },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes.rulesets).not.toContain("controlled-merges");
    expect(plan.rulesetEnforcements["controlled-merges"]).toBe("disabled");
  });

  test("schedule does not create a missing controlled-merges ruleset", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes.rulesets).not.toContain("controlled-merges");
  });

  test("exact repository state is a no-op", async () => {
    const desired = repoSettingsRuleSets(config());
    const summaries = desired.map((set, index) => ({ id: index + 1, name: set.name, source_type: "Repository" }));
    const rules = summaries.map((summary, index) => ({
      method: "GET",
      path: `/repos/owner/client/rulesets/${summary.id}`,
      body: { ...desired[index], ...summary, conditions: { ref_name: { include: (desired[index]?.conditions.ref_name.include ?? []), exclude: [] } } },
    }));
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: summaries },
      ...rules,
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const readFetch = fakeFetch([]);
    const plan = await inspectRepoSettings({ readGH: github("read", readFetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes).toEqual({ settings: false, immutableReleases: false, rulesets: [] });
    expect(readFetch.calls).toEqual([]);
  });

  test("rejects a ruleset whose bypass actors are hidden from the token", async () => {
    const { bypass_actors: _hidden, ...hidden } = disabledControlled;
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: hidden },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    await expect(inspectRepoSettings({ readGH: github("read", fakeFetch([])), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" }))
      .rejects.toThrow("ruleset controlled-merges hides its bypass actors; inspection requires administration write access");
  });

  test("rejects duplicate managed Repository rulesets with the same name", async () => {
    const first = { ...disabledControlled, id: 81, enforcement: "active" };
    const second = { ...disabledControlled, id: 82, enforcement: "active" };
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [
        { id: 81, name: "controlled-merges", source_type: "Repository" },
        { id: 82, name: "controlled-merges", source_type: "Repository" },
      ] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: first },
      { method: "GET", path: "/repos/owner/client/rulesets/82", body: second },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    await expect(inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" }))
      .rejects.toThrow("multiple Repository rulesets named controlled-merges");
  });

  test("non-missing immutable-release API errors propagate", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", status: 500, body: { message: "failure" } },
    ]);
    await expect(inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" })).rejects.toThrow();
  });

  const dispatchRejects: [string, { event?: string; jobIf?: string; approverId?: number; queueCount?: number; bypass?: { actor_id: number; actor_type: string; bypass_mode: string }[] }, string][] = [
    ["caller is not distributed", { event: "workflow_dispatch" }, "caller workflow has not been distributed"],
    ["caller job is conditional", { jobIf: "${{ github.event_name == 'push' }}" }, "caller workflow has not been distributed"],
    ["approver identity differs from config", { approverId: 999 }, "approver bot does not have write permission"],
    ["auto-merge queue is occupied", { queueCount: 1 }, "auto-merge queue is not empty"],
    ["controlled-merges has another bypass", { bypass: [{ actor_id: 99, actor_type: "Integration", bypass_mode: "pull_request" }] }, "controlled-merges bypass must contain only the Server App pull_request bypass"],
  ];
  test.each(dispatchRejects)("dispatch rejects %s", async (_, options, message) => {
    const fetch = dispatchFetch(options);
    await expect(inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", approverAppSlug: "approver" })).rejects.toThrow(message);
  });

  test("dispatch requires the minted approver app slug", async () => {
    const fetch = fakeFetch([]);
    await expect(inspectRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch" })).rejects.toThrow("approver App slug is required for dispatch preflight");
    expect(fetch.calls).toEqual([]);
  });

  test.each([
    ["server workflow without merge caller", ["server.yml"], false],
    ["merge caller without server workflow", ["client-merge.yml"], false],
    ["both distributed caller workflows", ["client-merge.yml", "server.yml"], true],
  ] as const)("server dispatch requires %s", async (_name, filenames, expected) => {
    const fetch = serverCallerPreflightFetch(filenames);
    const result = await inspectRepoSettingsPreflight({ readGH: github("read", fetch), target: { name: "owner/server", isServer: true } });
    expect(result.callerDistributed).toBe(expected);
  });

  test.each([
    ["workflow directory lookup", "/repos/owner/client/contents/.github%2Fworkflows"],
    ["caller workflow lookup", "/repos/owner/client/contents/.github%2Fworkflows%2Fmerge.yml"],
  ])("API errors during %s propagate", async (_name, path) => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { default_branch: "main" } },
      ...(path.endsWith("workflows") ? [{ method: "GET", path, status: 500, body: { message: "server error" } }] : [
        { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows", body: [{ name: "merge.yml", type: "file" }] },
        { method: "GET", path, status: 500, body: { message: "server error" } },
      ]),
    ]);
    await expect(inspectRepoSettingsPreflight({ readGH: github("read", fetch), target })).rejects.toThrow("server error");
  });
});

function configWithSettings() {
  return parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false } }\n`);
}

function configWithoutServer() {
  return parseConfig(`${CONFIG_YAML.replace("name: owner/*", "name: owner/client")}\nrepo_settings: {}\n`);
}

function dispatchFetch(options: { event?: string; jobIf?: string; approverId?: number; queueCount?: number; bypass?: { actor_id: number; actor_type: string; bypass_mode: string }[] }) {
  const workflow = `on:\n  ${options.event ?? "issue_comment"}:\n    types: [created]\njobs:\n  merge:\n    uses: civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@e2e\n    secrets: inherit${options.jobIf ? `\n    if: ${options.jobIf}` : ""}\n`;
  const controlled = {
    id: 81,
    name: "controlled-merges",
    source_type: "Repository",
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }],
    bypass_actors: options.bypass ?? [{ actor_id: 1, actor_type: "Integration", bypass_mode: "pull_request" }],
  };
  return fakeFetch([
    { method: "GET", path: "/repos/owner/client", body: { default_branch: "main", delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false } },
    { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows", body: [{ name: "merge.yml", type: "file" }] },
    { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows%2Fmerge.yml", body: workflow },
    { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
    { method: "GET", path: "/repos/owner/client/rulesets/81", body: controlled },
    { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    { method: "GET", path: "/users/approver%5Bbot%5D", body: { id: options.approverId ?? 4000, login: "approver[bot]" } },
    {
      method: "POST",
      path: "/graphql",
      body: {
        data: {
          repository: {
            pullRequests: {
              nodes: Array.from({ length: options.queueCount ?? 0 }, () => ({ autoMergeRequest: { enabledAt: "now" } })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ]);
}

function serverCallerPreflightFetch(filenames: readonly string[]) {
  const workflows = filenames.map((filename) => {
    const event = filename === "server.yml" ? "label" : "issue_comment";
    return {
      method: "GET",
      path: `/repos/owner/server/contents/.github%2Fworkflows%2F${filename}`,
      body: `on:\n  ${event}:\n    types: [created]\njobs:\n  run:\n    uses: civitaspo/csm-ci-actions/.github/workflows/${filename}@e2e\n    secrets: inherit\n`,
    };
  });
  return fakeFetch([
    { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
    { method: "GET", path: "/repos/owner/server/contents/.github%2Fworkflows", body: filenames.map((name) => ({ name, type: "file" })) },
    ...workflows,
    { method: "POST", path: "/graphql", body: { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
  ]);
}
