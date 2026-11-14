import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { CONFIG_YAML, fakeFetch } from "./testing.ts";
import { assertManagedPullContextCurrent, deriveManagedPullAttestation, parseManagedWorkflowReleaseHint } from "./managed-pull-context.ts";
import { verifyWorkflowReleaseRevision } from "./workflow-release.ts";

const SHA = "a".repeat(40);
const RELEASE_SHA = "d".repeat(40);
const release = { version: "v1.2.3", sha: RELEASE_SHA };
const pull = (headRef: string) => ({
  number: 12,
  node_id: "PR_node",
  state: "open",
  merged: false,
  draft: false,
  head: { ref: headRef, sha: "b".repeat(40), repo: { id: 42, full_name: "owner/repo" } },
  base: { ref: "main", repo: { id: 42, full_name: "owner/repo" } },
});

function clients(options: { headRef: string; autoComplete?: boolean; config?: string }) {
  const sourceFetch = fakeFetch([
    { method: "GET", path: "/repos/owner/server", body: { id: 1, full_name: "owner/server", default_branch: "main" } },
    { method: "GET", path: "/repos/owner/server/git/ref/heads%2Fmain", body: { object: { sha: SHA } } },
    { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: options.config ?? (options.autoComplete ? `${CONFIG_YAML}\nrepo_settings: { auto_merge_managed_files: true }\n` : CONFIG_YAML) },
  ]);
  const targetFetch = fakeFetch([
    { method: "GET", path: "/repos/owner/repo/pulls/12", body: pull(options.headRef) },
  ]);
  return { source: github("source", sourceFetch), target: github("target", targetFetch), sourceFetch, targetFetch };
}

const base = { serverRepository: "owner/server", configSha: SHA, configPath: "csm-ci.yaml", repository: "owner/repo", pullNumber: 12 };

test("ordinary pull requests are not treated as managed-file candidates", async () => {
  const f = clients({ headRef: "feature/change" });
  expect(await deriveManagedPullAttestation({ ...base, ...f })).toBeUndefined();
  expect(f.targetFetch.calls).toEqual(["GET /repos/owner/repo/pulls/12"]);
  expect(f.sourceFetch.calls).toEqual([]);
});

test("managed pull requests use the trusted configuration's automatic-completion gate", async () => {
  const f = clients({ headRef: "csm-ci/repo-settings" });
  expect(await deriveManagedPullAttestation({ ...base, ...f })).toBeUndefined();
  expect(f.sourceFetch.calls).toContain("GET /repos/owner/server/contents/csm-ci.yaml");
  expect(f.targetFetch.calls).toEqual(["GET /repos/owner/repo/pulls/12"]);
});

test("managed candidates fail closed when the workflow config is stale", async () => {
  const f = clients({ headRef: "csm-ci/repo-settings" });
  const changedSource = fakeFetch([
    { method: "GET", path: "/repos/owner/server", body: { id: 1, full_name: "owner/server", default_branch: "main" } },
    { method: "GET", path: "/repos/owner/server/git/ref/heads%2Fmain", body: { object: { sha: "c".repeat(40) } } },
  ]);
  await expect(deriveManagedPullAttestation({ ...base, ...f, source: github("source", changedSource) }))
    .rejects.toThrow("managed pull configuration is no longer at the server default-branch head");
});

test("enabled managed completion rejects targets without the required operations", async () => {
  const config = `${CONFIG_YAML.replace("{ name: owner/*, ops: [approve, merge, policy-check] }", "{ name: owner/repo, ops: [] }")}\nrepo_settings: { auto_merge_managed_files: true }\n`;
  const f = clients({ headRef: "csm-ci/repo-settings", config });
  await expect(deriveManagedPullAttestation({ ...base, ...f }))
    .rejects.toThrow("managed pull automatic completion requires approve, policy-check, and merge operations");
});

