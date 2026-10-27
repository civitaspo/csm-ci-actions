import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { rebuildBranchWithLease } from "./branch-rebuild.ts";
import { GitRefChanged } from "./git-ref.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
}

type Fixture = { remote: string; workspace: string; sourceSha: string; targetSha: string | null };

async function withRemote(withTarget: boolean, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "branch-rebuild-test-"));
  const remote = join(root, "remote.git");
  const workspace = join(root, "workspace");
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", timeout: 30_000 });
    execFileSync("git", ["init", "--initial-branch=main", workspace], { stdio: "ignore", timeout: 30_000 });
    git(workspace, "config", "user.name", "test");
    git(workspace, "config", "user.email", "test@example.com");
    git(workspace, "config", "commit.gpgsign", "false");
    git(workspace, "remote", "add", "origin", remote);
    await writeFile(join(workspace, "file"), "source\n");
    git(workspace, "add", "file");
    git(workspace, "commit", "-m", "source");
    const sourceSha = git(workspace, "rev-parse", "HEAD");
    git(workspace, "push", "origin", "main");
    let targetSha: string | null = null;
    if (withTarget) {
      git(workspace, "checkout", "-b", "release/next");
      await writeFile(join(workspace, "file"), "old route\n");
      git(workspace, "commit", "-am", "old route");
      targetSha = git(workspace, "rev-parse", "HEAD");
      git(workspace, "push", "origin", "release/next");
      git(workspace, "checkout", "main");
    }
    await run({ remote, workspace, sourceSha, targetSha });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function remoteHeads(remote: string): string[] {
  return git(remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean).sort();
}

// Stands in for createCommitOnBranch: commits on the branch only if its head is still expectedHeadOid.
function commitOn(fixture: Fixture, branch: string, expectedHeadOid: string): string {
  git(fixture.workspace, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/temporary`);
  git(fixture.workspace, "checkout", "--detach", "refs/remotes/origin/temporary");
  execFileSync("git", ["-C", fixture.workspace, "commit", "--allow-empty", "-m", "new route"], { stdio: "ignore", timeout: 30_000 });
  const sha = git(fixture.workspace, "rev-parse", "HEAD");
  git(fixture.workspace, "push", `--force-with-lease=refs/heads/${branch}:${expectedHeadOid}`, "origin", `${sha}:refs/heads/${branch}`);
  return sha;
}

function deleter(fixture: Fixture, deleted: string[]) {
  return async (branch: string) => {
    deleted.push(branch);
    git(fixture.workspace, "push", "origin", "--delete", branch);
  };
}

const base = (fixture: Fixture) => ({ remote: fixture.remote, sourceBranch: "main", sourceSha: fixture.sourceSha, targetBranch: "release/next", token: "not-a-real-token", temporaryName: "route" });

describe("rebuildBranchWithLease", () => {
  test.each([true, false])("builds the commit on a temporary branch, moves the target to it, and deletes the temporary branch (existing target=%s)", async (withTarget) => {
    await withRemote(withTarget, async (fixture) => {
      const deleted: string[] = [];
      const committed: string[] = [];
      const commit = await rebuildBranchWithLease({
        ...base(fixture),
        expectedTargetSha: fixture.targetSha,
        commit: async (temporaryBranch) => {
          expect(temporaryBranch).toMatch(/^csm-ci\/tmp\/route-[a-f0-9]{16}$/u);
          expect(git(fixture.remote, "rev-parse", `refs/heads/${temporaryBranch}`)).toBe(fixture.sourceSha);
          if (fixture.targetSha) expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(fixture.targetSha);
          committed.push(temporaryBranch);
          return commitOn(fixture, temporaryBranch, fixture.sourceSha);
        },
        deleteBranch: deleter(fixture, deleted),
      });
      expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(commit);
      expect(git(fixture.remote, "rev-parse", `${commit}^`)).toBe(fixture.sourceSha);
      expect(deleted).toEqual(committed);
      expect(remoteHeads(fixture.remote)).toEqual(["refs/heads/main", "refs/heads/release/next"]);
    });
  });

  test("rejects the move when the target moved after it was observed and still deletes the temporary branch", async () => {
    await withRemote(true, async (fixture) => {
      const deleted: string[] = [];
      git(fixture.workspace, "checkout", "release/next");
      await writeFile(join(fixture.workspace, "file"), "concurrent\n");
      git(fixture.workspace, "commit", "-am", "concurrent");
      const movedSha = git(fixture.workspace, "rev-parse", "HEAD");
      git(fixture.workspace, "push", "origin", "release/next");
      await expect(rebuildBranchWithLease({
        ...base(fixture),
        expectedTargetSha: fixture.targetSha,
        commit: async (temporaryBranch) => commitOn(fixture, temporaryBranch, fixture.sourceSha),
        deleteBranch: deleter(fixture, deleted),
      })).rejects.toBeInstanceOf(GitRefChanged);
      expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(movedSha);
      expect(deleted).toHaveLength(1);
      expect(remoteHeads(fixture.remote)).toEqual(["refs/heads/main", "refs/heads/release/next"]);
    });
  });

  test("rejects creating an absent target that appeared after it was observed", async () => {
    await withRemote(true, async (fixture) => {
      await expect(rebuildBranchWithLease({
        ...base(fixture),
        expectedTargetSha: null,
        commit: async (temporaryBranch) => commitOn(fixture, temporaryBranch, fixture.sourceSha),
        deleteBranch: deleter(fixture, []),
      })).rejects.toBeInstanceOf(GitRefChanged);
      expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(fixture.targetSha ?? "");
      expect(remoteHeads(fixture.remote)).toEqual(["refs/heads/main", "refs/heads/release/next"]);
    });
  });

  test("deletes the temporary branch when the commit fails and keeps the original error over a deletion failure", async () => {
    await withRemote(true, async (fixture) => {
      const failure = new Error("commit failed");
      const deleted: string[] = [];
      await expect(rebuildBranchWithLease({
        ...base(fixture),
        expectedTargetSha: fixture.targetSha,
        commit: async () => { throw failure; },
        deleteBranch: async (branch) => {
          await deleter(fixture, deleted)(branch);
          throw new Error("delete failed");
        },
      })).rejects.toBe(failure);
      expect(deleted).toHaveLength(1);
      expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(fixture.targetSha ?? "");
      expect(remoteHeads(fixture.remote)).toEqual(["refs/heads/main", "refs/heads/release/next"]);
    });
  });

  test("rejects when the source moved before the temporary branch was created", async () => {
    await withRemote(true, async (fixture) => {
      const deleted: string[] = [];
      let committed = false;
      await expect(rebuildBranchWithLease({
        ...base(fixture),
        sourceSha: "f".repeat(40),
        expectedTargetSha: fixture.targetSha,
        commit: async () => { committed = true; return "f".repeat(40); },
        deleteBranch: async (branch) => { deleted.push(branch); },
      })).rejects.toBeInstanceOf(GitRefChanged);
      expect(committed).toBe(false);
      expect(deleted).toHaveLength(1);
      expect(git(fixture.remote, "rev-parse", "refs/heads/release/next")).toBe(fixture.targetSha ?? "");
    });
  });
});
