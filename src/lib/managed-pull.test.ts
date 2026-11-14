import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attestManagedPull, compareManagedManifestTrees, managedDriftDispatchState, managedManifestDigest, verifyManagedMergeTree } from "./managed-pull.ts";
import { parseConfig } from "./config.ts";
import { generateWorkflows } from "./generated-workflows.ts";
import { CONFIG_YAML } from "./testing.ts";
import type { GitHub } from "./github.ts";
import type { ManagedFilesInspection } from "./managed-files.ts";
import type { ManagedReservationPayload } from "./automerge.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const blob = "d".repeat(40);
const body = "wanted\n";
const CONFIG = `${CONFIG_YAML}\nrepo_settings: { auto_merge_managed_files: true }\n`;
const GENERATED = generateWorkflows(parseConfig(CONFIG), "owner/repo", "main", { version: "v1.2.3", sha: "1".repeat(40) });

function fixture(options: { extra?: boolean; movedAtEnd?: boolean; signature?: boolean; headContent?: string; nonLinear?: boolean; foreignHead?: boolean; executable?: boolean; repositoryId?: number; repositoryName?: string; pullNumber?: number; pullNodeId?: string; pullState?: string; merged?: boolean; draft?: boolean; baseRepoId?: number; headRepoId?: number; baseRepoName?: string; headRepoName?: string; baseRef?: string; headRef?: string; defaultBranch?: string; pullSha?: string; defaultSha?: string; pullCount?: number; listPullNumber?: number; mergeBaseSha?: string; historyPath?: string; emptyHistory?: boolean; renamed?: boolean } = {}): GitHub {
  let stateReads = 0;
  const repositoryId = options.repositoryId ?? 42;
  const repositoryName = options.repositoryName ?? "owner/repo";
  const pull = {
    number: options.pullNumber ?? 7, node_id: options.pullNodeId ?? "PR_node", state: options.pullState ?? "open", merged: options.merged ?? false, draft: options.draft ?? false,
    head: { sha: options.pullSha ?? head, ref: options.headRef ?? "csm-ci/repo-settings", repo: { id: options.headRepoId ?? (options.foreignHead ? 99 : repositoryId), full_name: options.headRepoName ?? (options.foreignHead ? "attacker/repo" : repositoryName) } },
    base: { ref: options.baseRef ?? "main", sha: base, repo: { id: options.baseRepoId ?? repositoryId, full_name: options.baseRepoName ?? repositoryName, default_branch: options.defaultBranch ?? "main" } },
  };
  const list = async () => ({ data: Array.from({ length: options.pullCount ?? 1 }, () => ({ ...pull, number: options.listPullNumber ?? pull.number })) });
  const listFiles = async () => ({ data: [{ filename: options.renamed ? "new-name.yml" : "managed.yml", status: options.renamed ? "renamed" : "modified", ...(options.renamed ? { previous_filename: "managed.yml" } : {}) }, ...(options.extra ? [{ filename: "surprise.txt", status: "added" }] : [])] });
  const gh = {
    rest: {
      pulls: { list, get: async () => ({ data: pull }), listFiles },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") {
            stateReads++;
            return { data: { object: { sha: options.movedAtEnd && stateReads > 1 ? "e".repeat(40) : options.defaultSha ?? base } } };
          }
          return { data: { object: { sha: options.pullSha ?? head } } };
        },
        getTree: async () => ({ data: { truncated: false, tree: [{ path: "managed.yml", type: "blob", mode: options.executable ? "100755" : "100644", sha: blob }] } }),
        getBlob: async () => ({ data: { encoding: "base64", content: Buffer.from(options.headContent ?? body).toString("base64") } }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { ahead_by: 1, merge_base_commit: { sha: options.mergeBaseSha ?? base }, commits: [{ sha: head }] } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: ref === head ? {
          parents: options.nonLinear ? [{ sha: "e".repeat(40) }, { sha: options.mergeBaseSha ?? base }] : [{ sha: options.mergeBaseSha ?? base }],
          files: options.emptyHistory ? [] : [{ filename: options.historyPath ?? "managed.yml", ...(options.renamed ? { previous_filename: "managed.yml" } : {}) }], author: { id: 900 }, committer: { login: "web-flow" },
          commit: { verification: { verified: true }, tree: { sha: tree } },
        } : { parents: [], commit: { tree: { sha: tree } } } }),
      },
    },
    paginate: async (method: unknown) => method === list ? (await list()).data : (await listFiles()).data,
    graphql: async () => ({ repository: { commit: { signature: { isValid: options.signature ?? true, wasSignedByGitHub: true } } } }),
  };
  return gh as unknown as GitHub;
}

