import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../lib/config.ts";
import { formatRepoSettingsSelection, repoSettingsEventMode, repoSettingsSelection, selectsAdministration, validateRepoSettingsContext, validateRepoSettingsStage } from "./context.ts";

const config = parseConfig(readFileSync("e2e/fixtures/testing-csm-ci-server/csm-ci.yaml", "utf8"));
const base = {
  config,
  serverRepository: "civitaspo/testing-csm-ci-server",
  serverRef: "refs/heads/main",
  serverDefaultBranch: "main",
  actionsRepository: "civitaspo/csm-ci-actions",
  targetRepository: "civitaspo/testing-csm-ci-client",
};

describe("repo-settings execution context", () => {
  test("accepts a configured target from the pinned server config on the default branch", () => {
    expect(() => validateRepoSettingsContext(base)).not.toThrow();
  });

  test("accepts the actions repository as a configured client target", () => {
    expect(() => validateRepoSettingsContext({
      ...base,
      config: { ...config, repositories: [...config.repositories, { name: "civitaspo/csm-ci-actions", ops: [] }] },
      targetRepository: "civitaspo/csm-ci-actions",
    })).not.toThrow();
  });

  test.each([
    ["server identity from pinned config", { serverRepository: "civitaspo/other-server" }, /server repository does not match the pinned configuration/],
    ["default branch", { serverRef: "refs/heads/feature" }, /default branch/],
    ["repo settings config", { config: { ...config, repo_settings: undefined } }, /repo_settings is not configured/],
    ["actions repository as server", { config: { ...config, server_repository: "civitaspo/csm-ci-actions" }, serverRepository: "civitaspo/csm-ci-actions" }, /cannot be the server repository/],
    ["unconfigured actions repository", { targetRepository: "civitaspo/csm-ci-actions" }, /repository civitaspo\/csm-ci-actions is not configured/],
    ["unconfigured target", { targetRepository: "civitaspo/unknown" }, /is not configured/],
  ] as const)("rejects %s", (_name, overrides, message) => {
    expect(() => validateRepoSettingsContext({ ...base, ...overrides })).toThrow(message);
  });
});

describe("repo-settings event mode", () => {
  test.each([
    ["schedule", "schedule"],
    ["schedule", "workflow_dispatch"],
    ["dispatch", "workflow_dispatch"],
  ])("accepts %s mode from a %s event", (mode, event) => {
    expect(repoSettingsEventMode(mode, event)).toBe(mode as "schedule" | "dispatch");
  });

  test.each([
    ["an unknown mode", "apply", "workflow_dispatch", "unknown event mode apply"],
    ["dispatch mode in a scheduled run", "dispatch", "schedule", "a scheduled run cannot use dispatch mode"],
  ])("rejects %s", (_name, mode, event, message) => {
    expect(() => repoSettingsEventMode(mode, event)).toThrow(message);
  });
});

const ALL = "settings,rulesets,releases,managed-files";
const UNKNOWN = "use settings, rulesets, releases, managed-files, all";
const EMPTY = "repo-settings targets must be a comma-separated list of settings, rulesets, releases, managed-files, all";

