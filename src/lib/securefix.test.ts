import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
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
const routeRun: SecurefixRun = { ...run, event: "push", head_branch: "main", path: route.workflow, pull_requests: [] };
const manifest = (overrides: Partial<SecurefixManifest> = {}): SecurefixManifest => ({ version: 1, repository: repo, run_id: 42, head_sha: sha, message: "Update files", files: [], ...overrides });

async function gitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: workspace });
  return workspace;
}

async function writeArtifact(root: string, entries: SecurefixManifest["files"], payloads: ReadonlyMap<number, Buffer> = new Map()): Promise<void> {
  await mkdir(join(root, "files"), { recursive: true });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest({ files: entries })));
  for (const [index, payload] of payloads) await writeFile(join(root, "files", String(index).padStart(4, "0")), payload);
}

describe("securefix path and size checks", () => {
  test("rejects a parent replaced by a symlink after Git lists the changes", async () => {
    const workspace = await gitWorkspace("securefix-parent-race-");
    try {
      await mkdir(join(workspace, "parent"));
      await writeFile(join(workspace, "parent/file.txt"), "before");
      execFileSync("git", ["add", "."], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "tracked file"], { cwd: workspace });
      await writeFile(join(workspace, "parent/file.txt"), "after");
      const execute = childProcess.execFileSync;
      const command = spyOn(childProcess, "execFileSync").mockImplementationOnce(new Proxy(execute, {
        apply(target, receiver, args) {
          const status = Reflect.apply(target, receiver, args);
          renameSync(join(workspace, "parent"), join(workspace, "replaced"));
          symlinkSync("replaced", join(workspace, "parent"));
          return status;
        },
      }));
      try {
        await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "Update" }))
          .rejects.toThrow('securefix path "parent/file.txt" has an unsafe parent directory');
      } finally {
        command.mockRestore();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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

  test("rejects more than 512 changed files from a real Git worktree", async () => {
    const workspace = await gitWorkspace("securefix-count-test-");
    try {
      await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(join(workspace, `f${index}`), "x")));
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" }))
        .rejects.toThrow("securefix has more than 512 changed files");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a generated manifest larger than 1MB", async () => {
    const workspace = await gitWorkspace("securefix-large-generated-manifest-test-");
    const runId = Date.now();
    try {
      await writeFile(join(workspace, "file.txt"), "changed\n");
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId, headSha: sha, message: "x".repeat(1024 * 1024 + 1) }))
        .rejects.toThrow("securefix manifest is larger than 1MB");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      for (const name of await readdir(tmpdir())) {
        if (name.startsWith(`csm-ci-securefix-${runId}-`)) await rm(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  test("rejects unresolved merge paths from a real Git worktree", async () => {
    const workspace = await gitWorkspace("securefix-unresolved-test-");
    try {
      await writeFile(join(workspace, "conflict.txt"), "base\n");
      execFileSync("git", ["add", "conflict.txt"], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
      const baseBranch = execFileSync("git", ["branch", "--show-current"], { cwd: workspace }).toString().trim();
      execFileSync("git", ["checkout", "-qb", "other"], { cwd: workspace });
      await writeFile(join(workspace, "conflict.txt"), "other\n");
      execFileSync("git", ["commit", "-qam", "other"], { cwd: workspace });
      execFileSync("git", ["checkout", "-q", baseBranch], { cwd: workspace });
      await writeFile(join(workspace, "conflict.txt"), "main\n");
      execFileSync("git", ["commit", "-qam", "main"], { cwd: workspace });
      try { execFileSync("git", ["merge", "other"], { cwd: workspace, stdio: "ignore" }); } catch { /* The conflict is the fixture. */ }
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" }))
        .rejects.toThrow('securefix cannot package unresolved path "conflict.txt"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a changed submodule from a real Git worktree", async () => {
    const workspace = await gitWorkspace("securefix-submodule-test-");
    const submodule = await gitWorkspace("securefix-submodule-source-");
    try {
      await writeFile(join(submodule, "file.txt"), "one\n");
      execFileSync("git", ["add", "file.txt"], { cwd: submodule });
      execFileSync("git", ["commit", "-qm", "one"], { cwd: submodule });
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "module"], { cwd: workspace });
      execFileSync("git", ["commit", "-qam", "add submodule"], { cwd: workspace });
      await writeFile(join(workspace, "module", "file.txt"), "two\n");
      execFileSync("git", ["add", "file.txt"], { cwd: join(workspace, "module") });
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "two"], { cwd: join(workspace, "module") });
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" }))
        .rejects.toThrow('securefix does not allow submodule "module"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(submodule, { recursive: true, force: true });
    }
  });

  test("rejects a non-regular changed path from a real Git worktree", async () => {
    const workspace = await gitWorkspace("securefix-nonregular-test-");
    try {
      await writeFile(join(workspace, "pipe"), "regular first\n");
      execFileSync("git", ["add", "pipe"], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "track pipe"], { cwd: workspace });
      await rm(join(workspace, "pipe"));
      execFileSync("mkfifo", ["pipe"], { cwd: workspace });
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" }))
        .rejects.toThrow('securefix path "pipe" is not a regular file');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    ["untracked symlink", false],
    ["changed tracked symlink", true],
  ])("rejects a %s from a real Git worktree", async (_name, tracked) => {
    const workspace = await gitWorkspace("securefix-symlink-test-");
    try {
      await writeFile(join(workspace, "target.txt"), "target\n");
      if (tracked) {
        await symlink("target.txt", join(workspace, "link.txt"));
        execFileSync("git", ["add", "target.txt", "link.txt"], { cwd: workspace });
        execFileSync("git", ["commit", "-qm", "tracked symlink"], { cwd: workspace });
        await rm(join(workspace, "link.txt"));
        await symlink("other.txt", join(workspace, "link.txt"));
      } else {
        await symlink("target.txt", join(workspace, "link.txt"));
      }
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" }))
        .rejects.toThrow('securefix does not allow symlink "link.txt"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    ["single file limit", [{ name: "large", size: 8 * 1024 * 1024 + 1 }], 'securefix file "large" is larger than 8MB'],
    ["total file limit", [{ name: "a", size: 6 * 1024 * 1024 }, { name: "b", size: 5 * 1024 * 1024 }], "securefix files are larger than 10MB in total"],
  ])("rejects %s while packaging real file contents", async (_name, files, message) => {
    const workspace = await gitWorkspace("securefix-content-size-test-");
    try {
      for (const file of files) await writeFile(join(workspace, file.name), Buffer.alloc(file.size));
      await expect(buildSecurefixArtifact({ workspace, repository: repo, runId: 42, headSha: sha, message: "update" })).rejects.toThrow(message);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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

  test.each([
    ["artifact root symlink", async (root: string) => {
      const target = await mkdtemp(join(tmpdir(), "securefix-root-target-"));
      await writeArtifact(target, []);
      await symlink(target, root);
      return () => rm(target, { recursive: true, force: true });
    }, "securefix artifact root is not a regular directory"],
    ["manifest symlink", async (root: string) => {
      await mkdir(join(root, "files"), { recursive: true });
      const target = join(root, "external-manifest.json");
      await writeFile(target, JSON.stringify(manifest()));
      await symlink(target, join(root, "manifest.json"));
      return () => Promise.resolve();
    }, "securefix manifest is not a regular file under 1MB"],
    ["invalid JSON", async (root: string) => {
      await mkdir(join(root, "files"), { recursive: true });
      await writeFile(join(root, "manifest.json"), "{");
      return () => Promise.resolve();
    }, "securefix manifest is not valid JSON"],
  ] as const)("rejects %s", async (_name, setup, message) => {
    const parent = await mkdtemp(join(tmpdir(), "securefix-artifact-root-test-"));
    const root = join(parent, "artifact");
    const cleanup = await setup(root);
    try {
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow(message);
    } finally {
      await cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test.each([
    ["non-regular payload", async (root: string) => {
      await writeArtifact(root, [{ kind: "write", path: "file.txt", size: 0, sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex") }]);
      await rm(join(root, "files", "0000"), { force: true });
      await mkdir(join(root, "files", "0000"));
    }, 'securefix payload for "file.txt" is not a regular file'],
    ["payload size", async (root: string) => {
      const body = Buffer.from("payload");
      await writeArtifact(root, [{ kind: "write", path: "file.txt", size: body.length + 1, sha256: createHash("sha256").update(body).digest("hex") }], new Map([[0, body]]));
    }, 'securefix payload size does not match metadata for "file.txt"'],
    ["payload digest", async (root: string) => {
      const body = Buffer.from("payload");
      await writeArtifact(root, [{ kind: "write", path: "file.txt", size: body.length, sha256: "0".repeat(64) }], new Map([[0, body]]));
    }, 'securefix payload digest does not match metadata for "file.txt"'],
    ["unsupported artifact entry", async (root: string) => {
      await writeArtifact(root, []);
      execFileSync("mkfifo", [join(root, "files", "unexpected")]);
    }, 'securefix artifact contains unsupported entry "files/unexpected"'],
  ] as const)("rejects %s", async (_name, setup, message) => {
    const root = await mkdtemp(join(tmpdir(), "securefix-payload-reject-test-"));
    try {
      await setup(root);
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a manifest larger than 1MB before parsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "securefix-large-manifest-test-"));
    try {
      await mkdir(join(root, "files"));
      await writeFile(join(root, "manifest.json"), Buffer.alloc(1024 * 1024 + 1, 32));
      await expect(readSecurefixArtifact(root, { repository: repo, runId: 42, headSha: sha })).rejects.toThrow("securefix manifest is not a regular file under 1MB");
    } finally {
      await rm(root, { recursive: true, force: true });
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
    [{ ...run, head_repository: { id: 2, full_name: "fork/repo" } }, "securefix workflow run is not from the same repository"],
    [{ ...run, head_sha: "not-a-sha" }, "workflow run has an invalid head sha"],
    [{ ...run, event: "schedule" }, "securefix does not accept schedule events"],
    [{ ...run, pull_requests: [] }, "securefix PR run must map to exactly one pull request"],
    [{ ...run, pull_requests: [{ ...run.pull_requests[0]!, head: { ...run.pull_requests[0]!.head, ref: "elsewhere" } }] }, "securefix workflow branch does not match the pull request head"],
  ])("rejects an untrusted run", (value, message) => {
    expect(() => validateSecurefixRun(value, 42, repo)).toThrow(message);
  });

  test("rejects a requested run id that differs from the GitHub run", () => {
    expect(() => validateSecurefixRun(run, 43, repo)).toThrow("workflow run id does not match the request");
  });

  const bindingCases: { name: string; value: Parameters<typeof bindSecurefixPullRequest>[2]; count: number; message: string; sourceRun?: SecurefixRun }[] = [
    { name: "non-PR mode", value: pull, count: 1, message: "securefix PR mode requires a pull_request workflow run", sourceRun: { ...run, event: "push" } },
    { name: "wrong base", value: { ...pull, base: { ref: "attacker", sha } }, count: 1, message: "securefix PR must target the default branch" },
    { name: "fork", value: { ...pull, head: { ...pull.head, repo: { full_name: "forker/repo" } } }, count: 1, message: "securefix does not accept fork pull requests" },
    { name: "different PR", value: { ...pull, number: 8 }, count: 1, message: "securefix workflow is not bound to an open, ready pull request" },
    { name: "closed PR", value: { ...pull, state: "closed" }, count: 1, message: "securefix workflow is not bound to an open, ready pull request" },
    { name: "draft PR", value: { ...pull, draft: true }, count: 1, message: "securefix workflow is not bound to an open, ready pull request" },
    { name: "current head branch mismatch", value: { ...pull, head: { ...pull.head, ref: "renamed" } }, count: 1, message: "securefix PR head branch does not match the workflow run" },
    { name: "recorded base mismatch", value: pull, count: 1, message: "securefix PR must target the default branch", sourceRun: { ...run, pull_requests: [{ ...run.pull_requests[0]!, base: { ref: "attacker", sha } }] } },
    { name: "ambiguous branch", value: pull, count: 2, message: "securefix PR head has more than one open pull request" },
  ];
  test.each(bindingCases)("rejects PR binding with $name", ({ value, count, message, sourceRun = run }) => {
    expect(() => bindSecurefixPullRequest(sourceRun, "main", value, count, repo)).toThrow(message);
  });

  test("defers current-head matching until exact retry recovery is checked", () => {
    const moved = { ...pull, head: { ...pull.head, sha: "b".repeat(40) } };
    expect(() => bindSecurefixPullRequest(run, "main", moved, 1, repo)).not.toThrow();
  });

  test("uses the workflow run head when GitHub updates the run's pull request head", () => {
    const updatedRun = { ...run, pull_requests: [{ ...run.pull_requests[0]!, head: { ...run.pull_requests[0]!.head, sha: "b".repeat(40) } }] };
    expect(() => validateSecurefixRun(updatedRun, 42, repo)).not.toThrow();
    expect(() => bindSecurefixPullRequest(updatedRun, "main", pull, 1, repo)).not.toThrow();
  });

  test("rejects route workflow, scope and moved source head", () => {
    expect(findSecurefixRoute([route], routeRun, "main")).toEqual(route);
    expect(() => findSecurefixRoute([route, { ...route, name: "another" }], routeRun, "main")).toThrow("workflow run does not match exactly one securefix route");
    expect(() => validateSecurefixRouteHead(routeRun, route, "main", "b".repeat(40))).toThrow("securefix route head is not the current head of its source branch");
    expect(() => validateRouteChanges(route, [{ kind: "write", path: "README.md", content: Buffer.from("x") }], new Map())).toThrow('securefix route does not allow path "README.md"');
  });

  const routeCases: { name: string; routes: readonly SecurefixRoute[]; value: SecurefixRun; message: string }[] = [
    { name: "unmatched workflow", routes: [], value: routeRun, message: "workflow run does not match exactly one securefix route" },
    { name: "route event", routes: [route], value: { ...routeRun, event: "pull_request" }, message: "securefix route requires push or workflow_dispatch" },
    { name: "source branch", routes: [route], value: { ...routeRun, head_branch: "feature" }, message: "securefix route expected branch main, got feature" },
  ];
  test.each(routeCases)("rejects $name", ({ routes, value, message }) => {
    expect(() => findSecurefixRoute(routes, value, "main")).toThrow(message);
  });

  test.each([
    ["version-only deletion", [{ kind: "delete" as const, path: "package.json" }], new Map<string, Buffer | null>(), 'securefix route requires a version line change for "package.json"'],
    ["missing original version-only file", [{ kind: "write" as const, path: "package.json", content: Buffer.from('{"version":"1.0.0"}\n') }], new Map<string, Buffer | null>(), 'securefix route cannot find the original file "package.json"'],
  ])("rejects route version-only case: %s", (_name, changes, originals, message) => {
    expect(() => validateRouteChanges(route, changes, originals)).toThrow(message);
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

  test.each([
    ["rename with no prior filename", { filename: "CHANGELOG.md", status: "renamed" }, Buffer.from("before\n"), Buffer.from("after\n"), "securefix route rename has no previous filename"],
    ["missing post-change content", { filename: "CHANGELOG.md", status: "modified" }, Buffer.from("before\n"), null, 'securefix route commit has no content for "CHANGELOG.md"'],
  ] as const)("rejects route commit file case: %s", (_name, file, before, after, message) => {
    expect(() => validateSecurefixRouteCommitFile(route, file, before, after)).toThrow(message);
  });
});
