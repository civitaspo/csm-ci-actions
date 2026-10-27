import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import * as gitRef from "./git-ref.ts";
import { CONFIG_YAML, config } from "./testing.ts";
import { parseConfig } from "./config.ts";
import type { GitHub } from "./github.ts";
import { applySecurefix, inspectSecurefix } from "./securefix-operation.ts";

const repository = "owner/client";
const runSha = "a".repeat(40);
const appliedSha = "b".repeat(40);
const parentTreeSha = "c".repeat(40);
const appliedTreeSha = "d".repeat(40);
const fileContent = Buffer.from("generated\n");

type TreeEntry = { path: string; type: string; mode: string; sha: string };
type InspectionOptions = {
  manifest?: Record<string, unknown>;
  run?: Record<string, unknown>;
  pull?: Record<string, unknown>;
  repo?: Record<string, unknown>;
  artifacts?: Array<{ id: number; name: string; expired: boolean; size_in_bytes: number }>;
  tree?: { truncated: boolean; tree: TreeEntry[] };
  content?: unknown;
  blobEncoding?: string;
  config?: ReturnType<typeof config>;
  branchHead?: string;
  commit?: Record<string, unknown>;
  recursiveTree?: { truncated: boolean; tree: TreeEntry[] };
  currentContent?: Buffer;
  signatureValid?: boolean;
  signedByGitHub?: boolean;
  apply?: boolean;
  graphqlError?: Error;
  branchHeadAfterFailure?: string;
};

async function inspectCurrentCommit(extraFile: boolean, baseEntries: TreeEntry[] = [], path = "generated.txt", nestedEntries: Record<string, TreeEntry[]> = {}, appliedMode = "100644", options: InspectionOptions = {}) {
  const artifactPath = await mkdtemp(join(tmpdir(), "securefix-operation-test-"));
  await mkdir(join(artifactPath, "files"));
  const manifest = {
    version: 1,
    repository,
    run_id: 42,
    head_sha: runSha,
    message: "Generate file",
    files: [{ kind: "write", path, size: fileContent.length, sha256: createHash("sha256").update(fileContent).digest("hex") }],
    ...options.manifest,
  };
  await writeFile(join(artifactPath, "manifest.json"), JSON.stringify(manifest));
  if ((options.manifest?.files as unknown[] | undefined)?.length !== 0) await writeFile(join(artifactPath, "files", "0000"), fileContent);

  const run = {
    id: 42,
    run_attempt: 1,
    event: "pull_request",
    head_branch: "feature",
    head_sha: runSha,
    path: ".github/workflows/build.yml",
    repository: { id: 1, full_name: repository },
    head_repository: { id: 1, full_name: repository },
    pull_requests: [{ number: 7, head: { ref: "feature", sha: runSha }, base: { ref: "main", sha: runSha } }],
    ...options.run,
  };
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    title: "Generated change",
    body: null,
    base: { ref: "main", sha: runSha },
    head: { ref: "feature", sha: appliedSha, repo: { id: 1, full_name: repository } },
    ...options.pull,
  };
  const serverCommit = {
    parents: [{ sha: runSha }],
    author: { id: 3000 },
    committer: { login: "web-flow" },
    commit: { verification: { verified: true }, tree: { sha: appliedTreeSha } },
  };
  const parentCommit = { parents: [], commit: { tree: { sha: parentTreeSha } } };
  const applyEntries = [
    { path, type: "blob", mode: appliedMode, sha: "e".repeat(40) },
    ...(extraFile ? [{ path: "unexpected.txt", type: "blob", mode: "100644", sha: "f".repeat(40) }] : []),
  ];
  const artifacts = options.artifacts ?? [{ id: 99, name: "securefix", expired: false, size_in_bytes: 512 }];
  let branchReads = 0;
  const listArtifacts = async () => ({ data: artifacts });
  const listPulls = async () => ({ data: [pull] });
  const gh = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts: listArtifacts },
      repos: {
        get: async () => ({ data: { id: 1, default_branch: "main", ...options.repo } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: ref === runSha ? parentCommit : { ...serverCommit, ...options.commit } }),
        getContent: async () => ({ data: options.content ?? { type: "file", sha: "1".repeat(40) } }),
      },
      pulls: { get: async () => ({ data: pull }), list: listPulls },
      git: {
        getRef: async () => {
          branchReads += 1;
          const sha = branchReads > 1 ? options.branchHeadAfterFailure ?? options.branchHead ?? appliedSha : options.branchHead ?? appliedSha;
          return { data: { object: { sha } } };
        },
        getTree: async ({ tree_sha, recursive }: { tree_sha: string; recursive?: string }) => ({ data: recursive && options.recursiveTree ? options.recursiveTree : options.tree ?? { truncated: false, tree: tree_sha === parentTreeSha ? (recursive ? baseEntries : (nestedEntries[tree_sha] ?? baseEntries)) : (nestedEntries[tree_sha] ?? applyEntries) } }),
        getBlob: async () => ({ data: { encoding: options.blobEncoding ?? "base64", content: (options.currentContent ?? fileContent).toString("base64") } }),
      },
    },
    paginate: async (method: unknown) => method === listArtifacts ? artifacts : method === listPulls ? [pull] : [],
    graphql: async (query: string) => {
      if (query.startsWith("mutation") && options.graphqlError) throw options.graphqlError;
      return { repository: { commit: { signature: { isValid: options.signatureValid ?? true, wasSignedByGitHub: options.signedByGitHub ?? true } } } };
    },
  } as unknown as GitHub;
  try {
    return options.apply
      ? await applySecurefix(gh, options.config ?? config(), repository, 42, artifactPath, "test-token")
      : await inspectSecurefix(gh, options.config ?? config(), repository, 42, artifactPath);
  } finally {
    await rm(artifactPath, { recursive: true, force: true });
  }
}

