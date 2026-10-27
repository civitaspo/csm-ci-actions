import { describe, expect, spyOn, test } from "bun:test";
import * as gitRef from "./git-ref.ts";
import { applyManagedFiles, inspectManagedFiles, validateManagedFiles } from "./managed-files.ts";
import type { GitHub } from "./github.ts";
import { repoSettingsManagedFiles } from "./config.ts";

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
  funding?: boolean;
  targetContent?: string;
  sourceContent?: string;
  targetMode?: string;
  blobEncoding?: string;
  treeEntry?: { path: string; type: string; mode: string; sha?: string };
  changedFiles?: "missing" | number;
  targetMissing?: boolean;
  signatureValid?: boolean;
  treeTruncated?: boolean;
  incompleteHistory?: boolean;
  duplicateHistoryPage?: boolean;
  missingMergeBase?: boolean;
  comparisonCalls?: { count: number };
  pulls?: Array<{ number: number; title: string; body: string | null; base: { ref: string }; head: { sha: string } }>;
  history?: Array<{ sha: string; parent: string; filename: string; previousFilename?: string }>;
} = {}): GitHub {
  const managedPath = options.funding ? ".github/FUNDING.yml" : "managed.yml";
  const history = options.history ?? [{ sha: targetSha, parent: defaultSha, filename: managedPath }];
  const commitFor = (ref: string) => {
    if (ref === defaultSha) return { parents: [], author: { id: 500 }, committer: { login: "owner" }, commit: { verification: { verified: true }, tree: { sha: defaultTreeSha } } };
    return {
      parents: [{ sha: history.find((item) => item.sha === ref)?.parent ?? defaultSha }],
      ...(options.changedFiles === "missing" ? {} : { files: options.changedFiles !== undefined ? Array.from({ length: options.changedFiles }, () => ({ filename: "managed.yml" })) : [{
        filename: history.find((item) => item.sha === ref)?.filename ?? "managed.yml",
        ...(history.find((item) => item.sha === ref)?.previousFilename ? { previous_filename: history.find((item) => item.sha === ref)?.previousFilename } : {}),
      }] }),
      author: { id: 900 },
      committer: { login: "web-flow" },
      commit: { verification: { verified: true }, tree: { sha: treeSha } },
    };
  };
  const listPulls = async () => ({ data: options.pulls ?? (options.targetMissing ? [] : [{
    number: 73,
    title: "chore(repo-settings): sync managed files",
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
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: options.treeTruncated ?? false, tree: [options.funding && !tree_sha.startsWith("funding-tree") ? { path: ".github", type: "tree", mode: "040000", sha: `funding-tree-${tree_sha}` } : options.treeEntry ?? { path: options.funding ? "FUNDING.yml" : "managed.yml", type: "blob", mode: options.targetMode ?? "100644", sha: (tree_sha === defaultTreeSha || tree_sha === `funding-tree-${defaultTreeSha}`) ? blobSha : targetBlobSha }] } }),
        getBlob: async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: options.blobEncoding ?? "base64", content: Buffer.from(file_sha === blobSha ? options.sourceContent ?? "old\n" : options.targetContent ?? "wanted\n").toString("base64") } }),
      },
      repos: {
        getCommit: async ({ ref }: { ref: string }) => ({ data: commitFor(ref) }),
        compareCommitsWithBasehead: async ({ page }: { page?: number }) => {
          if (options.comparisonCalls) options.comparisonCalls.count++;
          if (page !== undefined && page > 2) throw new Error(`unexpected comparison page ${page}`);
          return { data: {
            ahead_by: options.incompleteHistory ? history.length + 1 : history.length,
            ...(options.missingMergeBase ? {} : { merge_base_commit: { sha: history.length === 0 ? targetSha : defaultSha } }),
            commits: page === 2 && options.duplicateHistoryPage ? history.map(({ sha }) => ({ sha })) : page ? [] : history.map(({ sha }) => ({ sha })),
          } };
        },
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

  test("rebuilds a managed branch that is an ancestor of default even when its files match", async () => {
    const result = await inspectManagedFiles(githubFixture({ history: [], targetContent: "wanted\n" }), input);
    expect(result.status).toBe("ready");
    expect(result.branchNeedsWrite).toBe(true);
    expect(result.requiresWorkflowsWrite).toBe(true);
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

  test("rejects an untrusted first-page commit before requesting later pages", async () => {
    const comparisonCalls = { count: 0 };
    await expect(inspectManagedFiles(githubFixture({ incompleteHistory: true, signatureValid: false, comparisonCalls }), input))
      .rejects.toThrow("managed files branch contains a commit not made by the server");
    expect(comparisonCalls.count).toBe(1);
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

  test("rejects a blob that is not base64 encoded", async () => {
    await expect(inspectManagedFiles(githubFixture({ blobEncoding: "utf-8" }), input))
      .rejects.toThrow('managed file "managed.yml" has an unsupported Git blob encoding');
  });

  test.each([
    ["a submodule", { path: "sub", type: "commit", mode: "160000", sha: blobSha }],
    ["a file", { path: "sub", type: "blob", mode: "100644", sha: blobSha }],
    ["a tree with a symlink mode", { path: "sub", type: "tree", mode: "120000", sha: blobSha }],
    ["a tree without a sha", { path: "sub", type: "tree", mode: "040000" }],
  ])("rejects a managed path that traverses %s", async (_name, treeEntry) => {
    await expect(inspectManagedFiles(githubFixture({ treeEntry }), { ...input, files: { "sub/managed.yml": "wanted\n" } }))
      .rejects.toThrow('managed path "sub/managed.yml" traverses a non-directory Git entry at "sub"');
  });

  test.each([
    ["missing", "missing" as const],
    ["at the 300 file limit", 300],
    ["above the 300 file limit", 301],
  ])("rejects a branch commit whose change list is %s", async (_name, changedFiles) => {
    await expect(inspectManagedFiles(githubFixture({ changedFiles }), input))
      .rejects.toThrow("managed files branch change list is incomplete");
  });

  test.each([false, true])("creates the managed branch and PR without resetting, generated funding=%s", async (funding) => {
    const files = funding ? repoSettingsManagedFiles({ additional_managed_files: {}, sponsorships: { enabled: false, github: ["user"] } }) : input.files;
    const read = githubFixture({ targetMissing: true, funding });
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
      const result = await applyManagedFiles(read, { ...input, files, writeToken: "unused", writeClient });
      expect(result).toEqual({ status: "applied", commit: targetSha, pullRequest: 73 });
      expect(createdRef).toBe(true);
      expect(createdPr).toBe(true);
      expect(reset).not.toHaveBeenCalled();
    } finally {
      reset.mockRestore();
    }
  });

  test("generated funding reuses an exact existing PR and needs no PR when default matches", async () => {
    const files = repoSettingsManagedFiles({ additional_managed_files: {}, sponsorships: { enabled: true, github: ["user"] } });
    const content = files[".github/FUNDING.yml"] ?? "";
    const existing = await inspectManagedFiles(githubFixture({ funding: true, targetContent: content }), { ...input, files });
    expect(existing.changedPaths).toEqual([".github/FUNDING.yml"]);
    expect(existing.branchNeedsWrite).toBe(false);
    expect(existing.pullRequest).toBe(73);
    const result = await applyManagedFiles(githubFixture({ funding: true, targetContent: content }), { ...input, files, writeToken: "unused" });
    expect(result).toEqual({ status: "already-applied", commit: targetSha, pullRequest: 73 });
    const matched = await inspectManagedFiles(githubFixture({ funding: true, sourceContent: content }), { ...input, files });
    expect(matched.status).toBe("already-applied");
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

  test("rejects the conditional reset when the lease reports that a ref moved", async () => {
    const read = githubFixture({ targetContent: "stale\n" });
    const writeClient = { rest: {}, paginate: async () => [] } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => { throw new gitRef.GitRefChanged(); });
    try {
      await expect(applyManagedFiles(read, { ...input, writeToken: "unused", writeClient }))
        .rejects.toThrow("managed files branch or default branch moved before the conditional reset");
    } finally {
      reset.mockRestore();
    }
  });

  test("lease-resets an ancestor branch whose managed content already matches", async () => {
    const read = githubFixture({ history: [], targetContent: "wanted\n" });
    const writeClient = {
      rest: {
        git: { getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : targetSha } } }) },
        pulls: { list: async () => ({ data: [] }), create: async () => ({ data: { number: 73 } }) },
      },
      paginate: async () => [],
      graphql: async () => ({ createCommitOnBranch: { commit: { oid: targetSha } } }),
    } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => undefined);
    try {
      const result = await applyManagedFiles(read, { ...input, writeToken: "unused", writeClient });
      expect(result).toEqual({ status: "applied", commit: targetSha, pullRequest: 73 });
      expect(reset).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: defaultSha, expectedTargetSha: targetSha }));
    } finally {
      reset.mockRestore();
    }
  });

  test("rethrows other reset failures unchanged", async () => {
    const read = githubFixture({ targetContent: "stale\n" });
    const writeClient = { rest: {}, paginate: async () => [] } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => { throw new Error("git push failed"); });
    try {
      await expect(applyManagedFiles(read, { ...input, writeToken: "unused", writeClient })).rejects.toThrow("git push failed");
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

  test.each([
    ["resetting an existing branch", { targetContent: "stale\n" }, true],
    ["creating the branch", { targetMissing: true }, false],
  ] as const)("requests workflows write only when %s", async (_name, options, expected) => {
    const result = await inspectManagedFiles(githubFixture(options), input);
    expect(result.branchNeedsWrite).toBe(true);
    expect(result.requiresWorkflowsWrite).toBe(expected);
  });

  test("rejects an open managed branch PR with a different base before apply", async () => {
    const gh = githubFixture({ pulls: [{
      number: 73,
      title: "chore(repo-settings): sync managed files",
      body: "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->",
      base: { ref: "release" },
      head: { sha: targetSha },
    }] });
    await expect(inspectManagedFiles(gh, input)).rejects.toThrow("managed files branch has an open pull request for a different base branch");
  });

  test("rejects multiple open PRs for the managed branch", async () => {
    const pulls = Array.from({ length: 2 }, (_, index) => ({
      number: 73 + index,
      title: "chore(repo-settings): sync managed files",
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
      title: "chore(repo-settings): sync managed files",
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

  test("rejects PR update if the default ref moved after inspection", async () => {
    const read = githubFixture({ targetContent: "wanted\n", pulls: [] });
    const writeClient = {
      rest: {
        git: { getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? targetSha : defaultSha } } }) },
        pulls: { list: async () => ({ data: [] }) },
      },
      paginate: async () => [],
    } as unknown as GitHub;
    await expect(applyManagedFiles(read, { ...input, writeToken: "unused", writeClient }))
      .rejects.toThrow("managed files default branch moved before pull request update");
  });

  test("does not inspect or reopen the managed branch when default already matches", async () => {
    const result = await inspectManagedFiles(githubFixture({ sourceContent: "wanted\n", pulls: [] }), input);
    expect(result.status).toBe("already-applied");
    expect(result.targetSha).toBeNull();
    expect(result.requiresPullRequestUpdate).toBe(false);
  });

  const pullBody = "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->";
  const outdatedPulls: [string, { title: string; body: string | null }][] = [
    ["title", { title: "Old title", body: pullBody }],
    ["legacy title", { title: "Sync managed files", body: pullBody }],
    ["body", { title: "chore(repo-settings): sync managed files", body: "Old body" }],
    ["missing body", { title: "chore(repo-settings): sync managed files", body: null }],
  ];

  test.each(outdatedPulls)("requests a pull request update when the existing pull request has an outdated %s", async (_name, drift) => {
    const pulls = [{ number: 73, ...drift, base: { ref: "main" }, head: { sha: targetSha } }];
    const result = await inspectManagedFiles(githubFixture({ pulls }), input);
    expect(result.status).toBe("ready");
    expect(result.branchNeedsWrite).toBe(false);
    expect(result.requiresPullRequestUpdate).toBe(true);
    expect(result.pullRequest).toBe(73);
  });

  test.each(outdatedPulls)("apply rewrites the title and body of a pull request with an outdated %s", async (_name, drift) => {
    const pulls = [{ number: 73, ...drift, base: { ref: "main" }, head: { sha: targetSha } }];
    const updates: unknown[] = [];
    const writeClient = {
      rest: {
        git: { getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : targetSha } } }) },
        pulls: { list: async () => ({ data: pulls }), update: async (args: unknown) => { updates.push(args); return { data: { number: 73 } }; } },
      },
      paginate: async () => pulls,
    } as unknown as GitHub;
    const result = await applyManagedFiles(githubFixture({ pulls }), { ...input, writeToken: "unused", writeClient });
    expect(result).toEqual({ status: "applied", commit: targetSha, pullRequest: 73 });
    expect(updates).toEqual([{ owner: "owner", repo: "repo", pull_number: 73, title: "chore(repo-settings): sync managed files", body: pullBody }]);
  });

  const commitCases: [string, { targetMissing: true } | { targetContent: string }][] = [
    ["create path", { targetMissing: true }],
    ["reset path", { targetContent: "stale\n" }],
  ];
  test.each(commitCases)("the managed branch commit is pinned to the observed default SHA on the %s", async (_name, options) => {
    const read = githubFixture(options);
    const mutations: { query: string; variables: { input: Record<string, unknown> } }[] = [];
    const created: unknown[] = [];
    let branchSha = defaultSha;
    const writeClient = {
      rest: {
        git: {
          getRef: async ({ ref }: { ref: string }) => ({ data: { object: { sha: ref === "heads/main" ? defaultSha : branchSha } } }),
          createRef: async () => ({ data: {} }),
        },
        pulls: { list: async () => ({ data: [] }), create: async (args: unknown) => { created.push(args); return { data: { number: 75 } }; } },
      },
      paginate: async () => [],
      graphql: async (query: string, variables: { input: Record<string, unknown> }) => {
        mutations.push({ query, variables });
        branchSha = targetSha;
        return { createCommitOnBranch: { commit: { oid: targetSha } } };
      },
    } as unknown as GitHub;
    const reset = spyOn(gitRef, "resetBranchWithLease").mockImplementation(async () => undefined);
    try {
      await applyManagedFiles(read, { ...input, writeToken: "unused", writeClient });
    } finally {
      reset.mockRestore();
    }
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.variables.input).toMatchObject({
      branch: { repositoryNameWithOwner: "owner/repo", branchName: "csm-ci/repo-settings" },
      expectedHeadOid: defaultSha,
      message: { headline: "chore(repo-settings): sync managed files" },
    });
    expect(mutations[0]?.variables.input.expectedHeadOid).not.toBe(targetSha);
    expect(created).toEqual([{ owner: "owner", repo: "repo", title: "chore(repo-settings): sync managed files", body: pullBody, head: "csm-ci/repo-settings", base: "main" }]);
  });
});
