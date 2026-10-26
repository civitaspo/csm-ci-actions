import { describe, expect, test } from "bun:test";
import { parseConfig, repoSettingsManagedFiles } from "./config.ts";
import { github } from "./github.ts";
import { applyRepoSettings, inspectRepoSettings, repoSettingsRuleSets } from "./repo-settings.ts";
import { CONFIG_YAML, config, fakeFetch } from "./testing.ts";

function configured(sponsorships: unknown, files = {}) {
  return parseConfig(`${CONFIG_YAML}\nrepo_settings: ${JSON.stringify({ sponsorships, managed_files: files })}\n`);
}

describe("sponsorship configuration and generated funding", () => {
  test.each([true, false])("generates ordered normalized recipients with enabled=%s", (enabled) => {
    const cfg = configured({ enabled, github: ["One-User", "TWO", "3", "a".repeat(39)] }, { "README.md": "keep" });
    expect(cfg.repo_settings?.sponsorships).toEqual({ enabled, github: ["one-user", "two", "3", "a".repeat(39)] });
    expect(repoSettingsManagedFiles(cfg.repo_settings)).toEqual({ "README.md": "keep", ".github/FUNDING.yml": `github: ["one-user", "two", "3", "${"a".repeat(39)}"]\n` });
  });
  test.each([undefined, { enabled: true }, { enabled: false }])("omitted recipients preserve literal funding ownership: %j", (sponsorships) => {
    const cfg = configured(sponsorships, { ".github/FUNDING.yml": "custom: existing\n" });
    expect(repoSettingsManagedFiles(cfg.repo_settings)).toEqual({ ".github/FUNDING.yml": "custom: existing\n" });
    expect(repoSettingsManagedFiles(configured(sponsorships).repo_settings)).toEqual({});
  });
  test("an omitted block generates no files", () => expect(repoSettingsManagedFiles(undefined)).toEqual({}));

  const rejects: [string, unknown, string][] = [
    ["required enabled", {}, "Invalid input: expected boolean"],
    ["boolean enabled", { enabled: "true" }, "Invalid input: expected boolean"],
    ["strict block", { enabled: true, extra: true }, "Unrecognized key"],
    ["list type", { enabled: true, github: "user" }, "Invalid input: expected array"],
    ["empty list", { enabled: true, github: [] }, "Too small"],
    ["too many recipients", { enabled: true, github: ["a", "b", "c", "d", "e"] }, "Too big"],
    ["duplicate recipients", { enabled: true, github: ["User", "USER"] }, "duplicate GitHub recipient login"],
    ["long recipient", { enabled: true, github: ["x".repeat(40)] }, "Too big"],
    ...["", " ", " user", "user ", "@user", "https://github.com/user", "-user", "user-", "two--parts", "user_name", "é"].map((login): [string, unknown, string] => [
      `invalid recipient ${JSON.stringify(login)}`, { enabled: true, github: [login] }, "must be a GitHub recipient login",
    ]),
  ];
  test.each(rejects)("rejects %s with its message", (_name, value, message) => {
    expect(() => configured(value)).toThrow(String(message));
  });
  test.each([true, false])("rejects a funding producer collision even for identical bytes, enabled=%s", (enabled) => {
    expect(() => configured({ enabled, github: ["user"] }, { ".github/FUNDING.yml": 'github: ["user"]\n' })).toThrow("destination is reserved by sponsorships.github");
  });
  test.each([
    ["count", Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`file-${index}`, ""])), "must contain at most 512 files"],
    ["bytes", { a: "x".repeat(8 * 1024 * 1024), b: "x".repeat(2 * 1024 * 1024) }, "total file content must be at most 10 MiB"],
    ["parent", { ".github": "file" }, "file paths must not contain a file as a directory prefix"],
    ["child", { ".github/FUNDING.yml/child": "file" }, "file paths must not contain a file as a directory prefix"],
  ])("includes generated funding in combined %s validation", (_name, files, message) => {
    expect(() => configured({ enabled: false, github: ["user"] }, files)).toThrow(message);
  });
  test("accepts the inclusive combined count and bytes limit", () => {
    const funding = 'github: ["user"]\n';
    const files = { a: "x".repeat(8 * 1024 * 1024), b: "x".repeat(2 * 1024 * 1024 - funding.length), ...Object.fromEntries(Array.from({ length: 509 }, (_, index) => [`file-${index}`, ""])) };
    expect(Object.keys(repoSettingsManagedFiles(configured({ enabled: false, github: ["user"] }, files).repo_settings))).toHaveLength(512);
  });
});