type RouteOptions = {
  contentError?: Error;
  contentObject?: { type: string; sha: string };
  blobEncoding?: string;
  targetSha?: string;
  comparison?: { ahead_by: number; commits: Array<{ sha: string }> };
  historyCommit?: { parents: Array<{ sha: string }>; files?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> };
  historyFilesUndefined?: boolean;
  trustedHistoryCommit?: boolean;
  routePulls?: Array<{ number: number }>;
  apply?: boolean;
  historyFile?: { filename: string; content: Buffer };
  configMissing?: boolean;
  routeTargetBranch?: string;
  routeName?: string;
  message?: string;
  alreadyApplied?: boolean;
  pullWrites?: Array<{ title: string; body: string; pull_number?: number }>;
};

async function inspectNewRouteFile(path: string, options: RouteOptions = {}) {
  const artifactPath = await mkdtemp(join(tmpdir(), "securefix-route-add-test-"));
  await mkdir(join(artifactPath, "files"));
  const content = Buffer.from("new content\n");
  const manifest = {
    version: 1,
    repository,
    run_id: 42,
    head_sha: runSha,
    message: options.message ?? "Generate file",
    files: [{ kind: "write", path, size: content.length, sha256: createHash("sha256").update(content).digest("hex") }],
  };
  await writeFile(join(artifactPath, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(artifactPath, "files", "0000"), content);
  const run = {
    id: 42,
    run_attempt: 1,
    event: "push",
    head_branch: "main",
    head_sha: runSha,
    path: ".github/workflows/release.yml@refs/heads/main",
    repository: { id: 1, full_name: repository },
    head_repository: { id: 1, full_name: repository },
    pull_requests: [],
  };
  const artifact = { id: 99, name: "securefix", expired: false, size_in_bytes: 512 };
  const listArtifacts = async () => ({ data: [artifact] });
  const listPulls = async () => ({ data: options.routePulls ?? [] });
  const missing = Object.assign(new Error("Not Found"), { status: 404 });
  const gh = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts: listArtifacts },
      repos: {
        get: async () => ({ data: { id: 1, default_branch: "main" } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: ref === runSha
          ? { commit: { tree: { sha: parentTreeSha } } }
          : {
                parents: options.historyCommit?.parents ?? [{ sha: runSha }],
                files: options.historyFilesUndefined ? undefined : options.historyCommit?.files ?? [],
                author: { id: options.trustedHistoryCommit === false ? 999 : 3000 },
                committer: { login: "web-flow" },
                commit: { verification: { verified: true }, tree: { sha: options.alreadyApplied ? appliedTreeSha : parentTreeSha } },
              } }),
        getContent: async ({ path: contentPath, ref }: { path: string; ref: string }) => {
          if (options.contentError) throw options.contentError;
          if (options.historyFile?.filename === contentPath) {
            if (ref === runSha) throw missing;
            return { data: { type: "file", sha: "1".repeat(40) } };
          }
          if (options.alreadyApplied && ref !== runSha) return { data: { type: "file", sha: "1".repeat(40) } };
          if (options.contentObject) return { data: options.contentObject };
          throw missing;
        },
        compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: runSha }, ...(options.comparison ?? { ahead_by: 0, commits: [] }) } }),
      },
      git: {
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false, tree: options.alreadyApplied && tree_sha === appliedTreeSha ? [{ path, type: "blob", mode: "100644", sha: "e".repeat(40) }] : [] } }),
        getBlob: async () => ({ data: { encoding: options.blobEncoding ?? "base64", content: (options.historyFile?.content ?? content).toString("base64") } }),
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: runSha } } };
          if (ref === "heads/release/next" && options.targetSha) return { data: { object: { sha: options.targetSha } } };
          throw missing;
        },
      },
      pulls: {
        list: listPulls,
        update: async (input: { pull_number: number; title: string; body: string }) => {
          options.pullWrites?.push(input);
          return { data: { number: input.pull_number } };
        },
        create: async (input: { title: string; body: string }) => {
          options.pullWrites?.push(input);
          return { data: { number: 88 } };
        },
      },
    },
    paginate: async (method: unknown) => method === listArtifacts ? [artifact] : method === listPulls ? options.routePulls ?? [] : [],
    graphql: async (query: string) => query.startsWith("mutation")
      ? { createCommitOnBranch: { commit: { oid: appliedSha } } }
      : { repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } },
  } as unknown as GitHub;
  const yaml = CONFIG_YAML
    .replace("repositories:", options.configMissing ? "repositories:" : `securefix:\n  allow_workflow_changes: false\n  routes:\n    - name: ${options.routeName ?? "release-pr"}\n      from: default\n      to: ${options.routeTargetBranch ?? "release/next"}\n      workflow: .github/workflows/release.yml\n      paths: { new-file.txt: any, package.json: version-only }\nrepositories:`)
    .replace("ops: [approve, policy-check]", "ops: [approve, policy-check, securefix]");
  try {
    const parsed = parseConfig(yaml);
    return options.apply
      ? await applySecurefix(gh, parsed, repository, 42, artifactPath, "test-token")
      : await inspectSecurefix(gh, parsed, repository, 42, artifactPath);
  } finally {
    await rm(artifactPath, { recursive: true, force: true });
  }
}

