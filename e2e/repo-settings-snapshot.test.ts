import { expect, spyOn, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { restoreRepository, snapshotRepository, UNMANAGED_SQUASH_SETTINGS } from "./repo-settings.ts";

test.each(["baseline", "restored", "observed"] satisfies Parameters<typeof snapshotRepository>[2][])("records %s repository state in the durable scenario log", async (phase) => {
  const settings = {
    delete_branch_on_merge: false,
    allow_auto_merge: false,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    has_wiki: true,
    has_projects: true,
    allow_update_branch: false,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
  } satisfies Awaited<ReturnType<typeof snapshotRepository>>["settings"];
  const ruleset = { id: 17, name: "integrity", source_type: "Repository", enforcement: "active", target: "branch", conditions: {}, rules: [], bypass_actors: [] } satisfies Awaited<ReturnType<typeof snapshotRepository>>["rulesets"][number];
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/owner/client", body: { ...settings, unrelated: "not part of the snapshot" } },
    { method: "GET", path: "/repos/owner/client/rulesets", body: [ruleset] },
    { method: "GET", path: "/repos/owner/client/rulesets/17", body: ruleset },
    { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
  ]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const snapshot = await snapshotRepository(github("test", fetch), "owner/client", phase);
    expect(snapshot).toEqual({ settings, rulesets: [ruleset], immutableReleases: true });
    expect(log).toHaveBeenCalledWith(`repo-settings-snapshot ${JSON.stringify({ repository: "owner/client", phase, snapshot })}`);
  } finally {
    log.mockRestore();
  }
});

test.each([
  ["API rejection", 403, false, "restoring owner/client failed in 1 step(s)"],
  ["settings mismatch", 200, true, "repository settings were not restored for owner/client"],
])("records the original and actual state after a restore %s", async (_name, status, mismatch, message) => {
  const settings = {
    delete_branch_on_merge: false,
    allow_auto_merge: false,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    has_wiki: true,
    has_projects: true,
    allow_update_branch: false,
    squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
  };
  const actual = mismatch ? { ...settings, squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" } : settings;
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/owner/client", body: settings, then: [actual] },
    { method: "GET", path: "/repos/owner/client/rulesets", body: [] },
    { method: "GET", path: "/repos/owner/client/immutable-releases", body: { enabled: true } },
    { method: "PATCH", path: "/repos/owner/client", status, body: { message: "settings write rejected" } },
  ]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const gh = github("test", fetch);
    const snapshot = await snapshotRepository(gh, "owner/client");
    await expect(restoreRepository(gh, "owner/client", snapshot, new Set())).rejects.toThrow(message);
    expect(log).toHaveBeenCalledWith(`repo-settings-snapshot ${JSON.stringify({ repository: "owner/client", phase: "baseline", snapshot })}`);
    expect(log).toHaveBeenCalledWith(`repo-settings-snapshot ${JSON.stringify({ repository: "owner/client", phase: "restored", snapshot: { ...snapshot, settings: actual } })}`);
  } finally {
    log.mockRestore();
  }
});

// GitHub's invalid_squash_commit_setting_combo response lists these four pairs.
test("the unmanaged squash fixture uses an API-supported pair that differs from the enforced format", () => {
  const validPairs = [
    { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" },
    { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "BLANK" },
    { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "COMMIT_MESSAGES" },
    { squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "COMMIT_MESSAGES" },
  ];
  expect(validPairs).toContainEqual(UNMANAGED_SQUASH_SETTINGS);
  expect(UNMANAGED_SQUASH_SETTINGS).not.toEqual(validPairs[0]);
});