function administrativeFetch(graphql: typeof globalThis.fetch) {
  const definitions = repoSettingsRuleSets(config());
  const summaries = definitions.map((set, index) => ({ id: index + 1, name: set.name, source_type: "Repository" }));
  const rest = fakeFetch([
    { method: "GET", path: "/repos/owner/client", body: {} },
    { method: "GET", path: "/repos/owner/client/rulesets", body: summaries },
    ...summaries.map((summary, index) => ({ method: "GET", path: `/repos/owner/client/rulesets/${summary.id}`, body: { ...definitions[index], ...summary } })),
    { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
  ]);
  const fetch = Object.assign((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => String(input).endsWith("/graphql") ? graphql(input, init) : rest(input, init), { preconnect: globalThis.fetch.preconnect });
  return fetch;
}
function options(fetch: typeof globalThis.fetch, enabled?: boolean) {
  return { adminGH: github("admin", administrativeFetch(fetch), { backoffMs: [] }), readGH: github("read", fakeFetch([])), config: configured(enabled === undefined ? undefined : { enabled }), target: { name: "owner/client", isServer: false }, mode: "schedule" as const };
}
const state = (enabled: boolean) => ({ id: "REPO_NODE", hasSponsorshipsEnabled: enabled });
const queryResponse = (repository: unknown) => ({ data: { repository } });
const mutationResponse = (repository: unknown) => ({ data: { updateRepository: { repository } } });

describe("sponsorship administration", () => {
  test.each([true, false])("reports and repairs enabled=%s with independent results; replay is a no-op", async (enabled) => {
    const fetch = fakeFetch([{ method: "POST", path: "/graphql", body: queryResponse(state(!enabled)), then: [queryResponse(state(!enabled)), queryResponse(state(!enabled)), mutationResponse(state(enabled)), queryResponse(state(enabled))] }]);
    const args = options(fetch, enabled);
    expect((await inspectRepoSettings(args)).changes.sponsorships).toBe(true);
    expect(await applyRepoSettings(args)).toEqual({ settingsUpdated: 0, sponsorshipsUpdated: 1, immutableReleasesEnabled: 0, rulesetsUpdated: 0, rulesetsCreated: 0 });
    expect((await applyRepoSettings(args)).sponsorshipsUpdated).toBe(0);
    const writes = fetch.requests.filter((request) => JSON.parse(request.body ?? "{}").query.startsWith("mutation"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toMatchObject({ variables: { repositoryId: "REPO_NODE", enabled } });
  });
  test("omission makes no sponsorship read or mutation", async () => {
    const fetch = fakeFetch([]);
    expect((await applyRepoSettings(options(fetch))).sponsorshipsUpdated).toBe(0);
    expect(fetch.requests).toHaveLength(0);
  });
  test("fresh matching state avoids a stale write", async () => {
    const fetch = fakeFetch([{ method: "POST", path: "/graphql", body: queryResponse(state(false)), then: [queryResponse(state(true))] }]);
    expect((await applyRepoSettings(options(fetch, true))).sponsorshipsUpdated).toBe(0);
    expect(fetch.requests).toHaveLength(2);
  });
  test.each([null, {}, { id: "", hasSponsorshipsEnabled: true }, { id: "node" }, { id: "node", hasSponsorshipsEnabled: "true" }])("rejects invalid setting %j before writes", async (repository) => {
    const fetch = fakeFetch([{ method: "POST", path: "/graphql", body: queryResponse(repository) }]);
    await expect(applyRepoSettings(options(fetch, true))).rejects.toThrow("repository sponsorship setting is unavailable or invalid");
    expect(fetch.requests).toHaveLength(1);
  });
  test("revalidates immediately before mutation", async () => {
    const fetch = fakeFetch([{ method: "POST", path: "/graphql", body: queryResponse(state(false)), then: [queryResponse(null)] }]);
    await expect(applyRepoSettings(options(fetch, true))).rejects.toThrow("repository sponsorship setting is unavailable or invalid");
    expect(fetch.requests).toHaveLength(2);
  });
  test.each([null, {}, state(false), { ...state(true), id: "OTHER" }])("rejects unconfirmed mutation %j", async (repository) => {
    const fetch = fakeFetch([{ method: "POST", path: "/graphql", body: queryResponse(state(false)), then: [queryResponse(state(false)), mutationResponse(repository)] }]);
    await expect(applyRepoSettings(options(fetch, true))).rejects.toThrow("sponsorship mutation did not confirm the requested repository setting");
    expect(fetch.requests).toHaveLength(3);
  });
  test.each(["read", "mutation"])("propagates %s errors and reads current state on the next invocation", async (stage) => {
    let current = false;
    let fail = true;
    let writes = 0;
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const mutation = JSON.parse(String(init?.body)).query.startsWith("mutation");
      if (mutation) { writes++; current = true; }
      if (fail && ((stage === "read" && !mutation) || (stage === "mutation" && mutation))) {
        fail = false;
        throw new TypeError("lost response");
      }
      return Response.json(mutation ? mutationResponse(state(current)) : queryResponse(state(current)));
    }, { preconnect: globalThis.fetch.preconnect });
    const args = options(fetch, true);
    await expect(applyRepoSettings(args)).rejects.toThrow("lost response");
    expect(writes).toBe(stage === "read" ? 0 : 1);
    expect((await applyRepoSettings(args)).sponsorshipsUpdated).toBe(stage === "read" ? 1 : 0);
    expect(writes).toBe(1);
  });
});
