import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CONFIG_YAML, config } from "./testing.ts";
import { parseConfig } from "./config.ts";
import type { GitHub } from "./github.ts";
import { inspectSecurefix } from "./securefix-operation.ts";

const repository = "owner/client";
const runSha = "a".repeat(40);
const appliedSha = "b".repeat(40);
const parentTreeSha = "c".repeat(40);
const appliedTreeSha = "d".repeat(40);
const fileContent = Buffer.from("generated\n");

async function inspectCurrentCommit(extraFile: boolean) {
  const artifactPath = await mkdtemp(join(tmpdir(), "securefix-operation-test-"));
  await mkdir(join(artifactPath, "files"));
  const manifest = {
    version: 1,
    repository,
    run_id: 42,
    head_sha: runSha,
    message: "Generate file",
    files: [{ kind: "write", path: "generated.txt", size: fileContent.length, sha256: createHash("sha256").update(fileContent).digest("hex") }],
  };
  await writeFile(join(artifactPath, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(artifactPath, "files", "0000"), fileContent);

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
  };
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    title: "Generated change",
    body: null,
    base: { ref: "main", sha: runSha },
    head: { ref: "feature", sha: appliedSha, repo: { id: 1, full_name: repository } },
  };
  const serverCommit = {
    parents: [{ sha: runSha }],
    author: { id: 3000 },
    committer: { login: "web-flow" },
    commit: { verification: { verified: true }, tree: { sha: appliedTreeSha } },
  };
  const parentCommit = { parents: [], commit: { tree: { sha: parentTreeSha } } };
  const applyEntries = [
    { path: "generated.txt", type: "blob", mode: "100644", sha: "e".repeat(40) },
    ...(extraFile ? [{ path: "unexpected.txt", type: "blob", mode: "100644", sha: "f".repeat(40) }] : []),
  ];
  const listArtifacts = async () => ({ data: [{ id: 99, name: "securefix", expired: false, size_in_bytes: 512 }] });
  const listPulls = async () => ({ data: [pull] });
  const gh = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts: listArtifacts },
      repos: {
        get: async () => ({ data: { id: 1, default_branch: "main" } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: ref === runSha ? parentCommit : serverCommit }),
        getContent: async () => ({ data: { type: "file", sha: "1".repeat(40) } }),
      },
      pulls: { get: async () => ({ data: pull }), list: listPulls },
      git: {
        getRef: async () => ({ data: { object: { sha: appliedSha } } }),
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false, tree: tree_sha === parentTreeSha ? [] : applyEntries } }),
        getBlob: async () => ({ data: { encoding: "base64", content: fileContent.toString("base64") } }),
      },
    },
    paginate: async (method: unknown) => method === listArtifacts ? [{ id: 99, name: "securefix", expired: false, size_in_bytes: 512 }] : method === listPulls ? [pull] : [],
    graphql: async () => ({ repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } }),
  } as unknown as GitHub;
  try {
    return await inspectSecurefix(gh, config(), repository, 42, artifactPath);
  } finally {
    await rm(artifactPath, { recursive: true, force: true });
  }
}

async function inspectNewRouteFile(path: string) {
  const artifactPath = await mkdtemp(join(tmpdir(), "securefix-route-add-test-"));
  await mkdir(join(artifactPath, "files"));
  const content = Buffer.from("new content\n");
  const manifest = {
    version: 1,
    repository,
    run_id: 42,
    head_sha: runSha,
    message: "Generate file",
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
  const missing = Object.assign(new Error("Not Found"), { status: 404 });
  const gh = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts: listArtifacts },
      repos: {
        get: async () => ({ data: { id: 1, default_branch: "main" } }),
        getContent: async () => { throw missing; },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref === "heads/main") return { data: { object: { sha: runSha } } };
          throw missing;
        },
      },
    },
    paginate: async (method: unknown) => method === listArtifacts ? [artifact] : [],
  } as unknown as GitHub;
  const yaml = CONFIG_YAML
    .replace("repositories:", `securefix:\n  allow_workflow_changes: false\n  routes:\n    - name: release-pr\n      from: default\n      to: release/next\n      workflow: .github/workflows/release.yml\n      paths: { new-file.txt: any, package.json: version-only }\nrepositories:`)
    .replace("ops: [approve, policy-check]", "ops: [approve, policy-check, securefix]");
  try {
    return await inspectSecurefix(gh, parseConfig(yaml), repository, 42, artifactPath);
  } finally {
    await rm(artifactPath, { recursive: true, force: true });
  }
}

describe("securefix retry inspection", () => {
  test("accepts the exact server-made commit on a pull request branch as already applied", async () => {
    const result = await inspectCurrentCommit(false);
    expect(result.status).toBe("already-applied");
  });

  test("does not call a server commit with extra changed files already applied", async () => {
    await expect(inspectCurrentCommit(true)).rejects.toThrow("the branch moved after the request");
  });

  test("allows a new route file when its path allows any contents", async () => {
    expect((await inspectNewRouteFile("new-file.txt")).status).toBe("ready");
  });

  test("rejects a new file whose route requires an original version line", async () => {
    await expect(inspectNewRouteFile("package.json")).rejects.toThrow('securefix route cannot find the original file "package.json"');
  });
});
