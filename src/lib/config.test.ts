import { describe, expect, test } from "bun:test";
import { type Op, parseConfig, repositoryEntry } from "./config.ts";
import { CONFIG_YAML, config } from "./testing.ts";

describe("parseConfig", () => {
  test("accepts the fixture and lowercases names", () => {
    const c = config();
    expect(c.owners).toEqual(["owner"]);
    expect(c.server_repository).toBe("owner/server");
  });

  const rejects: [string, string, RegExp][] = [
    ["unknown top-level key", `${CONFIG_YAML}\nextra: 1\n`, /extra/],
    ["unknown policy type", CONFIG_YAML.replace("signed-commits", "no-such-policy"), /policies/],
    ["server bot as trusted committer", CONFIG_YAML.replace("committers: [{ id: 10, login: alice }", "committers: [{ id: 3000, login: alice }"), /must not be in a trust list/],
    ["approver bot as trusted committer", CONFIG_YAML.replace("committers: [{ id: 10, login: alice }", "committers: [{ id: 4000, login: alice }"), /must not be in a trust list/],
    ["server bot as approver", CONFIG_YAML.replace("approvers: [{ id: 10, login: alice }]", "approvers: [{ id: 3000, login: alice }]"), /must not be in a trust list/],
    ["missing approver", CONFIG_YAML.replace(/approver: \{[^\n]*\n/, ""), /approver/],
    ["server repository outside owners", CONFIG_YAML.replace("Owner/Server", "Other/Server"), /owner must be listed in owners/],
    ["duplicate op", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, approve]"), /duplicate op/],
    ["unknown op", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [deploy]"), /ops/],
    ["non-positive id", CONFIG_YAML.replace("client_bot_id: 2000", "client_bot_id: 0"), /client_bot_id/],
    ["missing repositories", CONFIG_YAML.replace(/repositories:[\s\S]*$/, "repositories: []\n"), /repositories/],
    ["malformed server repository", CONFIG_YAML.replace("Owner/Server", "Owner"), /server_repository/],
    ["release enabled without release settings", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release]"), /release settings must be present/],
    ["release settings without release op", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check], release: { build_type: none }"), /release settings must be present/],
    ["unknown release build type", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: make }"), /build_type/],
    ["cargo without targets", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: cargo }"), /targets/],
    ["empty cargo targets", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: cargo, targets: [] }"), /targets/],
    ["unsupported cargo target", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: cargo, targets: [custom-runner] }"), /targets/],
    ["duplicate cargo targets", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: cargo, targets: [x86_64-unknown-linux-gnu, x86_64-unknown-linux-gnu] }"), /duplicate cargo target/],
    ["unused targets", CONFIG_YAML.replace("ops: [approve, policy-check]", "ops: [approve, policy-check, release], release: { build_type: none, targets: [x86_64-unknown-linux-gnu] }"), /Unrecognized key/],
  ];
  test.each(rejects)("rejects %s", (_, yaml, message) => {
    expect(() => parseConfig(yaml)).toThrow(message);
  });
});

describe("repositoryEntry", () => {
  const cases: [string, string, Op[] | undefined][] = [
    ["glob match, case-insensitive", "Owner/Repo", ["approve", "policy-check"]],
    ["first match wins", "owner/no-ops", []],
    ["owner not listed", "other/repo", undefined],
    ["owner prefix is not enough", "owner-evil/repo", undefined],
  ];
  test.each(cases)("%s", (_, name, ops) => {
    expect(repositoryEntry(config(), name)?.ops).toEqual(ops);
  });

  test("owners bound even a catch-all glob", () => {
    const c = parseConfig(CONFIG_YAML.replace("name: owner/*", "name: '*/*'"));
    expect(repositoryEntry(c, "owner/repo")?.ops).toEqual(["approve", "policy-check"]);
    expect(repositoryEntry(c, "other/repo")).toBeUndefined();
  });

  test("keeps the release build contract attached to a managed repository", () => {
    const c = parseConfig(CONFIG_YAML.replace(
      "ops: [approve, policy-check]",
      "ops: [approve, policy-check, release], release: { build_type: cargo, targets: [x86_64-unknown-linux-gnu, aarch64-apple-darwin] }",
    ));
    expect(repositoryEntry(c, "owner/repo")?.release).toEqual({
      build_type: "cargo",
      targets: ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
    });
  });
});
