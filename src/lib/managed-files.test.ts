import { describe, expect, spyOn, test } from "bun:test";
import * as gitRef from "./git-ref.ts";
import { applyManagedFiles, inspectManagedFiles, validateManagedFiles } from "./managed-files.ts";
import type { GitHub } from "./github.ts";

const defaultSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const blobSha = "d".repeat(40);
const defaultTreeSha = "e".repeat(40);
const targetBlobSha = "f".repeat(40);

describe("validateManagedFiles", () => {
  test.each([
    ["empty path", { "": "x" }, "managed file path \"\" is absolute or contains a control character"],
    ["absolute path", { "/etc/passwd": "x" }, "managed file path \"/etc/passwd\" is absolute or contains a control character"],
    ["drive path", { "C:/repo/file": "x" }, "managed file path \"C:/repo/file\" is absolute or contains a control character"],
    ["backslash path", { "a\\b": "x" }, "managed file path \"a\\\\b\" is absolute or contains a control character"],
    ["control character", { "a\nb": "x" }, "managed file path \"a\\nb\" is absolute or contains a control character"],
    ["parent segment", { "a/../b": "x" }, "managed file path \"a/../b\" contains .."],
    ["git metadata", { "a/.GiT/config": "x" }, "managed file path \"a/.GiT/config\" contains a .git segment"],
    ["unnormalized path", { "a//b": "x" }, "managed file path \"a//b\" is not normalized"],
    ["dot segment", { "a/./b": "x" }, "managed file path \"a/./b\" is not normalized"],
    ["glob path", { "a/*.yml": "x" }, "managed file path \"a/*.yml\" contains a glob character"],
    ["prefix collision", { "a": "x", "a/b": "y" }, "managed file paths conflict at \"a\""],
    ["per-file limit", { "a": "x".repeat(8 * 1024 * 1024 + 1) }, "managed file \"a\" is larger than 8MB"],
    ["total limit", { "a": "x".repeat(8 * 1024 * 1024), "b": "y".repeat(2 * 1024 * 1024 + 1) }, "managed files are larger than 10MB in total"],
    ["file count", Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`${index}.txt`, "x"])), "managed files has more than 512 files"],
  ])("rejects %s", (_name, files, message) => {
    expect(() => validateManagedFiles(files)).toThrow(message);
  });

  test("accepts normalized literal paths and sorts them", () => {
    expect(validateManagedFiles({ "z/file.txt": "z", "a/file.txt": "a" })).toEqual([
      { path: "a/file.txt", content: "a" },
      { path: "z/file.txt", content: "z" },
    ]);
  });
});

function githubFixture(options: {
  targetContent?: string;
  sourceContent?: string;
  targetMode?: string;
  targetMissing?: boolean;
  signatureValid?: boolean;
  treeTruncated?: boolean;
  incompleteHistory?: boolean;
  duplicateHistoryPage?: boolean;
  missingMergeBase?: boolean;
  pulls?: Array<{ number: number; title: string; body: string | null; base: { ref: string }; head: { sha: string } }>;
  history?: Array<{ sha: string; parent: string; filename: string; previousFilename?: string }>;
} = {}): GitHub {
  const history = options.history ?? [{ sha: targetSha, parent: defaultSha, filename: "managed.yml" }];
  const commitFor = (ref: string) => {
    if (ref === defaultSha) return { parents: [], author: { id: 500 }, committer: { login: "owner" }, commit: { verification: { verified: true }, tree: { sha: defaultTreeSha } } };
    return {
      parents: [{ sha: history.find((item) => item.sha === ref)?.parent ?? defaultSha }],
      files: [{
        filename: history.find((item) => item.sha === ref)?.filename ?? "managed.yml",
        ...(history.find((item) => item.sha === ref)?.previousFilename ? { previous_filename: history.find((item) => item.sha === ref)?.previousFilename } : {}),
      }],
      author: { id: 900 },
      committer: { login: "web-flow" },
      commit: { verification: { verified: true }, tree: { sha: treeSha } },
    };
  };
  const listPulls = async () => ({ data: options.pulls ?? (options.targetMissing ? [] : [{
    number: 73,
    title: "Sync managed files",
    body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->",
    base: { ref: "main" },
    head: { sha: targetSha },
  }]) });
  const gh = {
    rest: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: defaultSha } } };
          if (options.targetMissing) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: { sha: targetSha } } };
        },
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: options.treeTruncated ?? false, tree: [{ path: "managed.yml", type: "blob", mode: options.targetMode ?? "100644", sha: tree_sha === defaultTreeSha ? blobSha : targetBlobSha }] } }),
        getBlob: async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: Buffer.from(file_sha === blobSha ? options.sourceContent ?? "old\n" : options.targetContent ?? "wanted\n").toString("base64") } }),
      },
      repos: {
        getCommit: async ({ ref }: { ref: string }) => ({ data: commitFor(ref) }),
        compareCommitsWithBasehead: async ({ page }: { page?: number }) => ({ data: {
          ahead_by: options.incompleteHistory ? history.length + 1 : history.length,
          ...(options.missingMergeBase ? {} : { merge_base_commit: { sha: defaultSha } }),
          commits: page === 2 && options.duplicateHistoryPage ? history.map(({ sha }) => ({ sha })) : page ? [] : history.map(({ sha }) => ({ sha })),
        } }),
      },
      pulls: { list: listPulls },
    },
    paginate: async (method: unknown) => method === listPulls ? options.targetMissing ? [] : (await listPulls()).data : [],
    graphql: async () => ({ repository: { commit: { signature: { isValid: options.signatureValid ?? true, wasSignedByGitHub: true } } } }),
  };
  return gh as unknown as GitHub;
}

