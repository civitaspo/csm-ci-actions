import { describe, expect, test } from "bun:test";
import { type Op, type Release, parseConfig, repositoryEntry } from "./config.ts";
import { CONFIG_YAML, config } from "./testing.ts";

describe("parseConfig", () => {
  test("accepts the fixture and lowercases names", () => {
    const c = config();
    expect(c.owners).toEqual(["owner"]);
    expect(c.server_repository).toBe("owner/server");
  });

  test("accepts global repository settings and defaults managed files", () => {
    const parsed = parseConfig(`${CONFIG_YAML}\nrepo_settings: { settings: { delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false } }\n`);
    expect(parsed.repo_settings?.additional_managed_files).toEqual({});
    expect(parsed.repo_settings?.settings?.allow_squash_merge).toBe(true);
  });

  const rejects: [string, string, RegExp][] = [
    ["unknown top-level key", `${CONFIG_YAML}\nextra: 1\n`, /extra/],
    ["unknown repo settings key", `${CONFIG_YAML}\nrepo_settings: { extra: true }\n`, /extra/],
    ["repo settings cannot enable merge methods outside squash", `${CONFIG_YAML}\nrepo_settings: { settings: { delete_branch_on_merge: true, allow_auto_merge: true, allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false } }\n`, /Invalid input/],
    ["repo settings cannot disable squash merge", `${CONFIG_YAML}\nrepo_settings: { settings: { allow_squash_merge: false } }\n`, /Invalid input/],
    ["repo settings cannot enable rebase merge", `${CONFIG_YAML}\nrepo_settings: { settings: { allow_rebase_merge: true } }\n`, /Invalid input/],
    ["managed files reject unsafe paths", `${CONFIG_YAML}\nrepo_settings: { additional_managed_files: { '../README.md': nope } }\n`, /safe literal relative file path/],
    ["managed files reject globs", `${CONFIG_YAML}\nrepo_settings: { additional_managed_files: { 'src/*.ts': nope } }\n`, /safe literal relative file path/],
    ["managed files reject prefix collisions", `${CONFIG_YAML}\nrepo_settings: { additional_managed_files: { 'a': one, 'a/b': two } }\n`, /file paths must not contain a file as a directory prefix/],
    ...["", "C:/absolute", ".git/config", "src\\\\file", "/absolute", "./relative", "src//file", "bad\\u0001path"].map((path) => [
      `managed file path rejects ${JSON.stringify(path)}`,
      `${CONFIG_YAML}\nrepo_settings: { additional_managed_files: { ${JSON.stringify(path)}: value } }\n`,
      /safe literal relative file path/,
    ] as [string, string, RegExp]),
    ["managed files reject more than 512 files", `${CONFIG_YAML}\nrepo_settings: { additional_managed_files: ${JSON.stringify(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`file-${index}`, "source"])))} }\n`, /must contain at most 512 files/],
    ["the removed merge deadline", CONFIG_YAML.replace("required_checks: [{ name: status-check, app_id: 15368 }]", "required_checks: [{ name: status-check, app_id: 15368 }]\n  deadline_minutes: 60"), /deadline_minutes/],
    ["removed platform auto-merge setting as an ordinary unknown key", CONFIG_YAML.replace("{ name: owner/*, ops: [approve, merge, policy-check] }", "{ name: owner/*, ops: [approve, merge, policy-check], merge: { use_platform_automerge: false } }"), /use_platform_automerge/],
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
    ["release without build settings", CONFIG_YAML.replace("ops: [approve, merge, policy-check]", "ops: [approve, merge, policy-check, release]"), /release settings must be present/],
    ["release settings without release op", CONFIG_YAML.replace("ops: [approve, merge, policy-check]", "ops: [approve, merge, policy-check], release: { build_type: none }"), /release settings must be present/],
    ["unknown release build type", releaseConfig("{ build_type: custom }"), /build_type/],
    ["release build with an unknown key", releaseConfig("{ build_type: none, target: linux }"), /Unrecognized key/],
    ["js-action release rejects unknown keys", releaseConfig("{ build_type: js-action, target: linux }"), /Unrecognized key/],
    ["GoReleaser release rejects unknown keys", releaseConfig("{ build_type: goreleaser, target: linux }"), /Unrecognized key/],
    ["Terraform provider without a name", releaseConfig("{ build_type: terraform-provider }"), /provider_name/],
    ...["", "Upper", "a/b", "-a", "a-", "a--b", "a_1", "a\\nb", "a".repeat(65)].map((name): [string, string, RegExp] => [
      `Terraform provider with invalid name ${JSON.stringify(name)}`,
      releaseConfig(`{ build_type: terraform-provider, provider_name: ${JSON.stringify(name)} }`),
      /provider_name/,
    ]),
    ["Terraform provider with extra build settings", releaseConfig("{ build_type: terraform-provider, provider_name: sigma, targets: [linux] }"), /Unrecognized key/],
    ["Cargo release rejects unknown keys", releaseConfig("{ build_type: cargo, targets: [x86_64-unknown-linux-gnu], target: linux }"), /Unrecognized key/],
    ["cargo with no target triples", releaseConfig("{ build_type: cargo, targets: [] }"), /Too small/],
    ["cargo with unsupported target triple", releaseConfig("{ build_type: cargo, targets: [custom-runner] }"), /Invalid option/],
    ["cargo with duplicate target triples", releaseConfig("{ build_type: cargo, targets: [x86_64-unknown-linux-gnu, x86_64-unknown-linux-gnu] }"), /duplicate cargo target/],
    ["cargo-raw without a binary", releaseConfig("{ build_type: cargo-raw, targets: [x86_64-unknown-linux-musl] }"), /binary/],
    ...["", "-binary", "../binary", "binary.exe", "binary name", "binary\n", "a".repeat(65)].map((binary) => [
      `cargo-raw with unsafe binary ${JSON.stringify(binary)}`,
      releaseConfig(`{ build_type: cargo-raw, binary: ${JSON.stringify(binary)}, targets: [x86_64-unknown-linux-musl] }`),
      /binary must be a safe Cargo binary name/,
    ] satisfies [string, string, RegExp]),
    ["cargo-raw with empty targets", releaseConfig("{ build_type: cargo-raw, binary: app, targets: [] }"), /Too small/],
    ["cargo-raw with unsupported target", releaseConfig("{ build_type: cargo-raw, binary: app, targets: [x86_64-unknown-linux-gnu] }"), /Invalid option/],
    ["cargo-raw with duplicate targets", releaseConfig("{ build_type: cargo-raw, binary: app, targets: [x86_64-unknown-linux-musl, x86_64-unknown-linux-musl] }"), /duplicate cargo-raw target/],
    ["cargo-raw with unknown fields", releaseConfig("{ build_type: cargo-raw, binary: app, targets: [x86_64-unknown-linux-musl], extra: true }"), /Unrecognized key/],
    ["non-cargo build with target triples", releaseConfig("{ build_type: none, targets: [x86_64-unknown-linux-gnu] }"), /Unrecognized key/],
  ];
  test.each(rejects)("rejects %s", (_, yaml, message) => {
    expect(() => parseConfig(yaml)).toThrow(message);
  });
});

