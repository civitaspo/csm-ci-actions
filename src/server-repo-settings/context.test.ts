import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../lib/config.ts";
import { repoSettingsEventMode, repoSettingsOperationMode, validateRepoSettingsContext, validateRepoSettingsStage } from "./context.ts";

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

describe("repo-settings operation mode", () => {
  test.each([
    ["omitted mode defaults to reconciliation", undefined, "workflow_dispatch", undefined, "reconcile"],
    ["empty mode defaults to reconciliation", "", "workflow_dispatch", "dispatch", "reconcile"],
    ["reconciliation mode", "reconcile", "schedule", "schedule", "reconcile"],
    ["managed-files-only dispatch", "managed-files-only", "workflow_dispatch", "dispatch", "managed-files-only"],
  ] as const)("accepts %s", (_name, value, eventName, eventMode, expected) => {
    expect(repoSettingsOperationMode(value, eventName, eventMode)).toBe(expected);
  });

  test.each([
    ["unknown mode", "apply", "workflow_dispatch", "dispatch", "unknown repo-settings operation mode apply"],
    ["scheduled event", "managed-files-only", "schedule", undefined, "a scheduled run cannot use managed-files-only mode"],
    ["scheduled operation mode", "managed-files-only", "workflow_dispatch", "schedule", "a scheduled run cannot use managed-files-only mode"],
    ["non-dispatch event", "managed-files-only", "push", undefined, "managed-files-only mode requires a workflow_dispatch event"],
  ] as const)("rejects %s with the exact reason", (_name, value, eventName, eventMode, message) => {
    expect(() => repoSettingsOperationMode(value, eventName, eventMode)).toThrow(message);
  });
});

describe("repo-settings operation stages", () => {
  test.each(["inspect", "preflight", "apply"])("rejects %s in managed-files-only mode", (stage) => {
    expect(() => validateRepoSettingsStage(stage, "managed-files-only"))
      .toThrow(`repo-settings stage ${stage} is unavailable in managed-files-only mode`);
  });

  test.each(["validate-target", "discover", "managed-inspect", "managed-apply"])("allows %s in managed-files-only mode", (stage) => {
    expect(() => validateRepoSettingsStage(stage, "managed-files-only")).not.toThrow();
  });
});