const inspection: ManagedFilesInspection = {
  status: "ready", requiresWorkflowsWrite: false, requiresPullRequestUpdate: false, branchNeedsWrite: false,
  repository: "owner/repo", defaultBranch: "main", defaultSha: base, targetSha: head,
  files: [{ path: "managed.yml", content: body }], changedPaths: ["managed.yml"], pullRequest: 7,
};

function expected(overrides: Partial<Parameters<typeof attestManagedPull>[1]> = {}): Parameters<typeof attestManagedPull>[1] {
  return { repository: "owner/repo", repositoryId: 42, pullNumber: 7, pullNodeId: "PR_node", defaultBranch: "main", defaultSha: base, headSha: head, serverBotId: 900, configSha: "f".repeat(40), releaseSha: "1".repeat(40), releaseVersion: "v1.2.3", inspection, ...overrides };
}

describe("attestManagedPull", () => {
  test("attests exact server-authored content and returns a server-computed digest", async () => {
    const result = await attestManagedPull(fixture(), expected());
    expect(result).toMatchObject({ repositoryId: 42, pullNumber: 7, pullNodeId: "PR_node", baseSha: base, headSha: head, configSha: "f".repeat(40), releaseSha: "1".repeat(40) });
    expect(result.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test.each([
    ["extra path", { extra: true }, "managed pull diff does not exactly match the managed manifest"],
    ["modified bytes", { headContent: "attacker\n" }, 'managed pull content or mode differs from the managed manifest at "managed.yml"'],
    ["invalid GitHub signature", { signature: false }, "managed pull contains a commit not made by the server"],
    ["non-linear history", { nonLinear: true }, "managed pull contains a merge or root commit"],
    ["foreign head repository", { foreignHead: true }, "managed pull repository identity changed"],
    ["executable mode change", { executable: true }, 'managed pull content or mode differs from the managed manifest at "managed.yml"'],
    ["base moves during validation", { movedAtEnd: true }, "managed pull base or head moved"],
  ] as const)("rejects %s", async (_name, options, message) => {
    await expect(attestManagedPull(fixture(options), expected())).rejects.toThrow(message);
  });

  test.each([
    ["malformed repository", expected({ repository: "owner/repo/extra" }), "managed pull repository is invalid"],
    ["invalid repository ID", expected({ repositoryId: 0 }), "managed pull repository identity is invalid"],
    ["invalid pull number", expected({ pullNumber: 0 }), "managed pull identity is invalid"],
    ["missing pull node ID", expected({ pullNodeId: "" }), "managed pull identity is invalid"],
    ["invalid base SHA", expected({ defaultSha: "bad" }), "managed pull base SHA is invalid"],
    ["invalid head SHA", expected({ headSha: "bad" }), "managed pull head SHA is invalid"],
    ["invalid configuration SHA", expected({ configSha: "bad" }), "managed pull configuration SHA is invalid"],
    ["invalid release SHA", expected({ releaseSha: "bad" }), "managed pull release SHA is invalid"],
    ["inspection repository mismatch", expected({ inspection: { ...inspection, repository: "attacker/repo" } }), "managed pull does not match the inspected managed-files state"],
    ["inspection branch mismatch", expected({ inspection: { ...inspection, defaultBranch: "stable" } }), "managed pull does not match the inspected managed-files state"],
    ["inspection base mismatch", expected({ inspection: { ...inspection, defaultSha: "e".repeat(40) } }), "managed pull does not match the inspected managed-files state"],
    ["inspection head mismatch", expected({ inspection: { ...inspection, targetSha: "e".repeat(40) } }), "managed pull does not match the inspected managed-files state"],
    ["history starts at another base", expected(), "managed pull history does not start at the current default branch"],
    ["history changes an unmanifested path", expected(), 'managed pull history changed an unexpected path "unexpected.yml"'],
    ["renamed PR path", expected(), "managed pull diff does not exactly match the managed manifest"],
    ["duplicate manifest path", expected({ inspection: { ...inspection, files: [...inspection.files, ...inspection.files], changedPaths: ["managed.yml", "managed.yml"] } }), "managed pull inspection has an invalid change manifest"],
    ["foreign manifest path", expected({ inspection: { ...inspection, deletions: ["surprise.yml"] } }), "managed pull inspection has an invalid change manifest"],
    ["incomplete manifest", expected({ inspection: { ...inspection, changedPaths: ["managed.yml", "missing.yml"] } }), "managed pull inspection has an incomplete change manifest"],
    ["multiple open managed pulls", expected(), "managed pull branch does not have exactly one open pull request"],
    ["closed pull", expected(), "managed pull identity or state changed"],
    ["merged pull", expected(), "managed pull identity or state changed"],
    ["draft pull", expected(), "managed pull identity or state changed"],
    ["changed pull number", expected(), "managed pull identity or state changed"],
    ["foreign base repository ID", expected(), "managed pull repository identity changed"],
    ["foreign repository name", expected(), "managed pull repository identity changed"],
    ["wrong base ref", expected(), "managed pull base or head ref changed"],
    ["wrong default branch", expected(), "managed pull base or head ref changed"],
    ["wrong managed ref", expected(), "managed pull base or head ref changed"],
    ["pull head moved", expected(), "managed pull base or head moved"],
    ["default branch moved", expected(), "managed pull base or head moved"],
  ] as const)("rejects %s", async (_name, value, message) => {
    const options = _name === "history starts at another base" ? { mergeBaseSha: "e".repeat(40) }
      : _name === "history changes an unmanifested path" ? { historyPath: "unexpected.yml" }
      : _name === "foreign manifest path" ? { historyPath: "surprise.yml" }
      : _name === "renamed PR path" ? { renamed: true }
      : _name === "multiple open managed pulls" ? { pullCount: 2 }
      : _name === "closed pull" ? { pullState: "closed" }
      : _name === "merged pull" ? { merged: true }
      : _name === "draft pull" ? { draft: true }
      : _name === "changed pull number" ? { pullNumber: 8, listPullNumber: 7 }
      : _name === "foreign base repository ID" ? { baseRepoId: 99 }
      : _name === "foreign repository name" ? { headRepoName: "attacker/repo" }
      : _name === "wrong base ref" ? { baseRef: "stable" }
      : _name === "wrong default branch" ? { defaultBranch: "stable" }
      : _name === "wrong managed ref" ? { headRef: "other" }
      : _name === "pull head moved" ? { pullSha: "e".repeat(40) }
      : _name === "default branch moved" ? { defaultSha: "e".repeat(40) }
      : {};
    await expect(attestManagedPull(fixture(options), value)).rejects.toThrow(message);
  });

  test("rejects a changed identity between trusted inspection and attestation", async () => {
    await expect(attestManagedPull(fixture(), { ...expected(), pullNodeId: "other" })).rejects.toThrow("managed pull identity or state changed");
  });
});

describe("verifyManagedMergeTree", () => {
  const merge = "7".repeat(40);
  const stable = Object.entries(GENERATED)[1] ?? Object.entries(GENERATED)[0]!;
  const obsolete = ".github/workflows/obsolete.yml";
  function completeVerifierFixture(options: { driftPath?: string; releaseSha?: string; releaseVersion?: string; manifestDigest?: string; configText?: string; historyPath?: string; additionalSource?: string } = {}): { source: GitHub; target: GitHub; reservation: ManagedReservationPayload } {
    const generated = { ...GENERATED };
    const expectedFiles = Object.entries(generated).map(([path, content]) => ({ path, content }));
    const deletion = { path: obsolete, content: null } as const;
    const digest = managedManifestDigest([...expectedFiles, deletion]);
    const reservation: ManagedReservationPayload = {
      version: 2, kind: "managed-files", repository_id: 42, repository: "owner/repo", pull_number: 7, pull_node_id: "PR_node",
      base_ref: "main", managed_ref: "csm-ci/repo-settings", accepted_base: base, accepted_head: head,
      configuration_sha: "f".repeat(40), release_version: options.releaseVersion ?? "v1.2.3", release_sha: "1".repeat(40), manifest_digest: options.manifestDigest ?? digest,
      idempotency_key: "3".repeat(64), accepted_at: "2026-10-29T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z",
    };
    const source = {
      rest: {
        repos: {
          getContent: async () => ({ data: options.configText ?? CONFIG }),
          getReleaseByTag: async () => ({ data: { id: 1, tag_name: "v1.2.3", draft: false, prerelease: false, published_at: "2026-10-26T01:00:00Z" } }),
          getCommit: async () => ({ data: { commit: { tree: { sha: "source-tree" } } } }),
        },
        git: {
          getRef: async () => ({ data: { object: { type: "commit", sha: options.releaseSha ?? "1".repeat(40) } } }),
          getTree: async () => ({ data: { truncated: false, tree: options.additionalSource ? [{ path: options.additionalSource, type: "blob", mode: "100644", sha: "source-blob" }] : [] } }),
          getBlob: async () => ({ data: { encoding: "base64", content: Buffer.from("additional content\n").toString("base64") } }),
        },
      },
    } as unknown as GitHub;
    const values = new Map<string, string>();
    const filesByRef = new Map<string, Map<string, string>>();
    const baseFiles = new Map<string, string>([[stable[0], stable[1]], [obsolete, "# Generated by csm-ci from old.\nold\n"]]);
    const headFiles = new Map([...expectedFiles.map(({ path, content }) => [path, content] as const)]);
    const mergeFiles = new Map(headFiles);
    if (options.driftPath) mergeFiles.set(options.driftPath, "base raced after acceptance\n");
    filesByRef.set(base, baseFiles); filesByRef.set(head, headFiles); filesByRef.set(merge, mergeFiles);
    const indexes = new Map<string, { ref: string; path: string }>();
    const makeTree = (ref: string, prefix: string): { path: string; type: string; mode: string; sha: string }[] => {
      const entries = new Map<string, { path: string; type: string; mode: string; sha: string }>();
      for (const [filePath, content] of filesByRef.get(ref) ?? []) {
        if (!filePath.startsWith(prefix ? `${prefix}/` : "")) continue;
        const rest = prefix ? filePath.slice(prefix.length + 1) : filePath;
        const [segment, ...tail] = rest.split("/");
        if (!segment) continue;
        const childPath = prefix ? `${prefix}/${segment}` : segment;
        if (tail.length) {
          const treeSha = `${ref}:${childPath}`;
          indexes.set(treeSha, { ref, path: childPath });
          entries.set(segment, { path: segment, type: "tree", mode: "040000", sha: treeSha });
        } else {
          const sha = createHash("sha1").update(`${ref}:${filePath}:${content}`).digest("hex");
          values.set(sha, content);
          entries.set(segment, { path: segment, type: "blob", mode: "100644", sha });
        }
      }
      return [...entries.values()];
    };
    const target = {
      rest: {
        repos: {
          get: async () => ({ data: { id: 42, full_name: "owner/repo" } }),
          compareCommitsWithBasehead: async () => ({ data: { ahead_by: 1, merge_base_commit: { sha: base }, commits: [{ sha: head }] } }),
          getCommit: async ({ ref }: { ref: string }) => ref === head
            ? { data: { parents: [{ sha: base }], files: [...expectedFiles.filter(({ path }) => path !== stable[0]).map(({ path }) => ({ filename: path })), ...(options.historyPath ? [{ filename: options.historyPath }] : []), { filename: obsolete, status: "removed" }], author: { id: 900 }, committer: { login: "web-flow" }, commit: { verification: { verified: true }, tree: { sha: `${head}:` } } } }
            : { data: { commit: { tree: { sha: `${ref}:` } } } },
        },
        pulls: { get: async () => ({ data: { number: 7, node_id: "PR_node", state: "closed", merged: true, merge_commit_sha: merge, head: { sha: head, ref: "csm-ci/repo-settings", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } } } }) },
        git: {
          getTree: async ({ tree_sha }: { tree_sha: string }) => {
            const index = indexes.get(tree_sha) ?? { ref: tree_sha.split(":")[0]!, path: "" };
            return { data: { truncated: false, tree: makeTree(index.ref, index.path) } };
          },
          getBlob: async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: Buffer.from(values.get(file_sha) ?? "").toString("base64") } }),
        },
      },
      paginate: async () => [],
      graphql: async () => ({ repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } }),
    };
    return { source, target: target as unknown as GitHub, reservation };
  }
  const payload = {
    version: 2 as const, kind: "managed-files" as const, repository_id: 42, repository: "owner/repo", pull_number: 7,
    pull_node_id: "PR_node", base_ref: "main", managed_ref: "csm-ci/repo-settings" as const,
    accepted_base: base, accepted_head: head, configuration_sha: "f".repeat(40), release_version: "v1.2.3", release_sha: "1".repeat(40),
    manifest_digest: "2".repeat(64), idempotency_key: "3".repeat(64), accepted_at: "2026-10-29T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z",
  };
  test("rebuilds the complete pinned manifest and verifies all merge-tree paths", async () => {
    const f = completeVerifierFixture();
    const result = await verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge }).catch((error: unknown) => { throw new Error(String(error), { cause: error }); });
    expect(result).toEqual({ matches: true });
  });

  test("detects a base race on a desired file that was unchanged in the accepted PR", async () => {
    const f = completeVerifierFixture({ driftPath: stable[0] });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining(stable[0]) });
  });

  test("rejects a pinned release version and SHA mismatch before comparing trees", async () => {
    const f = completeVerifierFixture({ releaseSha: "9".repeat(40) });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining("version and SHA do not match") });
  });

  test("rejects a release version that no longer resolves to the pinned published release", async () => {
    const f = completeVerifierFixture({ releaseVersion: "v9.9.9" });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining("pinned standard workflow release is not a published stable release") });
  });

  test.each([
    ["different server repository", CONFIG.replace("server_repository: Owner/Server", "server_repository: Owner/Other"), "accepted managed configuration identifies a different server repository"],
    ["disabled managed completion", CONFIG.replace("auto_merge_managed_files: true", "auto_merge_managed_files: false"), "accepted managed configuration no longer enables managed completion"],
    ["missing required operation", CONFIG.replace("ops: [approve, merge, policy-check]", "ops: [approve, merge]"), "accepted managed configuration no longer authorizes managed completion"],
  ] as const)("rejects configuration with %s", async (_name, configText, reason) => {
    const f = completeVerifierFixture({ configText });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason });
  });

  test("rejects an accepted history path absent from the regenerated full manifest", async () => {
    const f = completeVerifierFixture({ historyPath: "unmanaged.txt" });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: "accepted managed pull changed paths outside the regenerated managed manifest" });
  });

  test("rejects a manifest that does not match the pinned config and release", async () => {
    const f = completeVerifierFixture({ manifestDigest: "0".repeat(64) });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: "accepted manifest digest does not match its pinned configuration and release" });
  });

  test("rejects a path produced by both additional source files and generated workflows", async () => {
    const configText = CONFIG.replace("repo_settings: { auto_merge_managed_files: true }", `repo_settings: { auto_merge_managed_files: true, additional_managed_files: { "${stable[0]}": "extra.yml" } }`);
    const f = completeVerifierFixture({ configText, additionalSource: "extra.yml" });
    await expect(verifyManagedMergeTree({ ...f, serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", mergeCommit: merge })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining(`duplicate producer destination ${JSON.stringify(stable[0])}`) });
  });

  function mergedTree(options: { changed?: boolean; baseRace?: boolean; repositoryId?: number; repositoryName?: string; pullState?: string; merged?: boolean; mergeSha?: string; nodeId?: string; headSha?: string; baseRef?: string; headRef?: string; baseRepoId?: number; headRepoId?: number; renamed?: boolean; empty?: boolean; mergedMode?: string } = {}): GitHub {
    const values = new Map([["1111111111111111111111111111111111111111", "reviewed\n"], ["2222222222222222222222222222222222222222", options.changed ? "changed\n" : "reviewed\n"], ["3333333333333333333333333333333333333333", "stable\n"], ["4444444444444444444444444444444444444444", "base-race\n"]]);
    const gh = {
      rest: {
        repos: {
          get: async () => ({ data: { id: options.repositoryId ?? 42, full_name: options.repositoryName ?? "owner/repo" } }),
          compareCommitsWithBasehead: async () => ({ data: { ahead_by: 1, merge_base_commit: { sha: base }, commits: [{ sha: head }] } }),
          getCommit: async ({ ref }: { ref: string }) => {
            if (ref === head) return { data: { parents: [{ sha: base }], files: options.empty ? [] : options.renamed ? [{ filename: "new-managed.yml", previous_filename: "managed.yml", status: "renamed" }] : [{ filename: "managed.yml" }, { filename: "removed.yml", status: "removed" }], author: { id: 900 }, committer: { login: "web-flow" }, commit: { verification: { verified: true }, tree: { sha: "head-tree" } } } };
            const treeSha = ref === merge ? "merge-tree" : ref === base ? "base-tree" : "head-tree";
            return { data: { parents: [], commit: { tree: { sha: treeSha } } } };
          },
        },
        pulls: { get: async () => ({ data: {
          number: 7, node_id: options.nodeId ?? "PR_node", state: options.pullState ?? "closed", merged: options.merged ?? true, merge_commit_sha: options.mergeSha ?? merge,
          head: { sha: options.headSha ?? head, ref: options.headRef ?? "csm-ci/repo-settings", repo: { id: options.headRepoId ?? 42 } },
          base: { ref: options.baseRef ?? "main", repo: { id: options.baseRepoId ?? 42 } },
        } }) },
        git: {
          getTree: async ({ tree_sha, tree }: { tree_sha?: string; tree?: string }) => {
            const sha = tree_sha ?? tree;
            const merged = sha === "merge-tree";
            const hasRemovedFile = sha === "base-tree";
            return { data: { truncated: false, tree: [
              { path: "managed.yml", type: "blob", mode: merged ? options.mergedMode ?? "100644" : "100644", sha: merged ? "2222222222222222222222222222222222222222" : "1111111111111111111111111111111111111111" },
              { path: "unchanged.yml", type: "blob", mode: "100644", sha: merged && options.baseRace ? "4444444444444444444444444444444444444444" : "3333333333333333333333333333333333333333" },
              ...(hasRemovedFile ? [{ path: "removed.yml", type: "blob", mode: "100644", sha: "1111111111111111111111111111111111111111" }] : []),
            ] } };
          },
          getBlob: async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: Buffer.from(values.get(file_sha) ?? "").toString("base64") } }),
        },
      },
      paginate: async () => [],
      graphql: async () => ({ repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } }),
    };
    return gh as unknown as GitHub;
  }

  test("compares every regenerated path and catches drift to a path unchanged by the accepted PR", async () => {
    await expect(compareManagedManifestTrees(mergedTree({ baseRace: true }), {
      owner: "owner", repo: "repo", expectedRef: head, actualRef: merge,
      desired: [{ path: "managed.yml", content: "reviewed\n" }, { path: "unchanged.yml", content: "stable\n" }, { path: "removed.yml", content: null }],
    })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining('"unchanged.yml"') });
  });

  test("compares managed files and deletions against the accepted head", async () => {
    await expect(compareManagedManifestTrees(mergedTree(), {
      owner: "owner", repo: "repo", expectedRef: head, actualRef: merge,
      desired: [{ path: "managed.yml", content: "reviewed\n" }, { path: "unchanged.yml", content: "stable\n" }, { path: "removed.yml", content: null }],
    })).resolves.toEqual({ matches: true });
  });

  test.each([
    ["invalid merge SHA", {}, "bad", "merge commit SHA is invalid"],
    ["wrong repository ID", { repositoryId: 99 }, merge, "merged managed pull repository identity changed"],
    ["wrong repository name", { repositoryName: "attacker/repo" }, merge, "merged managed pull repository identity changed"],
    ["open instead of merged", { pullState: "open", merged: false }, merge, "merged pull does not match the accepted managed reservation"],
    ["wrong merge commit", { mergeSha: "9".repeat(40) }, merge, "merged pull does not match the accepted managed reservation"],
    ["wrong pull node", { nodeId: "other" }, merge, "merged pull does not match the accepted managed reservation"],
    ["wrong accepted head", { headSha: "9".repeat(40) }, merge, "merged pull does not match the accepted managed reservation"],
    ["wrong base ref", { baseRef: "stable" }, merge, "merged pull does not match the accepted managed reservation"],
    ["wrong managed head ref", { headRef: "other" }, merge, "merged pull does not match the accepted managed reservation"],
    ["foreign base repository", { baseRepoId: 99 }, merge, "merged pull does not match the accepted managed reservation"],
    ["foreign head repository", { headRepoId: 99 }, merge, "merged pull does not match the accepted managed reservation"],
  ] as const)("rejects %s", async (_name, options, commit, reason) => {
    await expect(verifyManagedMergeTree({ source: {} as GitHub, target: mergedTree(options), serverRepository: "owner/server", serverBotId: 900, configPath: "csm-ci.yaml", reservation: payload, mergeCommit: commit })).resolves.toMatchObject({ matches: false, reason: expect.stringContaining(reason) });
  });
});