function stableContextSource(options: { configRefSha?: string; releaseVersion?: string; releaseSha?: string; pinnedTagName?: string } = {}) {
  const configRefSha = SHA;
  const latestVersion = options.releaseVersion ?? "v1.2.4";
  const releaseSha = options.releaseSha ?? RELEASE_SHA;
  const sourceFetch = fakeFetch([
    { method: "GET", path: "/repos/owner/server/git/ref/heads%2Fmain", body: { object: { sha: options.configRefSha ?? configRefSha } } },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: { tag_name: latestVersion, draft: false, prerelease: false, published_at: "2026-10-25T12:00:00Z", id: 2 } },
    {
      method: "GET", path: `/repos/civitaspo/csm-ci-actions/releases/tags/${release.version}`,
      body: { tag_name: options.pinnedTagName ?? release.version, draft: false, prerelease: false, published_at: "2026-10-24T12:00:00Z", id: 1 },
    },
    { method: "GET", path: `/repos/civitaspo/csm-ci-actions/git/ref/tags%2F${release.version}`, body: { object: { type: "commit", sha: releaseSha } } },
  ]);
  return { source: github("source", sourceFetch), sourceFetch };
}

test("rejects a server config change detected by the final ref read", async () => {
  const { source, sourceFetch } = stableContextSource({ configRefSha: "c".repeat(40) });
  await expect(assertManagedPullContextCurrent({
    source, serverRepository: "owner/server", defaultBranch: "main", configSha: SHA, callers: [], release,
  })).rejects.toThrow("managed pull configuration changed during validation");
  expect(sourceFetch.calls).toContain("GET /repos/owner/server/git/ref/heads%2Fmain");
});

test("rejects a run-pinned release whose tag now resolves to a different commit", async () => {
  const { source } = stableContextSource({ releaseSha: "f".repeat(40) });
  await expect(assertManagedPullContextCurrent({
    source, serverRepository: "owner/server", defaultBranch: "main", configSha: SHA, callers: [], release,
  })).rejects.toThrow("pinned standard workflow release version and SHA do not match");
});

test("accepts the run-pinned release without consulting latest release", async () => {
  const { source, sourceFetch } = stableContextSource({ releaseVersion: "v1.2.4" });
  await assertManagedPullContextCurrent({
    source, serverRepository: "owner/server", defaultBranch: "main", configSha: SHA, callers: [], release,
  });
  expect(sourceFetch.calls).toContain(`GET /repos/civitaspo/csm-ci-actions/releases/tags/${release.version}`);
  expect(sourceFetch.calls).not.toContain("GET /repos/civitaspo/csm-ci-actions/releases/latest");
});

test("extracts the proposal workflow release header", () => {
  expect(parseManagedWorkflowReleaseHint(`# Generated by csm-ci from v1.2.3 (${RELEASE_SHA}).\nworkflow: altered`)).toEqual(release);
});

test("rejects a modified release header after resolving the candidate against GitHub", async () => {
  const { source } = stableContextSource();
  const candidate = parseManagedWorkflowReleaseHint(`# Generated by csm-ci from v1.2.3 (${"f".repeat(40)}).\n`);
  expect(candidate).not.toEqual(release);
  await expect(verifyWorkflowReleaseRevision(source, candidate, [])).rejects.toThrow("pinned standard workflow release version and SHA do not match");
});

test("rejects a missing release header candidate", () => {
  expect(() => parseManagedWorkflowReleaseHint("workflow: no generated marker")).toThrow("managed pull has no valid generated workflow release pin");
});

test("rejects a candidate whose version is not the exact published stable tag", async () => {
  const { source } = stableContextSource({ pinnedTagName: "v1.2.4" });
  await expect(assertManagedPullContextCurrent({
    source, serverRepository: "owner/server", defaultBranch: "main", configSha: SHA, callers: [], release,
  })).rejects.toThrow("pinned standard workflow release is not a published stable release");
});
