import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../lib/config.ts";
import { validateRepoSettingsContext } from "./context.ts";

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

  test.each([
    ["server identity from pinned config", { serverRepository: "civitaspo/other-server" }, /server repository does not match the pinned configuration/],
    ["default branch", { serverRef: "refs/heads/feature" }, /default branch/],
    ["repo settings config", { config: { ...config, repo_settings: undefined } }, /repo_settings is not configured/],
    ["actions repository as server", { config: { ...config, server_repository: "civitaspo/csm-ci-actions" }, serverRepository: "civitaspo/csm-ci-actions" }, /cannot be the server repository/],
    ["actions repository as target", { targetRepository: "civitaspo/csm-ci-actions" }, /cannot be a repo-settings target/],
    ["unconfigured target", { targetRepository: "civitaspo/unknown" }, /is not configured/],
  ] as const)("rejects %s", (_name, overrides, message) => {
    expect(() => validateRepoSettingsContext({ ...base, ...overrides })).toThrow(message);
  });
});
