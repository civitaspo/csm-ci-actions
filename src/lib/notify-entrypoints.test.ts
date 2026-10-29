import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

function runEntry(action: "approve" | "merge" | "automerge", mode: string) {
  const directory = mkdtempSync(join(tmpdir(), "csm-notification-entry-"));
  try {
    const preload = join(directory, "preload.ts");
    const receipt = join(directory, "receipt.json");
    const outputs = join(directory, "outputs.txt");
    const testing = new URL("./testing.ts", import.meta.url).href;
    const acceptedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const payload = {
      version: 1, repository_id: 42, repository: "owner/repo", pull_number: 12, pull_node_id: "pull-node", base_ref: "main",
      merger: { id: 10, login: "alice", type: "User" }, mode: "human", command_comment_id: 9,
      accepted_head: "a".repeat(40), accepted_at: acceptedAt, expires_at: new Date(Date.parse(acceptedAt) + 7 * 24 * 60 * 60_000).toISOString(),
    };
    const deploymentList = { data: { repository: { deployments: { nodes: [{ id: "deployment-node", databaseId: 123, task: "csm-ci:automerge", payload, createdAt: acceptedAt, creator: { __typename: "Bot", databaseId: 3000 } }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    const emptyDeploymentList = { data: { repository: { deployments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    const initialGraphql = action === "automerge" ? deploymentList : { data: { node: { databaseId: 9, lastEditedAt: null } } };
    const laterGraphql = action === "merge" ? [emptyDeploymentList, emptyDeploymentList] : [];
    writeFileSync(outputs, "");
    writeFileSync(preload, `
import { fakeFetch, CONFIG_YAML } from ${JSON.stringify(testing)};
import { writeFileSync } from "node:fs";
const head = "a".repeat(40);
const pull = { number: 12, node_id: "pull-node", state: "open", draft: ${action === "approve"}, user: { id: 10 }, head: { sha: head, repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { id: 42, full_name: "owner/repo", default_branch: "main" } } };
const now = new Date(Date.now() - 60_000).toISOString();
const fetch = fakeFetch([
  { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML },
  { method: "GET", path: "/repos/owner/server", body: { default_branch: "main" } },
  { method: "GET", path: "/repos/owner/repo", body: { id: 42, full_name: "owner/repo" } },
  { method: "GET", path: "/repositories/42", body: { id: 42, full_name: "owner/repo" } },
  { method: "GET", path: "/repos/owner/repo/pulls/12", body: pull, then: [{ ...pull, state: "closed" }] },
  { method: "GET", path: "/repos/owner/repo/issues/comments/9", body: { id: 9, node_id: "comment-node", body: "/${action}", issue_url: "https://api.github.com/repos/owner/repo/issues/12", created_at: now, updated_at: now, user: { id: 10, login: "alice", type: "User" } } },
  { method: "POST", path: "/graphql", body: ${JSON.stringify(initialGraphql)}, then: ${JSON.stringify(laterGraphql)} },
  { method: "GET", path: "/repos/owner/server/deployments/123/statuses", body: [] },
  { method: "GET", path: "/repos/owner/repo/issues/12/comments", body: [] },
  { method: "POST", path: "/repos/owner/repo/issues/comments/9/reactions", body: {} },
  { method: "GET", path: "/repos/owner/repo/commits/" + head, body: { commit: { committer: { date: now } } } },
  { method: "GET", path: "/repos/owner/repo/issues/12/timeline", body: [] },
  { method: "POST", path: "/repos/owner/server/deployments", body: { id: 123, node_id: "deployment-node", task: "csm-ci:automerge", created_at: now, creator: { id: 3000, type: "Bot" } } },
  { method: "POST", path: "/repos/owner/server/deployments/123/statuses", body: { id: 456 } },
  { method: "GET", path: "/repos/owner/repo/issues/12/labels", body: [] },
  { method: "POST", path: "/repos/owner/repo/issues/12/labels", body: [] },
  { method: "POST", path: "/repos/owner/repo/issues/12/comments", body: { id: 99 } },
]);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === "/repos/owner/repo/issues/12/comments" && init?.method === "POST") writeFileSync(${JSON.stringify(receipt)}, String(init.body));
  return fetch(input, init);
};
`);
    const result = Bun.spawnSync([process.execPath, "--preload", preload, `src/server-${action}/main.ts`], {
      env: {
        PATH: process.env.PATH ?? "", GITHUB_REPOSITORY: "owner/server", GITHUB_SHA: "b".repeat(40),
        GITHUB_SERVER_URL: "https://github.example", GITHUB_RUN_ID: "9007199254740993", GITHUB_RUN_ATTEMPT: "3", GITHUB_OUTPUT: outputs,
        "INPUT_GITHUB-TOKEN": "fixture", "INPUT_SERVER-TOKEN": "fixture", "INPUT_APPROVER-TOKEN": "fixture", "INPUT_NOTIFICATION-TOKEN": "fixture", "INPUT_DEPLOYMENTS-TOKEN": "fixture",
        "INPUT_CONFIG-PATH": "csm-ci.yaml", INPUT_REPOSITORY: "owner/repo", INPUT_ARGS: '{"pull_number":12,"comment_id":9}',
        "INPUT_PULL-NUMBER": "12", "INPUT_DEPLOYMENT-ID": "123",
        INPUT_MODE: mode, INPUT_HEAD: "a".repeat(40), "INPUT_FAILURE-MESSAGE": "original wait failure",
      },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    if (!existsSync(receipt)) throw new Error(`entrypoint did not post a receipt (exit ${result.exitCode}): ${result.stdout.toString()} ${result.stderr.toString()} ${readFileSync(outputs, "utf8")}`);
    const body = z.object({ body: z.string() }).parse(JSON.parse(readFileSync(receipt, "utf8"))).body;
    return { exitCode: result.exitCode, body, outputs: readFileSync(outputs, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([
  ["approve", "", 1], ["merge", "accept", 0], ["automerge", "evaluate", 0],
] satisfies ["approve" | "merge" | "automerge", string, number][]) ("%s %s receipt links the actual server run and attempt", (action, mode, exitCode) => {
  const result = runEntry(action, mode);
  expect(result.exitCode).toBe(exitCode);
  expect(result.body).toContain('<a href="https://github.example/owner/server/actions/runs/9007199254740993/attempts/3">Server run 9007199254740993, attempt 3</a>');
  expect(result.body).toContain('<a href="https://github.example/owner/repo/pull/12#issuecomment-9">Request</a>');
  expect(result.body).toContain(`<a href="https://github.example/owner/repo/commit/${"a".repeat(40)}">Head aaaaaaa</a>`);
  if (mode === "accept") {
    expect(result.outputs).toContain("reservation-id<<");
    expect(result.outputs).toContain("123");
    expect(result.body.split("<sub>")[0]).toContain("Merge reserved until");
    expect(result.body).toContain("/deployments/123");
  }
  if (mode === "evaluate") {
    expect(result.body.split("<sub>")[0]).toContain("expired");
    expect(result.body).toContain("/deployments/123");
  }
  if (action === "approve") expect(result.body.split("<sub>")[0]).toContain("#12 is a draft");
});
