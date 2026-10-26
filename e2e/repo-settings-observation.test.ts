import { expect, spyOn, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { assertRepositorySettings } from "./repo-settings.ts";

const expected = {
  delete_branch_on_merge: true,
  allow_auto_merge: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  has_wiki: false,
  has_projects: false,
  allow_update_branch: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
};

function context(body: object, then: object[] = []) {
  const fetch = fakeFetch([{ method: "GET", path: "/repos/owner/server", body, then }]);
  return { ctx: { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined }, fetch };
}

test("waits for settings to converge and records only expected fields", async () => {
  const { ctx, fetch } = context({ ...expected, delete_branch_on_merge: false, unrelated: "excluded" }, [expected]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await assertRepositorySettings(ctx, "owner/server");
    expect(fetch.requests).toHaveLength(2);
    expect(log).toHaveBeenCalledWith('repo-settings-observation {"repository":"owner/server","mismatches":[{"key":"delete_branch_on_merge","expected":true,"actual":false}]}');
    expect(log).toHaveBeenLastCalledWith('repo-settings-observation {"repository":"owner/server","mismatches":[]}');
  } finally {
    log.mockRestore();
  }
}, 10_000);

test.each(Object.entries(expected))("a persistent %s mismatch fails at the polling deadline", async (key, value) => {
  const wrong = typeof value === "boolean" ? !value : key === "squash_merge_commit_title" ? "COMMIT_OR_PR_TITLE" : "COMMIT_MESSAGES";
  const { ctx } = context({ ...expected, [key]: wrong });
  let calls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => calls++ === 0 ? 0 : 11 * 60_000);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(assertRepositorySettings(ctx, "owner/server")).rejects.toThrow("timed out waiting for reconciled repository settings in owner/server");
    expect(log).toHaveBeenCalledWith(`repo-settings-observation ${JSON.stringify({ repository: "owner/server", mismatches: [{ key, expected: value, actual: wrong }] })}`);
  } finally {
    clock.mockRestore();
    log.mockRestore();
  }
});

test.each([403, 404, 422])("propagates HTTP %i instead of treating errors as stale settings", async (status) => {
  const fetch = fakeFetch([{ method: "GET", path: "/repos/owner/server", status, body: { message: "settings read failed" } }]);
  const ctx = { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined };
  await expect(assertRepositorySettings(ctx, "owner/server")).rejects.toThrow("settings read failed");
  expect(fetch.requests).toHaveLength(1);
});
