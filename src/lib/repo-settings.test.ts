import { describe, expect, test } from "bun:test";
import { CONFIG_YAML, config, fakeFetch } from "./testing.ts";
import { parseConfig } from "./config.ts";
import { github } from "./github.ts";
import { applyRepoSettings, discoverRepoSettingsTargets, inspectRepoSettings, inspectRepoSettingsPreflight, repoSettingsRuleSets, verifyRepoSettingsApprover, type RepoSettingsTarget } from "./repo-settings.ts";

describe("discoverRepoSettingsTargets", () => {
  const installed = [
    { name: "server", owner: { login: "owner" }, id: 1 },
    { name: "client", owner: { login: "OWNER" }, id: 2 },
    { name: "csm-ci-actions", owner: { login: "owner" }, id: 3 },
    { name: "unconfigured", owner: { login: "owner" }, id: 4 },
  ];

  test("selects configured installed repositories and keeps the server last", () => {
    expect(discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server" })).toEqual({
      clients: [{ name: "owner/client", isServer: false }, { name: "owner/csm-ci-actions", isServer: false }, { name: "owner/unconfigured", isServer: false }],
      server: { name: "owner/server", isServer: true },
    });
  });

  test("a requested client does not implicitly select the server", () => {
    expect(discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", requestedRepository: "OWNER/client" })).toEqual({
      clients: [{ name: "owner/client", isServer: false }], server: null,
    });
  });

  test("selects an explicitly requested configured actions repository as a client", () => {
    expect(discoverRepoSettingsTargets({ config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", requestedRepository: "OWNER/csm-ci-actions" })).toEqual({
      clients: [{ name: "owner/csm-ci-actions", isServer: false }], server: null,
    });
  });

  const rejects: [string, Parameters<typeof discoverRepoSettingsTargets>[0], string][] = [
    ["server config identity mismatch", { config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/other" }, "server repository does not match the pinned configuration"],
    ["server not installed", { config: configWithSettings(), installedRepositories: installed.slice(1), serverRepository: "owner/server" }, "server repository owner/server is not installed"],
    ["server not configured", { config: configWithoutServer(), installedRepositories: installed, serverRepository: "owner/server" }, "server repository owner/server is not configured"],
    ["requested repository missing", { config: configWithSettings(), installedRepositories: installed, serverRepository: "owner/server", requestedRepository: "owner/missing" }, "requested repository owner/missing is not installed and configured"],
    ["requested actions repository not installed", { config: configWithSettings(), installedRepositories: installed.filter((repository) => repository.name !== "csm-ci-actions"), serverRepository: "owner/server", requestedRepository: "owner/csm-ci-actions" }, "requested repository owner/csm-ci-actions is not installed and configured"],
    ["requested actions repository not configured", { config: { ...configWithSettings(), repositories: [{ name: "owner/server", ops: [] }] }, installedRepositories: installed, serverRepository: "owner/server", requestedRepository: "owner/csm-ci-actions" }, "requested repository owner/csm-ci-actions is not installed and configured"],
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
  const repository = { default_branch: "main", delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" };
  const disabledControlled = {
    id: 81,
    name: "controlled-merges",
    source_type: "Repository",
    enforcement: "disabled",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update" }],
    bypass_actors: [{ actor_id: 1, actor_type: "Integration", bypass_mode: "pull_request" }],
  };

  test("plans the display branch ruleset only for the server", async () => {
    for (const isServer of [false, true]) {
      const name = isServer ? "server" : "client";
      const fetch = fakeFetch([{ method: "GET", path: `/repos/owner/${name}/rulesets`, body: [] }]);
      const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target: { name: `owner/${name}`, isServer }, mode: "schedule", targets: { settings: false, rulesets: true, releases: false } });
      expect(plan.changes.rulesets.includes("automerge-display")).toBe(isServer);
    }
    expect(repoSettingsRuleSets(config(), true).find((rule) => rule.name === "automerge-display")).toEqual({
      name: "automerge-display", enforcement: "active", target: "branch",
      conditions: { ref_name: { include: ["refs/heads/csm-ci/automerge"], exclude: [] } },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
      bypass_actors: [{ actor_id: config().apps.server_app_id, actor_type: "Integration", bypass_mode: "always" }],
    });
  });

  test("schedule preserves a disabled controlled-merges emergency stop", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: disabledControlled },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes.rulesets).not.toContain("controlled-merges");
    expect(plan.rulesetEnforcements["controlled-merges"]).toBe("disabled");
  });

  test("schedule does not create a missing controlled-merges ruleset", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
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
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes).toEqual({ settings: [], immutableReleases: false, sponsorships: false, rulesets: [] });
  });

  test("reports each drifted repository setting", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { ...repository, allow_auto_merge: false } },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(plan.changes.settings).toEqual(["allow_auto_merge"]);
  });

  test("rejects a repository setting hidden from the token", async () => {
    const { allow_auto_merge: _hidden, ...hidden } = repository;
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: hidden },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    await expect(inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" }))
      .rejects.toThrow("repository setting allow_auto_merge is not visible to the inspection token");
  });

  test("rejects a ruleset whose bypass actors are hidden from the token", async () => {
    const { bypass_actors: _hidden, ...hidden } = disabledControlled;
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: hidden },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    await expect(inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" }))
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
    await expect(inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" }))
      .rejects.toThrow("multiple Repository rulesets named controlled-merges");
  });

  test("non-missing immutable-release API errors propagate", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "GET", path: "/repos/owner/client/immutable-releases", status: 500, body: { message: "failure" } },
    ]);
    await expect(inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" })).rejects.toThrow();
  });

  type Body = Record<string, unknown>;
  const exactStateFetch = (options: { transform?: (body: Body) => Body; extraSummaries?: unknown[]; extraRoutes?: { method: string; path: string; body: unknown }[] } = {}) => {
    const desired = repoSettingsRuleSets(config());
    const summaries = desired.map((set, index) => ({ id: index + 1, name: set.name, source_type: "Repository" }));
    const rules = summaries.map((summary, index) => ({
      method: "GET",
      path: `/repos/owner/client/rulesets/${summary.id}`,
      body: (options.transform ?? ((body: Body) => body))({ ...desired[index], ...summary }),
    }));
    return fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [...summaries, ...(options.extraSummaries ?? [])] },
      ...rules,
      ...(options.extraRoutes ?? []),
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
  };
  const inspectSchedule = (fetch: ReturnType<typeof fakeFetch>) => inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });

  test("rules, required checks and bypass actors in another order compare equal", async () => {
    const reorder = (body: Body): Body => ({
      ...body,
      rules: [...(body.rules as { type: string; parameters?: Body }[])].reverse().map((rule) => rule.type === "required_status_checks" && rule.parameters
        ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...(rule.parameters.required_status_checks as unknown[])].reverse() } }
        : rule),
      bypass_actors: [...(body.bypass_actors as unknown[])].reverse(),
    });
    const plan = await inspectSchedule(exactStateFetch({ transform: reorder }));
    expect(plan.changes.rulesets).toEqual([]);
  });

  const drifts: [string, string, (body: Body) => Body][] = [
    ["a missing rule", "integrity", (body) => ({ ...body, rules: (body.rules as unknown[]).slice(1) })],
    ["a missing required check", "review-and-checks", (body) => ({
      ...body,
      rules: (body.rules as { type: string; parameters?: Body }[]).map((rule) => rule.type === "required_status_checks" && rule.parameters
        ? { ...rule, parameters: { ...rule.parameters, required_status_checks: (rule.parameters.required_status_checks as unknown[]).slice(1) } }
        : rule),
    })],
  ];
  test.each(drifts)("%s is reported as drift of %s", async (_name, ruleset, transform) => {
    const plan = await inspectSchedule(exactStateFetch({ transform: (body) => (body.name === ruleset ? transform(body) : body) }));
    expect(plan.changes.rulesets).toEqual([ruleset]);
  });

  test("a deploy-key bypass actor with a null actor_id is read as drift, not rejected", async () => {
    const withDeployKey = (body: Body): Body => (body.name === "integrity" ? { ...body, bypass_actors: [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }] } : body);
    const plan = await inspectSchedule(exactStateFetch({ transform: withDeployKey }));
    expect(plan.changes.rulesets).toEqual(["integrity"]);
  });

  test("a ruleset from another source with a managed name is ignored", async () => {
    const organization = { ...disabledControlled, id: 90, source_type: "Organization", enforcement: "active" };
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [
        { id: 81, name: "controlled-merges", source_type: "Repository" },
        { id: 90, name: "controlled-merges", source_type: "Organization" },
      ] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: disabledControlled },
      { method: "GET", path: "/repos/owner/client/rulesets/90", body: organization },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch" });
    expect(plan.rulesetIds["controlled-merges"]).toBe(81);
    expect(plan.rulesetEnforcements["controlled-merges"]).toBe("disabled");
    expect(fetch.calls).not.toContain("GET /repos/owner/client/rulesets/90");
  });

  test("an Organization ruleset never counts as the managed ruleset", async () => {
    const desired = repoSettingsRuleSets(config()).find((set) => set.name === "integrity");
    const organization = { ...desired, id: 90, source_type: "Organization" };
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 90, name: "integrity", source_type: "Organization" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/90", body: organization },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    ]);
    const plan = await inspectSchedule(fetch);
    expect(plan.rulesetIds.integrity).toBeUndefined();
    expect(plan.changes.rulesets).toContain("integrity");
  });

  test.each([
    ["disabled", "disabled"],
    ["evaluate", "evaluate"],
  ])("dispatch activation of a %s controlled-merges PUTs enforcement active", async (_name, enforcement) => {
    const fetch = dispatchFetch({ enforcement });
    const result = await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", approverAppSlug: "approver" });
    expect(result.rulesetsUpdated).toBe(1);
    const put = fetch.requests.find((request) => request.method === "PUT" && request.path === "/repos/owner/client/rulesets/81");
    expect(JSON.parse(put?.body ?? "{}")).toHaveProperty("enforcement", "active");
  });

  test("dispatch activation creates a missing controlled-merges ruleset with enforcement active", async () => {
    const fetch = dispatchFetch({ absent: true });
    await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", approverAppSlug: "approver" });
    const created = fetch.requests.filter((request) => request.method === "POST" && request.path === "/repos/owner/client/rulesets").map((request) => JSON.parse(request.body ?? "{}"));
    expect(created.find((body) => body.name === "controlled-merges")).toHaveProperty("enforcement", "active");
  });

  test.each([
    ["missing id", { name: "integrity" }],
    ["invalid id", { id: 0, name: "integrity" }],
    ["fractional id", { id: 1.5, name: "integrity" }],
    ["unsafe id", { id: Number.MAX_SAFE_INTEGER + 1, name: "integrity" }],
    ["string id", { id: "90", name: "integrity" }],
    ["invalid name", { id: 90, name: null }],
    ["wrong name", { id: 90, name: "wrong" }],
  ])("rejects a created ruleset response with %s", async (_name, createdResponse) => {
    const fetch = dispatchFetch({ absent: true, createdRulesetResponse: createdResponse });
    await expect(applyRepoSettings({
      readGH: github("read", fetch),
      adminGH: github("admin", fetch),
      config: configWithSettings(),
      target,
      mode: "dispatch",
      approverAppSlug: "approver",
    })).rejects.toThrow("created ruleset response for integrity did not include a valid id and matching name");
  });

  test("reports an earlier created ruleset before a later creation response fails validation", async () => {
    const fetch = dispatchFetch({ absent: true, createdRulesetResponse: { id: 90 }, laterCreatedRulesetResponses: [{ id: "invalid" }] });
    const created: { id: number; name: string }[] = [];
    await expect(applyRepoSettings({
      readGH: github("read", fetch),
      adminGH: github("admin", fetch),
      config: configWithSettings(),
      target,
      mode: "dispatch",
      approverAppSlug: "approver",
      onRulesetCreated: (ruleset) => created.push(ruleset),
    })).rejects.toThrow("created ruleset response for review-and-checks did not include a valid id and matching name");
    expect(created).toEqual([{ id: 90, name: "integrity" }]);
  });

  test("dispatch accepts an approver login that differs only in case", async () => {
    const fetch = dispatchFetch({ approverLogin: "Approver[BOT]" });
    const result = await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", approverAppSlug: "approver" });
    expect(result.rulesetsUpdated).toBe(1);
  });

  test.each([
    ["disabled", { enabled: false }, 1],
    ["not found", undefined, 1],
    ["enabled", { enabled: true }, 0],
  ] as const)("immutable releases that are %s are enabled only when needed", async (_name, state, expected) => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      ...(state ? [{ method: "GET", path: "/repos/owner/client/immutable-releases", body: state }] : []),
      { method: "PUT", path: "/repos/owner/client/immutable-releases", body: {} },
      { method: "POST", path: "/repos/owner/client/rulesets", body: { id: 90 } },
    ]);
    const result = await applyRepoSettings({ readGH: github("read", fakeFetch([])), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    expect(result.immutableReleasesEnabled).toBe(expected);
    expect(fetch.calls.filter((call) => call === "PUT /repos/owner/client/immutable-releases")).toHaveLength(expected);
  });

  const dispatchRejects: [string, DispatchOptions, string][] = [
    ["caller is not distributed", { event: "workflow_dispatch" }, "caller workflow has not been distributed"],
    ["caller job is conditional", { jobIf: "${{ github.event_name == 'push' }}" }, "caller workflow has not been distributed"],
    ["caller job has no secret mapping", { secretsLine: "" }, "caller workflow has not been distributed"],
    ["caller job maps an undeclared credential", { secretsLine: "secrets:\n      token: x" }, "caller workflow has not been distributed"],
    ["caller inherits all credentials", { secretsLine: "secrets: inherit" }, "caller workflow has not been distributed"],
    ["caller omits required name", { secretsLine: "secrets: {}" }, "caller workflow has not been distributed"],
    ["caller renames the required mapping", { secretsLine: "secrets:\n      TOKEN: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}" }, "caller workflow has not been distributed"],
    ["caller uses a literal credential", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: literal" }, "caller workflow has not been distributed"],
    ["caller maps another secret", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}" }, "caller workflow has not been distributed"],
    ["caller maps a non-string value", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: true" }, "caller workflow has not been distributed"],
    ["caller forwards an extra credential", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}\n      CSM_CI_OWNER_TOKEN: ${{ secrets.CSM_CI_OWNER_TOKEN }}" }, "caller workflow has not been distributed"],
    ["caller maps an array value", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: [\"${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}\"]" }, "caller workflow has not been distributed"],
    ["caller prefixes the secret expression", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: prefix${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}" }, "caller workflow has not been distributed"],
    ["caller suffixes the secret expression", { secretsLine: "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}suffix" }, "caller workflow has not been distributed"],
    ["caller trigger types omit created", { types: "[edited]" }, "caller workflow has not been distributed"],
    ["approver identity differs from config", { approverId: 999 }, "approver bot does not have write permission"],
    ["approver id matches but login differs", { approverLogin: "someone-else[bot]" }, "approver bot does not have write permission"],
    ["auto-merge queue is occupied", { queueCount: 1 }, "auto-merge queue is not empty"],
    ["controlled-merges has another bypass", { bypass: [{ actor_id: 99, actor_type: "Integration", bypass_mode: "pull_request" }] }, "controlled-merges bypass must contain only the Server App pull_request bypass"],
  ];
  test.each(dispatchRejects)("dispatch activation rejects %s before any write", async (_, options, message) => {
    const fetch = dispatchFetch(options);
    await expect(applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", approverAppSlug: "approver" })).rejects.toThrow(message);
    expect(fetch.calls.filter((call) => !call.startsWith("GET ") && call !== "POST /graphql")).toEqual([]);
  });

  test("dispatch activation requires the minted approver app slug", async () => {
    const fetch = dispatchFetch({});
    await expect(applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch" })).rejects.toThrow("approver App slug is required for dispatch preflight");
    expect(fetch.calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
  });

  test.each([
    ["absent", undefined, true],
    ["disabled", "disabled", true],
    ["evaluate", "evaluate", true],
    ["active", "active", false],
  ] as const)("dispatch with %s controlled-merges needs activation: %s", async (_name, enforcement, expected) => {
    const fetch = dispatchFetch({ queueCount: 1, ...(enforcement ? { enforcement } : { absent: true }) });
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch" });
    expect(plan.activation).toBe(expected);
  });

  test("dispatch repairs an active controlled-merges without the activation preflight", async () => {
    const fetch = dispatchFetch({ queueCount: 1, enforcement: "active", bypass: [{ actor_id: 99, actor_type: "Integration", bypass_mode: "always" }] });
    const result = await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch" });
    expect(result.rulesetsUpdated).toBe(1);
    expect(fetch.calls).not.toContain("POST /graphql");
    const put = fetch.requests.find((request) => request.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}")).not.toHaveProperty("enforcement");
  });

  test("schedule repairs controlled-merges without sending enforcement", async () => {
    const drifted = { ...disabledControlled, bypass_actors: [{ actor_id: 99, actor_type: "Integration", bypass_mode: "always" }] };
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: repository },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
      { method: "GET", path: "/repos/owner/client/rulesets/81", body: drifted },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
      { method: "PUT", path: "/repos/owner/client/rulesets/81", body: drifted },
      { method: "POST", path: "/repos/owner/client/rulesets", body: { id: 90 } },
    ]);
    await applyRepoSettings({ readGH: github("read", fakeFetch([])), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "schedule" });
    const put = fetch.requests.find((request) => request.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(put?.body ?? "{}")).not.toHaveProperty("enforcement");
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

describe("administrative target selection", () => {
  const target: RepoSettingsTarget = { name: "owner/client", isServer: false };
  const sponsorship = (enabled: boolean) => ({ data: { repository: { id: "R_1", hasSponsorshipsEnabled: enabled } } });
  // Every administrative target has drift: a setting, the Sponsor button, three missing rulesets, and immutable releases.
  function driftFetch() {
    return fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { default_branch: "main", delete_branch_on_merge: true, allow_auto_merge: false, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" } },
      { method: "PATCH", path: "/repos/owner/client", body: {} },
      { method: "POST", path: "/graphql", body: sponsorship(false), then: [sponsorship(false), { data: { updateRepository: { repository: { id: "R_1", hasSponsorshipsEnabled: true } } } }] },
      { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
      { method: "POST", path: "/repos/owner/client/rulesets", body: { id: 90 } },
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: false } },
      { method: "PUT", path: "/repos/owner/client/immutable-releases", body: {} },
    ]);
  }
  const config = () => parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { allow_auto_merge: true }, sponsorships: { enabled: true } }\n`);
  const reads = {
    settings: ["GET /repos/owner/client", "POST /graphql"],
    rulesets: ["GET /repos/owner/client/rulesets"],
    releases: ["GET /repos/owner/client/immutable-releases"],
  } as const;
  const writes = {
    settings: ["PATCH /repos/owner/client", "POST /graphql"],
    rulesets: ["POST /repos/owner/client/rulesets"],
    releases: ["PUT /repos/owner/client/immutable-releases"],
  } as const;

  test.each([
    ["settings", { settings: true, rulesets: false, releases: false }, { settingsUpdated: 1, sponsorshipsUpdated: 1, immutableReleasesEnabled: 0, rulesetsUpdated: 0, rulesetsCreated: 0 }],
    ["rulesets", { settings: false, rulesets: true, releases: false }, { settingsUpdated: 0, sponsorshipsUpdated: 0, immutableReleasesEnabled: 0, rulesetsUpdated: 0, rulesetsCreated: 3 }],
    ["releases", { settings: false, rulesets: false, releases: true }, { settingsUpdated: 0, sponsorshipsUpdated: 0, immutableReleasesEnabled: 1, rulesetsUpdated: 0, rulesetsCreated: 0 }],
    ["settings and releases", { settings: true, rulesets: false, releases: true }, { settingsUpdated: 1, sponsorshipsUpdated: 1, immutableReleasesEnabled: 1, rulesetsUpdated: 0, rulesetsCreated: 0 }],
    ["all", { settings: true, rulesets: true, releases: true }, { settingsUpdated: 1, sponsorshipsUpdated: 1, immutableReleasesEnabled: 1, rulesetsUpdated: 0, rulesetsCreated: 3 }],
    ["omitted (all)", undefined, { settingsUpdated: 1, sponsorshipsUpdated: 1, immutableReleasesEnabled: 1, rulesetsUpdated: 0, rulesetsCreated: 3 }],
  ] as const)("schedule apply with %s reads and writes only the selected targets", async (_name, targets, expected) => {
    const fetch = driftFetch();
    const result = await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: config(), target, mode: "schedule", ...(targets ? { targets } : {}) });
    expect(result).toEqual(expected);
    const selected = targets ?? { settings: true, rulesets: true, releases: true };
    for (const name of ["settings", "rulesets", "releases"] as const) {
      for (const call of [...reads[name], ...writes[name]]) {
        if (selected[name]) expect(fetch.calls).toContain(call);
        else expect(fetch.calls).not.toContain(call);
      }
    }
  });

  test("an unselected rulesets target skips controlled-merges activation and its preflight", async () => {
    const fetch = dispatchFetch({ absent: true });
    const plan = await inspectRepoSettings({ adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", targets: { settings: true, rulesets: false, releases: true } });
    expect(plan.activation).toBe(false);
    expect(plan.changes.rulesets).toEqual([]);
    // No approver slug is needed because activation is not attempted.
    await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", targets: { settings: true, rulesets: false, releases: true } });
    expect(fetch.calls).not.toContain("GET /repos/owner/client/rulesets");
    expect(fetch.calls).not.toContain("GET /users/approver%5Bbot%5D");
  });

  test("a selected rulesets target still requires the activation preflight on dispatch", async () => {
    const fetch = dispatchFetch({ absent: true });
    await expect(applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target, mode: "dispatch", targets: { settings: false, rulesets: true, releases: false } }))
      .rejects.toThrow("approver App slug is required for dispatch preflight");
  });
});

describe("repoSettingsRuleSets", () => {
  test("review-and-checks does not require branches to be up to date, because /merge never updates them", () => {
    const review = repoSettingsRuleSets(config()).find((set) => set.name === "review-and-checks");
    const checks = review?.rules.find((rule) => rule.type === "required_status_checks");
    expect(checks && "parameters" in checks ? checks.parameters.strict_required_status_checks_policy : undefined).toBe(false);
  });
});

describe("verifyRepoSettingsApprover", () => {
  test.each([
    ["a space", "approver bot"],
    ["a path separator", "approver/../x"],
    ["a bot suffix", "approver[bot]"],
    ["an empty slug", ""],
    ["a trailing newline", "approver\n"],
    ["an underscore", "approver_app"],
  ])("rejects a slug with %s before any request", async (_name, slug) => {
    const fetch = fakeFetch([]);
    await expect(verifyRepoSettingsApprover({ readGH: github("read", fetch), config: config(), approverAppSlug: slug })).rejects.toThrow("approver App slug is invalid");
    expect(fetch.calls).toEqual([]);
  });

  test.each([
    ["matching id and login", 4000, "approver[bot]", true],
    ["matching id and login in another case", 4000, "APPROVER[bot]", true],
    ["matching id with another login", 4000, "other[bot]", false],
    ["another id with matching login", 4001, "approver[bot]", false],
  ])("compares id and login: %s", async (_name, id, login, expected) => {
    const fetch = fakeFetch([{ method: "GET", path: "/users/approver-app%5Bbot%5D", body: { id, login } }]);
    expect(await verifyRepoSettingsApprover({ readGH: github("read", fetch), config: config(), approverAppSlug: "approver-app" })).toBe(expected);
  });
});

describe("auto-merge queue preflight", () => {
  const client: RepoSettingsTarget = { name: "owner/client", isServer: false };
  const auto = { autoMergeRequest: { __typename: "AutoMergeRequest" } };
  const manual = { autoMergeRequest: null };
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({ repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } });
  const queueFetch = (pages: unknown[]) => {
    const [first, ...rest] = pages;
    return fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { default_branch: "main" } },
      { method: "POST", path: "/graphql", body: { data: first }, then: rest.map((data) => ({ data })) },
    ]);
  };

  test("counts only pull requests with auto-merge enabled across pages and follows the cursor", async () => {
    const fetch = queueFetch([page([auto, manual, auto], true, "c1"), page([manual, auto], true, "c2"), page([manual], false, null)]);
    const result = await inspectRepoSettingsPreflight({ readGH: github("read", fetch), target: client });
    expect(result.autoMergeQueueCount).toBe(3);
    const cursors = fetch.requests.filter((request) => request.path === "/graphql").map((request) => JSON.parse(request.body ?? "{}").variables.cursor);
    expect(cursors).toEqual([null, "c1", "c2"]);
  });

  test.each([
    ["the Server bot", { __typename: "Bot" }],
    ["another bot", { __typename: "Bot" }],
    ["a user", { __typename: "User" }],
    ["an actor deleted after enabling auto-merge", null],
  ] satisfies [string, unknown][])("counts any auto-merge request enabled by %s", async (_name, enabledBy) => {
    const fetch = queueFetch([page([{ autoMergeRequest: { __typename: "AutoMergeRequest", enabledBy } }], false, null)]);
    const result = await inspectRepoSettingsPreflight({ readGH: github("read", fetch), target: client });
    expect(result.autoMergeQueueCount).toBe(1);
  });

  const unavailable: [string, unknown][] = [
    ["the repository is null", { repository: null }],
    ["the pull request connection is null", { repository: { pullRequests: null } }],
  ];
  test.each(unavailable)("rejects when %s", async (_name, data) => {
    await expect(inspectRepoSettingsPreflight({ readGH: github("read", queueFetch([data])), target: client }))
      .rejects.toThrow("repository owner/client is unavailable for auto-merge preflight");
  });

  const cursorFailures: [string, unknown[], string][] = [
    ["a next page without a cursor", [page([auto], true, null)], "GitHub returned a next page without a cursor"],
    ["a repeated cursor", [page([manual], true, "c1"), page([manual], true, "c1"), page([manual], false, null)], "GitHub repeated an auto-merge queue cursor"],
  ];
  test.each(cursorFailures)("fails on %s instead of looping or undercounting", async (_name, pages, message) => {
    await expect(inspectRepoSettingsPreflight({ readGH: github("read", queueFetch(pages)), target: client })).rejects.toThrow(message);
  });
});

describe("inspectRepoSettingsPreflight", () => {
  test.each([
    "${{secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY}}",
    "${{  secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY  }}",
  ])("accepts same-name expression whitespace %s", async (expression) => {
    const fetch = dispatchFetch({ secretsLine: `secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${expression}` });
    const result = await applyRepoSettings({ readGH: github("read", fetch), adminGH: github("admin", fetch), config: configWithSettings(), target: { name: "owner/client", isServer: false }, mode: "dispatch", approverAppSlug: "approver" });
    expect(result.rulesetsUpdated).toBe(1);
  });

  const serverSecret = "CSM_CI_SERVER_APP_PRIVATE_KEY";
  const optionalSecrets = ["CSM_CI_APPROVER_APP_PRIVATE_KEY", "CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY", "CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE"];
  const mapping = (name: string) => `${name}: \${{ secrets.${name} }}`;
  const serverMappings: [string, string, boolean][] = [
    ["required mapping only", `secrets:\n      ${mapping(serverSecret)}`, true],
    ["all feature mappings", `secrets:\n      ${[serverSecret, ...optionalSecrets].map(mapping).join("\n      ")}`, true],
    ["required mapping with whitespace", `secrets:\n      ${serverSecret}: \"\${{  secrets.CSM_CI_SERVER_APP_PRIVATE_KEY  }}\"`, true],
    ["inheritance", "secrets: inherit", false],
    ["no mapping", "", false],
    ["empty mapping", "secrets: {}", false],
    ["renamed required mapping", `secrets:\n      RENAMED: \${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}`, false],
    ["literal required mapping", `secrets:\n      ${serverSecret}: literal`, false],
    ["wrong required mapping", `secrets:\n      ${serverSecret}: \${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}`, false],
    ["extra credential", `secrets:\n      ${mapping(serverSecret)}\n      ${mapping("CSM_CI_OWNER_TOKEN")}`, false],
    ...optionalSecrets.flatMap((name): [string, string, boolean][] => [
      [`only optional ${name}`, `secrets:\n      ${mapping(name)}`, false],
      [`optional ${name}`, `secrets:\n      ${mapping(serverSecret)}\n      ${mapping(name)}`, true],
      [`wrong optional ${name}`, `secrets:\n      ${mapping(serverSecret)}\n      ${name}: \${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}`, false],
      [`literal optional ${name}`, `secrets:\n      ${mapping(serverSecret)}\n      ${name}: literal`, false],
      [`renamed optional ${name}`, `secrets:\n      ${mapping(serverSecret)}\n      RENAMED: \${{ secrets.${name} }}`, false],
    ]),
  ];
  test.each(serverMappings)("server label caller with %s is distributed: %s", async (_name, secretsLine, expected) => {
    const fetch = serverCallerPreflightFetch(["client-merge.yml", "server.yml"], secretsLine);
    const result = await inspectRepoSettingsPreflight({ readGH: github("read", fetch), target: { name: "owner/server", isServer: true } });
    expect(result.callerDistributed).toBe(expected);
  });

  test.each([
    ["owner and repository in another case", "Civitaspo/CSM-CI-Actions/.github/workflows/client-merge.yml@e2e", true],
    ["a workflow path in another case", "civitaspo/csm-ci-actions/.github/workflows/CLIENT-MERGE.yml@e2e", false],
    ["no ref", "civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@", false],
  ])("caller reference with %s counts as distributed: %s", async (_name, uses, expected) => {
    const workflow = `on:\n  issue_comment:\n    types: [created]\njobs:\n  merge:\n    uses: ${uses}\n    secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: \${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}\n`;
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { default_branch: "main" } },
      { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows", body: [{ name: "merge.yml", type: "file" }] },
      { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows%2Fmerge.yml", body: workflow },
      { method: "POST", path: "/graphql", body: { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
    ]);
    const result = await inspectRepoSettingsPreflight({ readGH: github("read", fetch), target: { name: "owner/client", isServer: false } });
    expect(result.callerDistributed).toBe(expected);
  });
});

describe("squash commit settings", () => {
  const target = { name: "owner/client", isServer: false };
  const desired = { allow_squash_merge: true, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" };
  function stateFetch(repository: Record<string, unknown>, then?: unknown[]) {
    const definitions = repoSettingsRuleSets(config());
    const summaries = definitions.map((set, index) => ({ id: index + 1, name: set.name, source_type: "Repository" }));
    return fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: { ...repository, delete_branch_on_merge: false }, ...(then ? { then } : {}) },
      { method: "GET", path: "/repos/owner/client/rulesets", body: summaries },
      ...summaries.map((summary, index) => ({ method: "GET", path: `/repos/owner/client/rulesets/${summary.id}`, body: { ...definitions[index], ...summary } })),
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
      { method: "PATCH", path: "/repos/owner/client", body: {} },
    ]);
  }
  const squashConfig = parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { allow_squash_merge: true } }\n`);
  test.each(["squash_merge_commit_title", "squash_merge_commit_message"])("rejects implied %s as a configuration key", (key) => {
    expect(() => parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { allow_squash_merge: true, ${key}: PR_TITLE } }\n`)).toThrow("Unrecognized key:");
  });
  test.each([
    ["title", { ...desired, squash_merge_commit_title: "COMMIT_OR_PR_TITLE" }, ["squash_merge_commit_title"]],
    ["message", { ...desired, squash_merge_commit_message: "COMMIT_MESSAGES" }, ["squash_merge_commit_message"]],
    ["blank message", { ...desired, squash_merge_commit_message: "BLANK" }, ["squash_merge_commit_message"]],
    ["both", { ...desired, squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "BLANK" }, ["squash_merge_commit_title", "squash_merge_commit_message"]],
    ["disabled squash", { ...desired, allow_squash_merge: false }, ["allow_squash_merge"]],
  ])("reports and repairs %s drift, then makes no settings write on replay", async (_name, repository, changes) => {
    const fetch = stateFetch(repository, [repository, desired]);
    const adminGH = github("admin", fetch);
    const inspection = await inspectRepoSettings({ adminGH, config: squashConfig, target, mode: "schedule" });
    expect(inspection.changes.settings).toEqual(changes);
    const args = { adminGH, readGH: github("read", fakeFetch([])), config: squashConfig, target, mode: "schedule" as const };
    expect((await applyRepoSettings(args)).settingsUpdated).toBe(1);
    const writes = fetch.requests.filter((request) => request.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual(desired);
    expect((await applyRepoSettings(args)).settingsUpdated).toBe(0);
    expect(fetch.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  test.each(["squash_merge_commit_title", "squash_merge_commit_message"])("rejects missing %s before writes", async (key) => {
    const repository: Record<string, unknown> = { ...desired };
    delete repository[key];
    const fetch = stateFetch(repository);
    const args = { adminGH: github("admin", fetch), readGH: github("read", fakeFetch([])), config: squashConfig, target, mode: "schedule" as const };
    await expect(inspectRepoSettings(args)).rejects.toThrow(`repository setting ${key} is not visible to the inspection token`);
    await expect(applyRepoSettings(args)).rejects.toThrow(`repository setting ${key} is not visible to the inspection token`);
    expect(fetch.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test.each([
    ["omitted squash", "repo_settings: { settings: { delete_branch_on_merge: true } }", 1],
    ["empty settings", "repo_settings: { settings: {} }", 0],
    ["omitted settings", "repo_settings: {}", 0],
  ])("%s leaves missing or drifted squash commit settings unmanaged", async (_name, yaml, writes) => {
    for (const repository of [{ allow_squash_merge: true }, { ...desired, squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "BLANK" }]) {
      const fetch = stateFetch(repository);
      const cfg = parseConfig(`${CONFIG_YAML}\n${yaml}\n`);
      const adminGH = github("admin", fetch);
      const inspection = await inspectRepoSettings({ adminGH, config: cfg, target, mode: "schedule" });
      expect(inspection.changes.settings).toEqual(writes ? ["delete_branch_on_merge"] : []);
      const result = await applyRepoSettings({ adminGH, readGH: github("read", fakeFetch([])), config: cfg, target, mode: "schedule" });
      expect(result.settingsUpdated).toBe(writes);
      const updates = fetch.requests.filter((request) => request.method === "PATCH");
      expect(updates).toHaveLength(writes);
      if (writes) expect(JSON.parse(updates[0]?.body ?? "{}")).toEqual({ delete_branch_on_merge: true });
    }
  });
});

function configWithSettings() {
  return parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false } }\n`);
}

function configWithoutServer() {
  return parseConfig(`${CONFIG_YAML.replace("name: owner/*", "name: owner/client")}\nrepo_settings: {}\n`);
}

type DispatchOptions = {
  event?: string;
  types?: string;
  jobIf?: string;
  secretsLine?: string;
  approverId?: number;
  approverLogin?: string;
  queueCount?: number;
  enforcement?: string;
  absent?: boolean;
  bypass?: { actor_id: number; actor_type: string; bypass_mode: string }[];
  createdRulesetResponse?: unknown;
  laterCreatedRulesetResponses?: unknown[];
};

function dispatchFetch(options: DispatchOptions) {
  const secretsLine = options.secretsLine ?? "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}";
  const workflow = `on:\n  ${options.event ?? "issue_comment"}:\n    types: ${options.types ?? "[created]"}\njobs:\n  merge:\n    uses: civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@e2e${secretsLine ? `\n    ${secretsLine}` : ""}${options.jobIf ? `\n    if: ${options.jobIf}` : ""}\n`;
  const controlled = {
    id: 81,
    name: "controlled-merges",
    source_type: "Repository",
    enforcement: options.enforcement ?? "disabled",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update" }],
    bypass_actors: options.bypass ?? [{ actor_id: 1, actor_type: "Integration", bypass_mode: "pull_request" }],
  };
  return fakeFetch([
    { method: "GET", path: "/repos/owner/client", body: { default_branch: "main", delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" } },
    { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows", body: [{ name: "merge.yml", type: "file" }] },
    { method: "GET", path: "/repos/owner/client/contents/.github%2Fworkflows%2Fmerge.yml", body: workflow },
    { method: "GET", path: "/repos/owner/client/rulesets", body: options.absent ? [] : [{ id: 81, name: "controlled-merges", source_type: "Repository" }] },
    { method: "GET", path: "/repos/owner/client/rulesets/81", body: controlled },
    { method: "PUT", path: "/repos/owner/client/rulesets/81", body: controlled },
    { method: "POST", path: "/repos/owner/client/rulesets", body: options.createdRulesetResponse ?? { id: 90 }, ...(options.laterCreatedRulesetResponses ? { then: options.laterCreatedRulesetResponses } : {}) },
    { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    { method: "GET", path: "/users/approver%5Bbot%5D", body: { id: options.approverId ?? 4000, login: options.approverLogin ?? "approver[bot]" } },
    {
      method: "POST",
      path: "/graphql",
      body: {
        data: {
          repository: {
            pullRequests: {
              nodes: Array.from({ length: options.queueCount ?? 0 }, () => ({ autoMergeRequest: { __typename: "AutoMergeRequest" } })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ]);
}

function serverCallerPreflightFetch(filenames: readonly string[], serverSecretsLine = "secrets:\n      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}") {
  const workflows = filenames.map((filename) => {
    const event = filename === "server.yml" ? "label" : "issue_comment";
    return {
      method: "GET",
      path: `/repos/owner/server/contents/.github%2Fworkflows%2F${filename}`,
      body: `on:\n  ${event}:\n    types: [created]\njobs:\n  run:\n    uses: civitaspo/csm-ci-actions/.github/workflows/${filename}@e2e\n    ${filename === "server.yml" ? serverSecretsLine : "secrets:\n      CSM_CI_CLIENT_APP_PRIVATE_KEY: \${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}"}\n`,
    };
  });
  return fakeFetch([
    { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
    { method: "GET", path: "/repos/owner/server/contents/.github%2Fworkflows", body: filenames.map((name) => ({ name, type: "file" })) },
    ...workflows,
    { method: "POST", path: "/graphql", body: { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
  ]);
}

describe("repository feature settings", () => {
  const target = { name: "owner/client", isServer: false };
  const keys = ["has_wiki", "has_projects", "allow_update_branch"] as const;
  const cases = keys.flatMap((key) => [true, false].map((value) => ({ key, value })));
  const cfg = (settings: Record<string, unknown>) => parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: ${JSON.stringify(settings)} }\n`);
  function stateFetch(repository: Record<string, unknown>, options: { then?: unknown[]; readStatus?: number; updateStatus?: number } = {}) {
    const definitions = repoSettingsRuleSets(config());
    const summaries = definitions.map((set, index) => ({ id: index + 1, name: set.name, source_type: "Repository" }));
    return fakeFetch([
      { method: "GET", path: "/repos/owner/client", body: options.readStatus ? { message: "feature read rejected" } : repository, status: options.readStatus ?? 200, ...(options.then ? { then: options.then } : {}) },
      { method: "GET", path: "/repos/owner/client/rulesets", body: summaries },
      ...summaries.map((summary, index) => ({ method: "GET", path: `/repos/owner/client/rulesets/${summary.id}`, body: { ...definitions[index], ...summary } })),
      { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
      { method: "PATCH", path: "/repos/owner/client", body: { message: "feature update rejected" }, status: options.updateStatus ?? 200 },
    ]);
  }
  function args(fetch: ReturnType<typeof fakeFetch>, settings: Record<string, unknown>) {
    return { adminGH: github("admin", fetch, { backoffMs: [] }), readGH: github("read", fakeFetch([])), config: cfg(settings), target, mode: "schedule" as const };
  }

  test.each(cases)("accepts $key=$value without defaulting other fields", ({ key, value }) => {
    expect(cfg({ [key]: value }).repo_settings?.settings).toEqual({ [key]: value });
  });
  test.each(keys.flatMap((key) => ["false", 0, null, [], {}].map((value) => ({ key, value }))))("rejects non-boolean $key=$value", ({ key, value }) => {
    expect(() => cfg({ [key]: value })).toThrow("Invalid input: expected boolean");
  });

  test.each(cases)("reports and repairs $key=$value drift and makes no write on replay", async ({ key, value }) => {
    const desired = { [key]: value };
    const drifted = { [key]: !value, description: "unrelated" };
    const fetch = stateFetch(drifted, { then: [drifted, desired] });
    const options = args(fetch, desired);
    expect((await inspectRepoSettings(options)).changes).toEqual({ settings: [key], rulesets: [], immutableReleases: false, sponsorships: false });
    expect(await applyRepoSettings(options)).toEqual({ settingsUpdated: 1, sponsorshipsUpdated: 0, immutableReleasesEnabled: 0, rulesetsUpdated: 0, rulesetsCreated: 0 });
    expect((await applyRepoSettings(options)).settingsUpdated).toBe(0);
    const writes = fetch.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PATCH");
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual(desired);
  });

  test.each(keys)("rejects a missing configured %s before writes", async (key) => {
    const fetch = stateFetch({});
    const options = args(fetch, { [key]: false });
    const message = `repository setting ${key} is not visible to the inspection token`;
    await expect(inspectRepoSettings(options)).rejects.toThrow(message);
    await expect(applyRepoSettings(options)).rejects.toThrow(message);
    expect(fetch.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test.each(keys)("revalidates %s before apply after an earlier successful inspection", async (key) => {
    const fetch = stateFetch({ [key]: false }, { then: [{}] });
    const options = args(fetch, { [key]: true });
    expect((await inspectRepoSettings(options)).changes.settings).toEqual([key]);
    await expect(applyRepoSettings(options)).rejects.toThrow(`repository setting ${key} is not visible to the inspection token`);
    expect(fetch.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test.each(keys)("fresh matching %s avoids a stale planned write", async (key) => {
    const fetch = stateFetch({ [key]: false }, { then: [{ [key]: true }] });
    const options = args(fetch, { [key]: true });
    expect((await inspectRepoSettings(options)).changes.settings).toEqual([key]);
    expect((await applyRepoSettings(options)).settingsUpdated).toBe(0);
    expect(fetch.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test.each([{}, { has_wiki: false, has_projects: true, allow_update_branch: false }])("omitted features remain unmanaged: %j", async (repository) => {
    const fetch = stateFetch({ ...repository, delete_branch_on_merge: false });
    const options = args(fetch, { delete_branch_on_merge: true });
    expect((await inspectRepoSettings(options)).changes.settings).toEqual(["delete_branch_on_merge"]);
    expect((await applyRepoSettings(options)).settingsUpdated).toBe(1);
    const writes = fetch.requests.filter((request) => request.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({ delete_branch_on_merge: true });
  });

  test.each(keys.flatMap((key) => [403, 404, 422, 503].flatMap((status) => ["read", "update"].map((stage) => ({ key, status, stage })))))("surfaces $stage API failure $status for $key", async ({ key, status, stage }) => {
    const fetch = stateFetch({ [key]: false }, stage === "read" ? { readStatus: status } : { updateStatus: status });
    await expect(applyRepoSettings(args(fetch, { [key]: true }))).rejects.toThrow(stage === "read" ? "feature read rejected" : "feature update rejected");
    expect(fetch.requests.filter((request) => request.method === "PATCH")).toHaveLength(stage === "read" ? 0 : 1);
    expect(fetch.requests.filter((request) => request.method === "PUT" || request.method === "POST")).toHaveLength(0);
  });

  test("branch update suggestions do not require up-to-date branches", () => {
    const rule = repoSettingsRuleSets(cfg({ allow_update_branch: true })).find((set) => set.name === "review-and-checks")?.rules.find((item) => item.type === "required_status_checks");
    expect(rule).toHaveProperty("parameters.strict_required_status_checks_policy", false);
  });
});
