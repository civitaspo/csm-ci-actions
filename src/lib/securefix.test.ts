import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { bindSecurefixPullRequest, buildSecurefixArtifact, findSecurefixRoute, parseSecurefixManifest, readSecurefixArtifact, validateEntries, validateRouteChanges, validateSecurefixPath, validateSecurefixRun, validateSecurefixRouteCommitFile, validateSecurefixRouteHead, type SecurefixManifest, type SecurefixRun } from "./securefix.ts";
import type { SecurefixRoute } from "./config.ts";

const sha = "a".repeat(40);
const repo = "civitaspo/testing-csm-ci-client";
const run: SecurefixRun = {
  id: 42,
  run_attempt: 1,
  event: "pull_request",
  head_branch: "feature",
  head_sha: sha,
  path: ".github/workflows/securefix.yml",
  repository: { id: 1, full_name: repo },
  head_repository: { id: 1, full_name: repo },
  pull_requests: [{ number: 7, head: { ref: "feature", sha }, base: { ref: "main", sha } }],
};
const pull = { number: 7, state: "open", draft: false, base: { ref: "main", sha }, head: { ref: "feature", sha, repo: { full_name: repo } } };
const route: SecurefixRoute = { name: "release-pr", from: "default", to: "release/next", workflow: ".github/workflows/release-pr.yml", paths: { "CHANGELOG.md": "any", ".release-version": "semver", "package.json": "version-only" } };
const manifest = (overrides: Partial<SecurefixManifest> = {}): SecurefixManifest => ({ version: 1, repository: repo, run_id: 42, head_sha: sha, message: "Update files", files: [], ...overrides });

describe("securefix path and size checks", () => {
  test.each([
    ["absolute path", "/tmp/escape", "securefix path \"/tmp/escape\" is absolute or contains a control character"],
    ["windows drive path", "C:escape", "securefix path \"C:escape\" is absolute or contains a control character"],
    ["backslash path", "folder\\escape", "securefix path \"folder\\\\escape\" is absolute or contains a control character"],
    ["control character", "line\nbreak", "securefix path \"line\\nbreak\" is absolute or contains a control character"],
    ["parent segment", "folder/../escape", "securefix path \"folder/../escape\" contains .."],
    ["git segment", "safe/.GIT/config", "securefix path \"safe/.GIT/config\" contains a .git segment"],
    ["empty segment", "folder//file", "securefix path \"folder//file\" is not normalized"],
    ["dot segment", "folder/./file", "securefix path \"folder/./file\" is not normalized"],
  ])("rejects %s", (_name, path, message) => {
    expect(() => validateSecurefixPath(path)).toThrow(message);
  });

  test.each([
    ["too many files", Array.from({ length: 513 }, (_, i) => ({ kind: "delete" as const, path: `f${i}` })), "securefix has more than 512 changed files"],
    ["too large file", [{ kind: "write" as const, path: "large", size: 8 * 1024 * 1024 + 1, sha256: "b".repeat(64) }], 'securefix file "large" is larger than 8MB'],
    ["too much total data", [0, 1, 2].map((i) => ({ kind: "write" as const, path: `f${i}`, size: 4 * 1024 * 1024, sha256: "b".repeat(64) })), "securefix files are larger than 10MB in total"],
    ["duplicate path", [{ kind: "delete" as const, path: "same" }, { kind: "delete" as const, path: "same" }], 'securefix contains duplicate path "same"'],
  ])("rejects %s", (_name, entries, message) => {
    expect(() => validateEntries(entries)).toThrow(message);
  });
});