describe("securefix retry inspection", () => {
  const rejectionCases: Array<{ name: string; expected: string; options?: InspectionOptions; path?: string; baseEntries?: TreeEntry[]; manifest?: Record<string, unknown> }> = [
    { name: "duplicate or missing named artifact", expected: "workflow run must have exactly one securefix artifact", options: { artifacts: [] } },
    { name: "expired artifact", expected: "securefix artifact is expired or missing", options: { artifacts: [{ id: 99, name: "securefix", expired: true, size_in_bytes: 512 }] } },
    { name: "oversized archive", expected: "securefix artifact exceeds the 11MB archive limit", options: { artifacts: [{ id: 99, name: "securefix", expired: false, size_in_bytes: 12 * 1024 * 1024 }] } },
    { name: "run repository mismatch", expected: "workflow run repository does not match the requested repository", options: { run: { repository: { id: 2, full_name: repository } } } },
    { name: "head repository mismatch", expected: "securefix workflow run head repository does not match the requested repository", options: { run: { head_repository: { id: 2, full_name: repository } } } },
    { name: "PR run without pull request binding", expected: "securefix PR run must map to exactly one pull request", options: { run: { pull_requests: [] } } },
    { name: "fork pull request", expected: "securefix does not accept fork pull requests", options: { pull: { head: { ref: "feature", sha: appliedSha, repo: { id: 2, full_name: repository } } } } },
    { name: "empty artifact", expected: "securefix artifact contains no changes", manifest: { files: [] } },
    { name: "moved PR branch", expected: "the branch moved after the request", options: { branchHead: runSha, pull: { head: { ref: "feature", sha: "f".repeat(40), repo: { id: 1, full_name: repository } } } } },
    { name: "workflow write disabled", expected: "workflow changes are disabled by securefix configuration", path: ".github/workflows/new.yml" },
    { name: "truncated base tree", expected: "securefix could not safely inspect the base Git tree", options: { tree: { truncated: true, tree: [] } } },
    { name: "path crosses a symlink", expected: 'securefix path "link/file.txt" traverses a non-directory Git entry at "link"', path: "link/file.txt", baseEntries: [{ path: "link", type: "blob", mode: "120000", sha: "1".repeat(40) }] },
    { name: "changed path is a symlink", expected: 'securefix path "generated.txt" is not a regular file in the base Git tree', baseEntries: [{ path: "generated.txt", type: "blob", mode: "120000", sha: "1".repeat(40) }] },
  ];

  test.each(rejectionCases)("rejects $name with the documented reason", async ({ expected, options, path, baseEntries, manifest }) => {
    await expect(inspectCurrentCommit(false, baseEntries, path, {}, "100644", {
      branchHead: runSha,
      pull: { head: { ref: "feature", sha: runSha, repo: { id: 1, full_name: repository } } },
      ...options,
      ...(manifest ? { manifest } : {}),
    })).rejects.toThrow(expected);
  });

  const idempotenceMisses: Array<{ name: string; options: InspectionOptions; extraFile?: boolean; appliedMode?: string }> = [
    { name: "branch still points at the requested commit", options: { branchHead: runSha } },
    { name: "server commit has a different parent", options: { commit: { parents: [{ sha: "f".repeat(40) }] } } },
    { name: "server commit has multiple parents", options: { commit: { parents: [{ sha: runSha }, { sha: appliedSha }] } } },
    { name: "commit has a different committer", options: { commit: { committer: { login: "alice" } } } },
    { name: "commit has a different author", options: { commit: { author: { id: 999 } } } },
    { name: "commit is not verified", options: { commit: { commit: { verification: { verified: false }, tree: { sha: appliedTreeSha } } } } },
    { name: "signature is invalid", options: { signatureValid: false } },
    { name: "signature was not made by GitHub", options: { signedByGitHub: false } },
    { name: "changed-file trees are truncated", options: { recursiveTree: { truncated: true, tree: [] } } },
    { name: "branch commit changed an extra file", options: {}, extraFile: true },
    { name: "applied file is a symlink", options: {}, appliedMode: "120000" },
    { name: "applied file content differs", options: { currentContent: Buffer.from("different\n") } },
  ];

  test.each(idempotenceMisses)("does not report already applied when $name", async ({ options, extraFile, appliedMode }) => {
    const result = await inspectCurrentCommit(extraFile ?? false, [], "generated.txt", {}, appliedMode ?? "100644", {
      branchHead: appliedSha,
      pull: { head: { ref: "feature", sha: runSha, repo: { id: 1, full_name: repository } } },
      ...options,
    });
    expect(result.status).toBe("ready");
  });

  test("maps a compare-and-swap commit failure to a moved-branch rejection", async () => {
    const error = new Error("Expected head SHA does not match");
    await expect(inspectCurrentCommit(false, [], "generated.txt", {}, "100644", {
      apply: true,
      branchHead: runSha,
      pull: { head: { ref: "feature", sha: runSha, repo: { id: 1, full_name: repository } } },
      graphqlError: error,
    })).rejects.toThrow("the branch moved after the request");
  });

  test("propagates non-CAS commit API errors when the branch is unchanged", async () => {
    const error = new Error("GitHub is unavailable");
    await expect(inspectCurrentCommit(false, [], "generated.txt", {}, "100644", {
      apply: true,
      branchHead: runSha,
      pull: { head: { ref: "feature", sha: runSha, repo: { id: 1, full_name: repository } } },
      graphqlError: error,
    })).rejects.toBe(error);
  });

  test("treats a changed branch head after a failed commit as a moved-branch rejection", async () => {
    const error = new Error("GitHub is unavailable");
    await expect(inspectCurrentCommit(false, [], "generated.txt", {}, "100644", {
      apply: true,
      branchHead: runSha,
      branchHeadAfterFailure: "f".repeat(40),
      commit: { parents: [{ sha: "e".repeat(40) }] },
      pull: { head: { ref: "feature", sha: runSha, repo: { id: 1, full_name: repository } } },
      graphqlError: error,
    })).rejects.toThrow("the branch moved after the request");
  });

  test("accepts the exact server-made commit on a pull request branch as already applied", async () => {
    const result = await inspectCurrentCommit(false);
    expect(result.status).toBe("already-applied");
  });

  test("accepts the exact server-made retry when GitHub updates the run's pull request head", async () => {
    const result = await inspectCurrentCommit(false, [], "generated.txt", {}, "100644", {
      run: { pull_requests: [{ number: 7, head: { ref: "feature", sha: appliedSha }, base: { ref: "main", sha: runSha } }] },
    });
    expect(result.status).toBe("already-applied");
  });

  test("rejects a GitHub-updated PR head when it is not the exact server-made commit", async () => {
    await expect(inspectCurrentCommit(false, [], "generated.txt", {}, "100644", {
      run: { pull_requests: [{ number: 7, head: { ref: "feature", sha: appliedSha }, base: { ref: "main", sha: runSha } }] },
      commit: { parents: [{ sha: "f".repeat(40) }] },
    })).rejects.toThrow("the branch moved after the request");
  });

  test("does not call a server commit with extra changed files already applied", async () => {
    await expect(inspectCurrentCommit(true)).rejects.toThrow("the branch moved after the request");
  });

  test("does not treat a server-made symlink as an applied file", async () => {
    await expect(inspectCurrentCommit(false, [], "generated.txt", {}, "120000")).rejects.toThrow("the branch moved after the request");
  });

  const unsafeBasePathCases: [string, string, Array<{ path: string; type: string; mode: string; sha: string }>, Record<string, Array<{ path: string; type: string; mode: string; sha: string }>>][] = [
    ["existing symlink", "link", [{ path: "link", type: "blob", mode: "120000", sha: "1".repeat(40) }], {}],
    ["existing gitlink", "vendor", [{ path: "vendor", type: "commit", mode: "160000", sha: "2".repeat(40) }], {}],
    ["path beneath a symlink", "link/file.txt", [{ path: "link", type: "blob", mode: "120000", sha: "1".repeat(40) }], {}],
    ["path beneath a gitlink", "vendor/file.txt", [{ path: "vendor", type: "commit", mode: "160000", sha: "2".repeat(40) }], {}],
  ];
  test.each(unsafeBasePathCases)("rejects changed path: %s", async (_, path, entries, nested) => {
    await expect(inspectCurrentCommit(false, entries, path, nested)).rejects.toThrow(/regular file|non-directory Git entry/);
  });

  test("allows a new route file when its path allows any contents", async () => {
    expect((await inspectNewRouteFile("new-file.txt")).status).toBe("ready");
  });

  test.each([
    { name: "creation", routePulls: [], alreadyApplied: false },
    { name: "metadata refresh", routePulls: [{ number: 70 }], alreadyApplied: false },
    { name: "exact replay", routePulls: [{ number: 70 }], alreadyApplied: true },
  ])("preserves release subjects and other route prefixes on $name", async ({ routePulls, alreadyApplied }) => {
    for (const routeName of ["release-pr", "generated-files"]) {
      const pullWrites: NonNullable<RouteOptions["pullWrites"]> = [];
      const result = await inspectNewRouteFile("new-file.txt", {
        apply: true,
        targetSha: alreadyApplied ? appliedSha : runSha,
        alreadyApplied,
        routePulls: [...routePulls],
        routeName,
        message: "chore(release): v1.2.3\n\nRelease details.",
        pullWrites,
      });
      expect(result.status).toBe(alreadyApplied ? "already-applied" : "applied");
      expect(pullWrites).toHaveLength(1);
      expect(pullWrites[0]?.title).toBe(routeName === "release-pr" ? "chore(release): v1.2.3" : "generated-files: chore(release): v1.2.3");
      expect(pullWrites[0]?.pull_number).toBe(routePulls[0]?.number);
      expect(pullWrites[0]?.body).toContain("<!-- csm-ci:securefix:42 -->");
    }
  });

  test("rejects a new file whose route requires an original version line", async () => {
    await expect(inspectNewRouteFile("package.json")).rejects.toThrow('securefix route cannot find the original file "package.json"');
  });

  test("propagates repository content API errors other than 404", async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    await expect(inspectNewRouteFile("new-file.txt", { contentError: error })).rejects.toBe(error);
  });

  test("rejects a route path whose repository content is not a file", async () => {
    await expect(inspectNewRouteFile("new-file.txt", { contentObject: { type: "dir", sha: "1".repeat(40) } })).rejects.toThrow('securefix path "new-file.txt" is not a file');
  });

  test("rejects a route file with unsupported blob encoding", async () => {
    await expect(inspectNewRouteFile("new-file.txt", { contentObject: { type: "file", sha: "1".repeat(40) }, blobEncoding: "utf-8" })).rejects.toThrow('securefix file "new-file.txt" has an unsupported Git blob encoding');
  });

  const routeHistoryRejections: Array<{ name: string; expected: string; options: RouteOptions }> = [
    {
      name: "incomplete commit list",
      expected: "securefix route target branch commit list is incomplete",
      options: { targetSha: appliedSha, comparison: { ahead_by: 2, commits: [{ sha: "1".repeat(40) }] } },
    },
    {
      name: "commit not made by server",
      expected: "securefix route target branch contains a commit not made by the server",
      options: { targetSha: appliedSha, comparison: { ahead_by: 1, commits: [{ sha: appliedSha }] }, trustedHistoryCommit: false },
    },
    {
      name: "incomplete changed-file list",
      expected: "securefix route target branch change list is incomplete",
      options: { targetSha: appliedSha, comparison: { ahead_by: 1, commits: [{ sha: appliedSha }] }, historyCommit: { parents: [{ sha: runSha }] }, historyFilesUndefined: true },
    },
    {
      name: "change-file list at API limit",
      expected: "securefix route target branch change list is incomplete",
      options: { targetSha: appliedSha, comparison: { ahead_by: 1, commits: [{ sha: appliedSha }] }, historyCommit: { parents: [{ sha: runSha }], files: Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}.txt`, status: "modified", additions: 0, deletions: 0, changes: 0 })) } },
    },
    {
      name: "merge commit in history",
      expected: "securefix route target branch contains a merge or root commit",
      options: { targetSha: appliedSha, comparison: { ahead_by: 1, commits: [{ sha: appliedSha }] }, historyCommit: { parents: [{ sha: runSha }, { sha: appliedSha }], files: [] } },
    },
    {
      name: "commit changes a path outside the route allowlist",
      expected: 'securefix route does not allow path "secret.txt"',
      options: {
        targetSha: appliedSha,
        comparison: { ahead_by: 1, commits: [{ sha: appliedSha }] },
        historyCommit: { parents: [{ sha: runSha }], files: [{ filename: "secret.txt", status: "added", additions: 1, deletions: 0, changes: 1 }] },
        historyFile: { filename: "secret.txt", content: Buffer.from("secret\n") },
      },
    },
  ];

  test.each(routeHistoryRejections)("rejects route history with $name", async ({ expected, options }) => {
    await expect(inspectNewRouteFile("new-file.txt", options)).rejects.toThrow(expected);
  });

  test("rejects a route branch with multiple open pull requests", async () => {
    await expect(inspectNewRouteFile("new-file.txt", {
      apply: true,
      targetSha: runSha,
      routePulls: [{ number: 70 }, { number: 71 }],
    })).rejects.toThrow("securefix route branch has multiple open pull requests");
  });

  test("rejects a route workflow when securefix configuration is missing", async () => {
    await expect(inspectNewRouteFile("new-file.txt", { configMissing: true })).rejects.toThrow("securefix configuration is missing");
  });

  test("rejects a route whose target is its source/default branch", async () => {
    await expect(inspectNewRouteFile("new-file.txt", { routeTargetBranch: "main" })).rejects.toThrow("securefix route cannot write to its source or default branch");
  });

  test.each([
    [new gitRef.GitRefChanged(), "securefix route branch or source moved before the conditional reset"],
    [new Error("Git transport unavailable"), "Git transport unavailable"],
  ])("preserves the reason for a failed conditional route reset: %s", async (error, message) => {
    const reset = spyOn(gitRef, "resetBranchWithLease").mockRejectedValue(error);
    try {
      await expect(inspectNewRouteFile("new-file.txt", { apply: true })).rejects.toThrow(message);
    } finally {
      reset.mockRestore();
    }
  });
});