function routeConfig(route: string): string {
  return CONFIG_YAML.replace("repositories:", `securefix:\n  allow_workflow_changes: false\n  routes:\n    - ${route}\nrepositories:`);
}

function releaseConfig(settings: string): string {
  return CONFIG_YAML.replace(
    "ops: [approve, merge, policy-check]",
    `ops: [approve, merge, policy-check, release], release: ${settings}`,
  );
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

  test("keeps release build settings on the matching repository", () => {
    const c = parseConfig(releaseConfig("{ build_type: cargo, targets: [x86_64-unknown-linux-gnu, aarch64-apple-darwin] }"));
    expect(repositoryEntry(c, "owner/repo")?.release).toEqual({
      build_type: "cargo",
      targets: ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
    });
  });
  test("keeps raw binary and all four supported targets", () => {
    const release = { build_type: "cargo-raw", binary: "herdr-linear-agent", targets: ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"] } satisfies Release;
    const parsed = parseConfig(releaseConfig(JSON.stringify(release)));
    expect(repositoryEntry(parsed, "owner/repo")?.release).toEqual(release);
  });
});


describe("repository policy configuration", () => {
  const document = (fields: string) => CONFIG_YAML.replace("name: owner/no-ops, ops: []", `name: owner/no-ops, ops: [], ${fields}`);
  test.each([
    ["empty objects", "sensitive_paths: {}, merge: {}", { sensitive_paths: {}, merge: {} }],
    ["empty lists", "sensitive_paths: { paths: [], exempt: [] }, merge: { allow_bot_requests: false }", { sensitive_paths: { paths: [], exempt: [] }, merge: { allow_bot_requests: false } }],
    ["patterns and principals", 'sensitive_paths: { paths: [".github/**"], exempt: [{ id: 20, login: "renovate[bot]" }] }, merge: { allow_bot_requests: true }', { sensitive_paths: { paths: [".github/**"], exempt: [{ id: 20, login: "renovate[bot]" }] }, merge: { allow_bot_requests: true } }],
  ])("accepts %s without introducing inherited defaults", (_name, fields, expected) => {
    expect(parseConfig(document(String(fields))).repositories[0]).toEqual({ name: "owner/no-ops", ops: [], ...expected });
  });
  test("omitted objects remain absent", () => {
    expect(config().repositories[0]).toEqual({ name: "owner/no-ops", ops: [] });
  });
  test.each([
    ["unknown sensitive key", "sensitive_paths: { extra: [] }", /Unrecognized key:.*extra/],
    ["unknown merge key", "merge: { extra: true }", /Unrecognized key:.*extra/],
    ["nonboolean permission", "merge: { allow_bot_requests: yes }", /expected boolean/],
    ["empty pattern", 'sensitive_paths: { paths: [""] }', /Too small/],
    ["nonstring pattern", "sensitive_paths: { paths: [1] }", /expected string/],
    ["nonarray paths", 'sensitive_paths: { paths: "**" }', /expected array/],
    ["nonarray exemptions", "sensitive_paths: { exempt: {} }", /expected array/],
    ["invalid principal id", "sensitive_paths: { exempt: [{ id: 0, login: alice }] }", /Too small/],
    ["invalid principal login", 'sensitive_paths: { exempt: [{ id: 10, login: "" }] }', /Too small/],
    ["unknown principal field", "sensitive_paths: { exempt: [{ id: 10, login: alice, type: User }] }", /Unrecognized key:.*type/],
    ["missing principal id", "sensitive_paths: { exempt: [{ login: alice }] }", /expected number/],
    ["null sensitive object", "sensitive_paths: null", /expected object/],
    ["null merge object", "merge: null", /expected object/],
  ])("rejects %s", (_name, fields, message) => {
    expect(() => parseConfig(document(String(fields)))).toThrow(message);
  });
});