describe("securefix artifact binding", () => {
  test.each([
    ["repository mismatch", manifest({ repository: "other/repo" }), "securefix metadata repository does not match the workflow run"],
    ["run mismatch", manifest({ run_id: 43 }), "securefix metadata run does not match the requested workflow run"],
    ["head mismatch", manifest({ head_sha: "b".repeat(40) }), "securefix metadata head does not match the workflow run"],
    ["internal request marker", manifest({ message: "update csm-ci-secret" }), "securefix commit message must not contain csm-ci-"],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseSecurefixManifest(value, { repository: repo, runId: 42, headSha: sha })).toThrow(message);
  });

  test("revalidates downloaded payload and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "securefix-test-"));
    try {
      await mkdir(join(root, "files"));
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest()));
      await Bun.write(join(root, "files", "extra"), "extra");
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow("securefix artifact contains files that are not listed in its manifest");
      await rm(join(root, "files", "extra"));
      await symlink("manifest.json", join(root, "files", "link"));
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow('securefix artifact contains symlink "files/link"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked payload directory before opening any payload path", async () => {
    const root = await mkdtemp(join(tmpdir(), "securefix-symlink-dir-test-"));
    const outside = await mkdtemp(join(tmpdir(), "securefix-outside-test-"));
    const payload = Buffer.from("outside\n");
    try {
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest({
        files: [{ kind: "write", path: "file.txt", size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }],
      })));
      await writeFile(join(outside, "0000"), payload);
      await symlink(outside, join(root, "files"));
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow('securefix artifact contains symlink "files"');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("packages changed files and rejects a symlink from the Git tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "securefix-client-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "test"], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
      await writeFile(join(workspace, "file.txt"), "before");
      await symlink("file.txt", join(workspace, "link.txt"));
      execFileSync("git", ["add", "."], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd: workspace });
      await writeFile(join(workspace, "file.txt"), "after");
      const result = await buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" });
      expect(result.hasChanges).toBe(true);
      const artifact = await readSecurefixArtifact(result.path, { repository: repo, runId: 42, headSha: sha });
      expect(artifact.changes).toEqual([{ kind: "write", path: "file.txt", content: Buffer.from("after") }]);
      await rm(result.path, { recursive: true, force: true });
      await rm(join(workspace, "link.txt"));
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 43, headSha: sha, message: "update" })).rejects.toThrow('securefix does not allow symlink "link.txt"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("securefix run and path bindings", () => {
  test.each([
    [{ ...run, run_attempt: 2 }, "workflow run attempt is 2; retries are not accepted"],
    [{ ...run, event: "pull_request_target" }, "securefix rejects pull_request_target runs"],
    [{ ...run, repository: { id: 1, full_name: "other/repo" } }, "securefix workflow run is not from the same repository"],
    [{ ...run, event: "schedule" }, "securefix does not accept schedule events"],
    [{ ...run, pull_requests: [] }, "securefix PR run must map to exactly one pull request"],
  ])("rejects an untrusted run", (value, message) => {
    expect(() => validateSecurefixRun(value, 42, repo)).toThrow(message);
  });

  test.each([
    ["wrong base", { ...pull, base: { ref: "attacker", sha } }, 1, "securefix PR must target the default branch"],
    ["fork", { ...pull, head: { ...pull.head, repo: { full_name: "forker/repo" } } }, 1, "securefix does not accept fork pull requests"],
    ["ambiguous branch", pull, 2, "securefix PR head has more than one open pull request"],
  ])("rejects PR binding with %s", (_name, value, count, message) => {
    expect(() => bindSecurefixPullRequest(run, "main", value, count, repo)).toThrow(message);
  });

  test("defers current-head matching until exact retry recovery is checked", () => {
    const moved = { ...pull, head: { ...pull.head, sha: "b".repeat(40) } };
    expect(() => bindSecurefixPullRequest(run, "main", moved, 1, repo)).not.toThrow();
  });

  test("rejects route workflow, scope and moved source head", () => {
    const routeRun = { ...run, event: "push", head_branch: "main", path: route.workflow, pull_requests: [] };
    expect(findSecurefixRoute([route], routeRun, "main")).toEqual(route);
    expect(() => findSecurefixRoute([route, { ...route, name: "another" }], routeRun, "main")).toThrow("workflow run does not match exactly one securefix route");
    expect(() => validateSecurefixRouteHead(routeRun, route, "main", "b".repeat(40))).toThrow("securefix route head is not the current head of its source branch");
    expect(() => validateRouteChanges(route, [{ kind: "write", path: "README.md", content: Buffer.from("x") }], new Map())).toThrow('securefix route does not allow path "README.md"');
  });

  test.each([
    ["other manifest content", '"version": "1.0.0"\n"name": "before"\n', '"version": "1.1.0"\n"name": "after"\n'],
  ])("rejects version-only violation %s", (_name, before, after) => {
    const content = Buffer.from(after);
    const changes = [{ kind: "write" as const, path: "package.json", content }];
    expect(() => validateRouteChanges(route, changes, new Map([["package.json", Buffer.from(before)]]))).toThrow('securefix route allows only version lines in "package.json"');
  });

  test.each([
    ["a disallowed old path", "private.txt", "CHANGELOG.md", "securefix route does not allow path \"private.txt\""],
    ["a version-only old path", "package.json", "CHANGELOG.md", "securefix route requires a version line change for \"package.json\""],
    ["a semantic-version old path", ".release-version", "CHANGELOG.md", ".release-version must contain a semantic version"],
  ])("rejects route-branch rename from %s", (_name, previousFilename, filename, message) => {
    expect(() => validateSecurefixRouteCommitFile(
      route,
      { filename, status: "renamed", previous_filename: previousFilename },
      Buffer.from("before\n"),
      Buffer.from("after\n"),
    )).toThrow(message);
  });
});
