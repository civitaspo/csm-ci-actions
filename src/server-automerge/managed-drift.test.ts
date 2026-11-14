import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { github, type GitHub } from "../lib/github.ts";
import { reconcileManagedDrift } from "./managed-drift.ts";

const now = new Date("2026-11-15T00:00:00.000Z");
const repository = "owner/client";
const mergeCommit = "8".repeat(40);
const workflowPath = "/repos/owner/server/actions/workflows/csm-ci-repo-settings.yml/dispatches";
const workflowRunPath = "/repos/owner/server/actions/workflows/csm-ci-repo-settings.yml/runs";
const driftKey = createHash("sha256").update(`${repository}#${mergeCommit}`).digest("hex");
const title = `csm-ci-repo-settings ${repository} ${driftKey}`;

function githubFixture(options: {
  runs?: Record<string, unknown>[][];
  dispatchStatus?: number;
} = {}): { client: GitHub; requests: { method: string; path: string; search: string; body: string | undefined }[] } {
  const requests: { method: string; path: string; search: string; body: string | undefined }[] = [];
  const responses = options.runs ?? [[]];
  let reads = 0;
  const response = (url: string, body: string | null, status: number, contentType?: string) => {
    const value = new Response(body, { status, ...(contentType ? { headers: { "content-type": contentType } } : {}) });
    Object.defineProperty(value, "url", { value: url });
    return value;
  };
  const fetcher = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://api.github.com");
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "GET" && url.pathname === workflowRunPath) {
      const workflowRuns = responses[Math.min(reads++, responses.length - 1)] ?? [];
      return response(url.href, JSON.stringify({ total_count: workflowRuns.length, workflow_runs: workflowRuns }), 200, "application/json");
    }
    if (method === "POST" && url.pathname === workflowPath) {
      const status = options.dispatchStatus ?? 204;
      return status === 204
        ? response(url.href, null, status)
        : response(url.href, JSON.stringify({ message: "dispatch response lost" }), status, "application/json");
    }
    return response(url.href, JSON.stringify({ message: "Not Found" }), 404, "application/json");
  }) as typeof globalThis.fetch;
  return { client: github("test-token", fetcher, { backoffMs: [] }), requests };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    display_title: title,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "queued",
    conclusion: null,
    actor: { id: 41898282, login: "github-actions[bot]" },
    created_at: now.toISOString(),
    ...overrides,
  };
}

describe("reconcileManagedDrift", () => {
  test("dispatches the pinned repository-settings workflow with managed-drift inputs", async () => {
    const { client, requests } = githubFixture();

    const result = await reconcileManagedDrift({
      configReader: client,
      serverRepository: "owner/server",
      defaultBranch: "main",
      repository,
      mergeCommit,
      reason: "managed file bytes differ",
      now: () => now,
      pause: async () => {},
    });

    expect(result).toBe("managed file bytes differ; managed-files reconciliation dispatched");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "GET", path: workflowRunPath, search: "?event=workflow_dispatch&per_page=100" });
    expect(requests[1]).toMatchObject({ method: "POST", path: workflowPath });
    expect(JSON.parse(requests[1]!.body ?? "{}")).toEqual({
      ref: "main",
      inputs: { repository, targets: "managed-files", "managed-drift-key": driftKey },
    });
  });

  test("does not dispatch when the exact merge already has a running recovery", async () => {
    const { client, requests } = githubFixture({ runs: [[run()]] });

    const result = await reconcileManagedDrift({ configReader: client, serverRepository: "owner/server", defaultBranch: "main", repository, mergeCommit, now: () => now });

    expect(result).toContain("reconciliation is already queued or running");
    expect(requests.map(({ method }) => method)).toEqual(["GET"]);
  });

  test("recovers an ambiguous dispatch response from the exact newly observed run", async () => {
    const { client, requests } = githubFixture({ runs: [[], [run()]], dispatchStatus: 500 });

    const result = await reconcileManagedDrift({
      configReader: client,
      serverRepository: "owner/server",
      defaultBranch: "main",
      repository,
      mergeCommit,
      now: () => now,
      pause: async () => {},
    });

    expect(result).toContain("reconciliation run was found after an ambiguous dispatch response");
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(2);
  });

  test("does not retry an ambiguous dispatch when bounded lookup finds no run", async () => {
    const { client, requests } = githubFixture({ dispatchStatus: 500 });

    const result = await reconcileManagedDrift({
      configReader: client,
      serverRepository: "owner/server",
      defaultBranch: "main",
      repository,
      mergeCommit,
      now: () => now,
      pause: async () => {},
    });

    expect(result).toContain("no retry was attempted");
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(4);
  });
});
