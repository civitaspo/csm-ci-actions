import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { GitRefChanged, resetBranchWithLease } from "./git-ref.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
}

describe("resetBranchWithLease", () => {
  test("resets only when the observed target SHA is still current", async () => {
    const root = await mkdtemp(join(tmpdir(), "securefix-git-ref-test-"));
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    try {
      execFileSync("git", ["init", "--bare", remote]);
      execFileSync("git", ["init", "--initial-branch=main", workspace]);
      git(workspace, "config", "user.name", "test");
      git(workspace, "config", "user.email", "test@example.com");
      git(workspace, "config", "commit.gpgsign", "false");
      await writeFile(join(workspace, "file"), "source\n");
      git(workspace, "add", "file");
      git(workspace, "commit", "-m", "source");
      const sourceSha = git(workspace, "rev-parse", "HEAD");
      git(workspace, "checkout", "-b", "release/next");
      await writeFile(join(workspace, "file"), "route\n");
      git(workspace, "commit", "-am", "route");
      const observedTargetSha = git(workspace, "rev-parse", "HEAD");
      git(workspace, "remote", "add", "origin", remote);
      git(workspace, "push", "origin", "main", "release/next");

      await resetBranchWithLease({ remote, sourceBranch: "main", targetBranch: "release/next", sourceSha, expectedTargetSha: observedTargetSha, token: "not-a-real-token" });
      expect(git(workspace, "ls-remote", remote, "refs/heads/release/next").split("\t")[0]).toBe(sourceSha);

      await writeFile(join(workspace, "file"), "concurrent\n");
      git(workspace, "commit", "-am", "concurrent");
      const movedSha = git(workspace, "rev-parse", "HEAD");
      git(workspace, "push", "origin", "HEAD:refs/heads/release/next", "--force");
      await expect(resetBranchWithLease({ remote, sourceBranch: "main", targetBranch: "release/next", sourceSha, expectedTargetSha: observedTargetSha, token: "not-a-real-token" })).rejects.toBeInstanceOf(GitRefChanged);
      expect(git(workspace, "ls-remote", remote, "refs/heads/release/next").split("\t")[0]).toBe(movedSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates a missing target branch only when the expected SHA is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "securefix-git-ref-create-test-"));
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", timeout: 30_000 });
      execFileSync("git", ["init", "--initial-branch=main", workspace], { stdio: "ignore", timeout: 30_000 });
      git(workspace, "config", "user.name", "test");
      git(workspace, "config", "user.email", "test@example.com");
      git(workspace, "config", "commit.gpgsign", "false");
      await writeFile(join(workspace, "file"), "source\n");
      git(workspace, "add", "file");
      git(workspace, "commit", "-m", "source");
      const sourceSha = git(workspace, "rev-parse", "HEAD");
      git(workspace, "remote", "add", "origin", remote);
      git(workspace, "push", "origin", "main");

      await resetBranchWithLease({ remote, sourceBranch: "main", targetBranch: "release/next", sourceSha, expectedTargetSha: null, token: "not-a-real-token" });
      expect(git(workspace, "ls-remote", remote, "refs/heads/release/next").split("\t")[0]).toBe(sourceSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { sourceBranch: "bad..branch", targetBranch: "release/next" },
    { sourceBranch: "main", targetBranch: "bad..branch" },
    { sourceBranch: "--upload-pack=evil", targetBranch: "release/next" },
  ])("rejects unsafe branch names before fetching or pushing: $sourceBranch -> $targetBranch", async ({ sourceBranch, targetBranch }) => {
    const root = await mkdtemp(join(tmpdir(), "securefix-git-ref-invalid-test-"));
    const remote = join(root, "remote.git");
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", timeout: 30_000 });
      await expect(resetBranchWithLease({ remote, sourceBranch, targetBranch, sourceSha: "a".repeat(40), expectedTargetSha: null, token: "not-a-real-token" })).rejects.toThrow();
      expect(git(root, "--git-dir", remote, "for-each-ref", "--format=%(refname)")).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
