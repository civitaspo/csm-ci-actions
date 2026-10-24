import { describe, expect, test } from "bun:test";
import { type Op, parseConfig, repositoryEntry } from "./config.ts";
import { CONFIG_YAML, config } from "./testing.ts";

describe("parseConfig", () => {
  test("accepts the fixture and lowercases names", () => {
    const c = config();
    expect(c.owners).toEqual(["owner"]);
    expect(c.server_repository).toBe("owner/server");
    expect(c.merge.deadline_minutes).toBe(60);
  });

  const rejects: [string, string, RegExp][] = [
    ["unknown top-level key", `${CONFIG_YAML}\nextra: 1\n`, /extra/],
    ["unknown policy type", CONFIG_YAML.replace("signed-commits", "no-such-policy"), /policies/],
    ["unknown sensitive-paths key", CONFIG_YAML.replace("type: signed-commits", "type: sensitive-paths, paths: [Makefile], extra: true"), /extra/],
    ["server bot as trusted committer", CONFIG_YAML.replace("committers: [{ id: 10, login: alice }", "committers: [{ id: 3000, login: alice }"), /must not be in a trust list/],
    ["approver bot as trusted committer", CONFIG_YAML.replace("committers: [{ id: 10, login: alice }", "committers: [{ id: 4000, login: alice }"), /must not be in a trust list/],
    ["server bot as approver", CONFIG_YAML.replace("approvers: [{ id: 10, login: alice }]", "approvers: [{ id: 3000, login: alice }]"), /must not be in a trust list/],
    ["missing approver", CONFIG_YAML.replace(/approver: \{[^\n]*\n/, ""), /approver/],
    ["server bot as bot merger", CONFIG_YAML.replace("bot_mergers: [{ id: 20, login: \"renovate[bot]\" }]", "bot_mergers: [{ id: 3000, login: \"renovate[bot]\" }]"), /must not be in a trust list/],
    ["server repository outside owners", CONFIG_YAML.replace("Owner/Server", "Other/Server"), /owner must be listed in owners/],
    ["duplicate op", CONFIG_YAML.replace("ops: [approve, merge, policy-check]", "ops: [approve, approve]"), /duplicate op/],
    ["unknown op", CONFIG_YAML.replace("ops: [approve, merge, policy-check]", "ops: [deploy]"), /ops/],
    ["non-positive id", CONFIG_YAML.replace("client_bot_id: 2000", "client_bot_id: 0"), /client_bot_id/],
    ["missing repositories", CONFIG_YAML.replace(/repositories:[\s\S]*$/, "repositories: []\n"), /repositories/],
    ["malformed server repository", CONFIG_YAML.replace("Owner/Server", "Owner"), /server_repository/],
    ["securefix enabled without settings", CONFIG_YAML.replace("ops: [approve, merge, policy-check]", "ops: [approve, merge, policy-check, securefix]"), /securefix settings are required/],
    ["duplicate securefix route name", CONFIG_YAML.replace("repositories:", "securefix:\n  allow_workflow_changes: false\n  routes:\n    - { name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }\n    - { name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }\nrepositories:"), /duplicate route name/],
    ["unsafe securefix route path", CONFIG_YAML.replace("repositories:", "securefix:\n  allow_workflow_changes: false\n  routes:\n    - { name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { ../README.md: any } }\nrepositories:"), /safe relative path/],
    ["unknown securefix route key", CONFIG_YAML.replace("repositories:", "securefix:\n  allow_workflow_changes: false\n  routes:\n    - { name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any }, extra: true }\nrepositories:"), /extra/],
    ["securefix unknown key", CONFIG_YAML.replace("repositories:", "securefix:\n  allow_workflow_changes: false\n  routes: []\n  extra: true\nrepositories:"), /extra/],
    ["invalid securefix route name", routeConfig("{ name: Release_PR, from: default, to: release/stable, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }"), /must match pattern/],
    ["securefix route from must be default", routeConfig("{ name: release-pr, from: release/next, to: release/stable, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }"), /Invalid input/],
    ["empty securefix target branch", routeConfig("{ name: release-pr, from: default, to: '', workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }"), /Too small/],
    ...[
      ["default", /safe branch name/],
      ["-release", /safe branch name/],
      ["release/", /safe branch name/],
      ["release..next", /safe branch name/],
      ["release//next", /safe branch name/],
      ["release@{next}", /safe branch name/],
      ["HEAD", /safe branch name/],
      ["release/.hidden", /safe branch name/],
      ["release/file.lock", /safe branch name/],
      ["release?next", /safe branch name/],
    ].map(([branch, message]) => [`unsafe securefix target branch ${branch}`, routeConfig(`{ name: release-pr, from: default, to: '${branch}', workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: any } }`), message] as [string, string, RegExp]),
    ["empty securefix workflow", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: '', paths: { CHANGELOG.md: any } }"), /Too small/],
    ["unsafe securefix workflow path", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: ../workflow.yml, paths: { CHANGELOG.md: any } }"), /safe path under .github\/workflows/],
    ["securefix workflow outside workflows directory", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: .github/actions/release.yml, paths: { CHANGELOG.md: any } }"), /safe path under .github\/workflows/],
    ["empty securefix path map", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: {} }"), /at least one path/],
    ["empty securefix path glob", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { '': any } }"), /safe relative path or glob/],
    ...[
      "../README.md",
      "/README.md",
      "src\\README.md",
      ".git/config",
      "src//README.md",
      "./README.md",
      "src/../README.md",
    ].map((path) => [`unsafe securefix path glob ${JSON.stringify(path)}`, routeConfig(`{ name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { '${path}': any } }`), /safe relative path or glob/] as [string, string, RegExp]),
    ...["!README.md", "src/!(generated).ts", "src/[!a].ts"].map((path) => [`negated securefix path glob ${path}`, routeConfig(`{ name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { '${path}': any } }`), /safe relative path or glob/] as [string, string, RegExp]),
    ["unknown securefix path rule", routeConfig("{ name: release-pr, from: default, to: release/next, workflow: .github/workflows/release-pr.yml, paths: { CHANGELOG.md: no-such-rule } }"), /Invalid option/],
  ];
  test.each(rejects)("rejects %s", (_, yaml, message) => {
    expect(() => parseConfig(yaml)).toThrow(message);
  });
});

function routeConfig(route: string): string {
  return CONFIG_YAML.replace("repositories:", `securefix:\n  allow_workflow_changes: false\n  routes:\n    - ${route}\nrepositories:`);
}

describe("repositoryEntry", () => {
  const cases: [string, string, Op[] | undefined][] = [
    ["glob match, case-insensitive", "Owner/Repo", ["approve", "merge", "policy-check"]],
    ["first match wins", "owner/no-ops", []],
    ["owner not listed", "other/repo", undefined],
    ["owner prefix is not enough", "owner-evil/repo", undefined],
  ];
  test.each(cases)("%s", (_, name, ops) => {
    expect(repositoryEntry(config(), name)?.ops).toEqual(ops);
  });

  test("owners bound even a catch-all glob", () => {
    const c = parseConfig(CONFIG_YAML.replace("name: owner/*", "name: '*/*'"));
    expect(repositoryEntry(c, "owner/repo")?.ops).toEqual(["approve", "merge", "policy-check"]);
    expect(repositoryEntry(c, "other/repo")).toBeUndefined();
  });
});