describe("managedDriftDispatchState", () => {
  const repository = "owner/repo";
  const mergeCommit = "8".repeat(40);
  const now = new Date("2026-11-15T00:00:00.000Z");
  const key = createHash("sha256").update(`${repository}#${mergeCommit}`).digest("hex");
  const run = (overrides: Partial<Parameters<typeof managedDriftDispatchState>[0]["runs"][number]> = {}) => ({
    displayTitle: `csm-ci-repo-settings ${repository} ${key}`,
    headBranch: "main",
    event: "workflow_dispatch",
    status: "queued",
    conclusion: null,
    actorId: 41898282,
    actorLogin: "github-actions[bot]",
    createdAt: now.toISOString(),
    ...overrides,
  });

  test("dispatches when there is no matching run and identifies a previous failed run", () => {
    expect(managedDriftDispatchState({ runs: [], repository, mergeCommit, defaultBranch: "main", now })).toBe("dispatch");
    expect(managedDriftDispatchState({ runs: [run({ status: "completed", conclusion: "failure" })], repository, mergeCommit, defaultBranch: "main", now })).toBe("previous-failed");
  });

  test.each([
    ["queued", run()],
    ["running", run({ status: "in_progress" })],
    ["successful", run({ status: "completed", conclusion: "success" })],
  ] as const)("suppresses duplicate dispatch for a matching %s run", (_name, matchingRun) => {
    expect(managedDriftDispatchState({ runs: [matchingRun], repository, mergeCommit, defaultBranch: "main", now })).not.toBe("dispatch");
  });

  test.each([
    ["wrong branch", { headBranch: "other" }],
    ["wrong event", { event: "push" }],
    ["wrong actor ID", { actorId: 7 }],
    ["wrong actor login", { actorLogin: "operator" }],
    ["unknown status", { status: "" }],
    ["invalid timestamp", { createdAt: "invalid" }],
    ["future timestamp", { createdAt: "2026-11-16T00:00:00.000Z" }],
  ] as const)("fails closed for matching run with %s", async (_name, overrides) => {
    expect(() => managedDriftDispatchState({ runs: [run(overrides)], repository, mergeCommit, defaultBranch: "main", now })).toThrow("matching managed-drift");
  });

  test("ignores a matching run older than the bounded lookback", () => {
    expect(managedDriftDispatchState({ runs: [run({ createdAt: "2026-10-01T00:00:00.000Z" })], repository, mergeCommit, defaultBranch: "main", now })).toBe("dispatch");
  });

  test("ignores prior failed attempts while recovering the current ambiguous dispatch", () => {
    expect(managedDriftDispatchState({ runs: [run({ status: "completed", conclusion: "failure" })], repository, mergeCommit, defaultBranch: "main", now, notBefore: new Date("2026-11-15T00:00:01.000Z") })).toBe("dispatch");
  });
});
