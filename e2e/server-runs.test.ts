import { testMetadata } from "./test-metadata.ts";
import { expect, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { type Ctx, SERVER, serverRuns } from "./harness.ts";

test("polling server runs downloads a completed run's jobs and logs once", async () => {
  const createdAt = new Date().toISOString();
  const run = (id: number, status: string) => ({ id, status, conclusion: status === "completed" ? "success" : null, created_at: createdAt, html_url: `https://example.test/${id}`, display_title: "label" });
  const accepted = 'accepted merge for owner/repo {"pull_number":12}';
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${SERVER}/actions/workflows/csm-ci.yml/runs`, body: { total_count: 2, workflow_runs: [run(2, "in_progress"), run(1, "completed")] } },
    { method: "GET", path: `/repos/${SERVER}/actions/runs/1/jobs`, body: { total_count: 0, jobs: [] }, then: [
      { total_count: 2, jobs: [{ id: 10, name: "server / intake", conclusion: "success" }, { id: 11, name: "server / cleanup", conclusion: null }] },
      { total_count: 2, jobs: [{ id: 10, name: "server / intake", conclusion: "success" }, { id: 11, name: "server / cleanup", conclusion: "success" }] },
    ] },
    { method: "GET", path: `/repos/${SERVER}/actions/jobs/10/logs`, body: "", then: [`2026-10-28T00:00:00Z ${accepted}\n`] },
  ]);
  // Octokit pagination reads the response URL, which a constructed Response leaves empty.
  const withUrl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    return Object.defineProperty(response, "url", { value: String(input instanceof Request ? input.url : input) });
  }) as typeof globalThis.fetch;
  const ctx: Ctx = { gh: github("test", withUrl), urls: [], untrusted: undefined, ...testMetadata };
  const match = { kind: "merge", repository: "owner/repo", args: { pull_number: 12 } };
  const since = new Date(Date.parse(createdAt) - 1_000);

  const polls = [];
  for (let poll = 0; poll < 4; poll++) polls.push((await serverRuns(ctx, match, since)).map((found) => found.id));
  expect(polls).toEqual([[], [], [1], [1]]);

  expect(fetch.calls.filter((call) => call.endsWith("/runs/1/jobs"))).toHaveLength(3);
  expect(fetch.calls.filter((call) => call.endsWith("/jobs/10/logs"))).toHaveLength(2);
  expect(fetch.calls.some((call) => call.includes("/runs/2/"))).toBe(false);
});