describe("repo-settings targets", () => {
  test.each([
    ["settings alone", "settings", "settings"],
    ["rulesets alone", "rulesets", "rulesets"],
    ["releases alone", "releases", "releases"],
    ["managed-files alone", "managed-files", "managed-files"],
    ["a combination in canonical order", "managed-files,settings", "settings,managed-files"],
    ["administrative targets with spaces", "releases, rulesets ,settings", "settings,rulesets,releases"],
    ["duplicates", "rulesets,rulesets", "rulesets"],
    ["all", "all", ALL],
    ["all with another target", "all,settings", ALL],
    ["every target listed", "managed-files,releases,rulesets,settings", ALL],
  ] as const)("accepts %s on dispatch", (_name, value, expected) => {
    expect(formatRepoSettingsSelection(repoSettingsSelection(value, "workflow_dispatch", "dispatch"))).toBe(expected);
  });

  test("accepts all on a schedule", () => {
    expect(formatRepoSettingsSelection(repoSettingsSelection("all", "schedule", "schedule"))).toBe(ALL);
    expect(formatRepoSettingsSelection(repoSettingsSelection(ALL, "workflow_dispatch", "schedule"))).toBe(ALL);
  });

  test.each([
    ["an empty value", "", "workflow_dispatch", "dispatch", `${EMPTY}: ""`],
    ["a blank value", " ", "workflow_dispatch", "dispatch", `${EMPTY}: " "`],
    ["an empty entry", "settings,,rulesets", "workflow_dispatch", "dispatch", `${EMPTY}: "settings,,rulesets"`],
    ["a trailing comma", "settings,", "workflow_dispatch", "dispatch", `${EMPTY}: "settings,"`],
    ["an unknown target", "apply", "workflow_dispatch", "dispatch", `unknown repo-settings target apply; ${UNKNOWN}`],
    ["an unknown target after a known one", "settings,ruleset", "workflow_dispatch", "dispatch", `unknown repo-settings target ruleset; ${UNKNOWN}`],
    ["a case variant", "Settings", "workflow_dispatch", "dispatch", `unknown repo-settings target Settings; ${UNKNOWN}`],
    ["the removed reconcile mode", "reconcile", "workflow_dispatch", "dispatch", `unknown repo-settings target reconcile; ${UNKNOWN}`],
    ["the removed managed-files-only mode", "managed-files-only", "workflow_dispatch", "dispatch", `unknown repo-settings target managed-files-only; ${UNKNOWN}`],
    ["a partial selection on a scheduled event", "managed-files", "schedule", undefined, "a scheduled run must select all repo-settings targets"],
    ["a partial selection in schedule event mode", "settings", "workflow_dispatch", "schedule", "a scheduled run must select all repo-settings targets"],
    ["a partial selection on a non-dispatch event", "managed-files", "push", undefined, "selecting repo-settings targets other than all requires a workflow_dispatch event"],
  ] as const)("rejects %s with the exact reason", (_name, value, eventName, eventMode, message) => {
    expect(() => repoSettingsSelection(value, eventName, eventMode)).toThrow(message);
  });
});

describe("repo-settings stages per target selection", () => {
  const stages = ["validate-targets", "validate-target", "discover", "inspect", "preflight", "apply", "managed-inspect", "managed-apply"];
  const always = ["validate-targets", "validate-target", "discover"];
  test.each([
    ["settings", [...always, "inspect", "apply"]],
    ["rulesets", [...always, "inspect", "preflight", "apply"]],
    ["releases", [...always, "inspect", "apply"]],
    ["managed-files", [...always, "managed-inspect", "managed-apply"]],
    ["settings,managed-files", [...always, "inspect", "apply", "managed-inspect", "managed-apply"]],
    ["rulesets,releases", [...always, "inspect", "preflight", "apply"]],
    ["all", stages],
  ] as const)("targets %s allow exactly their stages", (value, allowed) => {
    const selection = repoSettingsSelection(value, "workflow_dispatch", "dispatch");
    const formatted = formatRepoSettingsSelection(selection);
    for (const stage of stages) {
      if ((allowed as readonly string[]).includes(stage)) expect(() => validateRepoSettingsStage(stage, selection)).not.toThrow();
      else expect(() => validateRepoSettingsStage(stage, selection)).toThrow(`repo-settings stage ${stage} is unavailable for targets ${formatted}`);
    }
  });

  test.each([
    ["settings", true], ["rulesets", true], ["releases", true], ["managed-files", false], ["all", true],
  ] as const)("targets %s select administration: %p", (value, expected) => {
    expect(selectsAdministration(repoSettingsSelection(value, "workflow_dispatch", "dispatch"))).toBe(expected);
  });
});