describe("inspectManagedFiles", () => {
  const input = { repository: "owner/repo", defaultBranch: "main", serverBotId: 900, files: { "managed.yml": "wanted\n" } };

  test("recognizes an exact repeat after validating the server-owned branch history", async () => {
    const result = await inspectManagedFiles(githubFixture(), input);
    expect(result.status).toBe("already-applied");
    expect(result.changedPaths).toEqual(["managed.yml"]);
    expect(result.targetSha).toBe(targetSha);
  });

  test("rejects a branch change outside the configured managed paths", async () => {
    await expect(inspectManagedFiles(githubFixture({ history: [{ sha: targetSha, parent: defaultSha, filename: "unmanaged.txt" }] }), input))
      .rejects.toThrow('managed files branch changed unmanaged path "unmanaged.txt"');
  });

  test("rejects a rename whose previous path is outside the managed path set", async () => {
    await expect(inspectManagedFiles(githubFixture({ history: [{ sha: targetSha, parent: defaultSha, filename: "managed.yml", previousFilename: "unmanaged.txt" }] }), input))
      .rejects.toThrow('managed files branch changed unmanaged path "unmanaged.txt"');
  });

  test("rejects a symlink instead of reading it as a regular managed file", async () => {
    await expect(inspectManagedFiles(githubFixture({ targetMode: "120000" }), input))
      .rejects.toThrow('managed file "managed.yml" is not a regular file in the Git tree');
  });

  test("rejects a non-linear server-owned history", async () => {
    await expect(inspectManagedFiles(githubFixture({ history: [{ sha: targetSha, parent: "e".repeat(40), filename: "managed.yml" }] }), input))
      .rejects.toThrow("managed files branch contains a merge or root commit");
  });

  test("rejects an incomplete paginated commit history", async () => {
    await expect(inspectManagedFiles(githubFixture({ incompleteHistory: true }), input))
      .rejects.toThrow("managed files branch commit list is incomplete");
  });

  test("rejects a repeated commit page instead of treating history as complete", async () => {
    await expect(inspectManagedFiles(githubFixture({ incompleteHistory: true, duplicateHistoryPage: true }), input))
      .rejects.toThrow("managed files branch commit list is incomplete");
  });

  test("rejects a comparison without a merge base", async () => {
    await expect(inspectManagedFiles(githubFixture({ missingMergeBase: true }), input))
      .rejects.toThrow("managed files branch commit list is incomplete");
  });

  test("rejects a comparison whose commits do not reach the target branch head", async () => {
    await expect(inspectManagedFiles(githubFixture({ history: [{ sha: "f".repeat(40), parent: defaultSha, filename: "managed.yml" }] }), input))
      .rejects.toThrow("managed files branch commit list is incomplete");
  });

  test("rejects a commit without a valid GitHub signature", async () => {
    await expect(inspectManagedFiles(githubFixture({ signatureValid: false }), input))
      .rejects.toThrow("managed files branch contains a commit not made by the server");
  });

  test("rejects a truncated Git tree", async () => {
    await expect(inspectManagedFiles(githubFixture({ treeTruncated: true }), input))
      .rejects.toThrow("managed files could not safely inspect a Git tree");
  });

  test("creates the managed branch from the current default head without calling the reset lease", async () => {
    const read = githubFixture({ targetMissing: true });
    let createdRef = false;
    let createdPr = false;
    let branchSha = defaultSha;
    const writeClient = {
      rest: {
        git: {
          getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : branchSha } } }),
          createRef: async () => { createdRef = true; return { data: {} }; },
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => { createdPr = true; return { data: { number: 73 } }; },
        },
      },
      paginate: async () => [],
      graphql: async () => { branchSha = targetSha; return { createCommitOnBranch: { commit: { oid: targetSha } } }; },
    } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => { throw new Error("unexpected reset"); });
    try {
      const result = await applyManagedFiles(read, { ...input, writeToken: "unused", writeClient });
      expect(result).toEqual({ status: "applied", commit: targetSha, pullRequest: 73 });
      expect(createdRef).toBe(true);
      expect(createdPr).toBe(true);
      expect(reset).not.toHaveBeenCalled();
    } finally {
      reset.mockRestore();
    }
  });

  test("resets only the managed branch to the observed default SHA before a changed-content commit", async () => {
    const read = githubFixture({ targetContent: "stale\n" });
    let branchSha = defaultSha;
    const writeClient = {
      rest: {
        git: {
          getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : branchSha } } }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { number: 74 } }),
        },
      },
      paginate: async () => [],
      graphql: async () => { branchSha = targetSha; return { createCommitOnBranch: { commit: { oid: targetSha } } }; },
    } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => undefined);
    try {
      const result = await applyManagedFiles(read, { ...input, writeToken: "test-token", writeClient });
      expect(result).toEqual({ status: "applied", commit: targetSha, pullRequest: 74 });
      expect(reset).toHaveBeenCalledWith({
        remote: "https://github.com/owner/repo.git",
        sourceBranch: "main",
        targetBranch: "csm-ci/repo-settings",
        sourceSha: defaultSha,
        expectedTargetSha: targetSha,
        token: "test-token",
      });
    } finally {
      reset.mockRestore();
    }
  });

  test("rejects the managed branch as the repository default branch", async () => {
    await expect(inspectManagedFiles(githubFixture(), { ...input, defaultBranch: "csm-ci/repo-settings" }))
      .rejects.toThrow("managed files branch csm-ci/repo-settings cannot be the repository default branch");
  });

  test("requests a PR-only retry when commit succeeded but PR creation was interrupted", async () => {
    const result = await inspectManagedFiles(githubFixture({ pulls: [] }), input);
    expect(result.status).toBe("ready");
    expect(result.branchNeedsWrite).toBe(false);
    expect(result.requiresPullRequestUpdate).toBe(true);
    expect(result.requiresWorkflowsWrite).toBe(false);
  });

  test("rejects an open managed branch PR with a different base before apply", async () => {
    const gh = githubFixture({ pulls: [{
      number: 73,
      title: "Sync managed files",
      body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->",
      base: { ref: "release" },
      head: { sha: targetSha },
    }] });
    await expect(inspectManagedFiles(gh, input)).rejects.toThrow("managed files branch has an open pull request for a different base branch");
  });

  test("rejects multiple open PRs for the managed branch", async () => {
    const pulls = Array.from({ length: 2 }, (_, index) => ({
      number: 73 + index,
      title: "Sync managed files",
      body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->",
      base: { ref: "main" },
      head: { sha: targetSha },
    }));
    await expect(inspectManagedFiles(githubFixture({ pulls }), input))
      .rejects.toThrow("managed files branch has multiple open pull requests");
  });

  test("rejects a managed branch PR whose head differs from the branch ref", async () => {
    const pulls = [{
      number: 73,
      title: "Sync managed files",
      body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->",
      base: { ref: "main" },
      head: { sha: "f".repeat(40) },
    }];
    await expect(inspectManagedFiles(githubFixture({ pulls }), input))
      .rejects.toThrow("managed files pull request head does not match the branch head");
  });

  test("rejects branch creation if the default ref moved after inspection", async () => {
    const read = githubFixture({ targetMissing: true });
    let createdRef = false;
    const writeClient = {
      rest: {
        git: {
          getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? targetSha : defaultSha } } }),
          createRef: async () => { createdRef = true; return { data: {} }; },
        },
        pulls: { list: async () => ({ data: [] }) },
      },
      paginate: async () => [],
      graphql: async () => ({ createCommitOnBranch: { commit: { oid: targetSha } } }),
    } as unknown as GitHub;
    await expect(applyManagedFiles(read, { ...input, writeToken: "unused", writeClient }))
      .rejects.toThrow("managed files default branch moved before branch creation");
    expect(createdRef).toBe(false);
  });

  test("rejects PR update if the managed branch ref moved after inspection", async () => {
    const read = githubFixture({ targetContent: "wanted\n", pulls: [] });
    const writeClient = {
      rest: {
        git: { getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : "f".repeat(40) } } }) },
        pulls: { list: async () => ({ data: [] }) },
      },
      paginate: async () => [],
    } as unknown as GitHub;
    await expect(applyManagedFiles(read, { ...input, writeToken: "unused", writeClient }))
      .rejects.toThrow("managed files branch moved before pull request update");
  });

  test("does not inspect or reopen the managed branch when default already matches", async () => {
    const result = await inspectManagedFiles(githubFixture({ sourceContent: "wanted\n", pulls: [] }), input);
    expect(result.status).toBe("already-applied");
    expect(result.targetSha).toBeNull();
    expect(result.requiresPullRequestUpdate).toBe(false);
  });
});
