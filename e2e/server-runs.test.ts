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

test("does not permanently cache a nonempty but incomplete completed-job listing", async () => {
  const createdAt = new Date().toISOString();
  const run = { id: 31, status: "completed", conclusion: "success", created_at: createdAt, html_url: "https://example.test/31", display_title: "human label owner/repo/1" };
  const label = "csm-ci-approve-humanabc";
  const base = `/repos/${SERVER}/actions`;
  const fetch = fakeFetch([
    { method: "GET", path: `${base}/workflows/csm-ci.yml/runs`, body: { total_count: 1, workflow_runs: [run] } },
    { method: "GET", path: `${base}/runs/31/jobs`, body: { jobs: [{ id: 310, name: "server / intake", conclusion: "skipped" }] }, then: [
      { jobs: [
        { id: 310, name: "server / intake", conclusion: "skipped" },
        { id: 311, name: "server / op", conclusion: "skipped" },
        { id: 312, name: "server / cleanup", conclusion: "success" },
      ] },
    ] },
    { method: "GET", path: `${base}/jobs/312/logs`, body: `2026-10-28T00:00:00Z   LABEL: ${label}` },
  ]);
  const withUrl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    return Object.defineProperty(response, "url", { value: String(input instanceof Request ? input.url : input) });
  }) as typeof globalThis.fetch;
  const ctx: Ctx = { gh: github("test", withUrl), urls: [], untrusted: undefined, ...testMetadata };
  const match = { kind: "approve", repository: "owner/repo", args: { pull_number: 1 }, label };
  const since = new Date(Date.parse(createdAt) - 1_000);

  expect(await serverRuns(ctx, match, since)).toEqual([]);
  expect((await serverRuns(ctx, match, since)).map(({ id }) => id)).toEqual([31]);
  expect(fetch.calls.filter((call) => call.endsWith("/runs/31/jobs"))).toHaveLength(2);
});

test("does not permanently cache a nonempty cleanup log before its label is visible", async () => {
  const createdAt = new Date().toISOString();
  const run = { id: 41, status: "completed", conclusion: "success", created_at: createdAt, html_url: "https://example.test/41", display_title: "human label owner/repo/1" };
  const label = "csm-ci-approve-humanxyz";
  const base = `/repos/${SERVER}/actions`;
  const fetch = fakeFetch([
    { method: "GET", path: `${base}/workflows/csm-ci.yml/runs`, body: { total_count: 1, workflow_runs: [run] } },
    { method: "GET", path: `${base}/runs/41/jobs`, body: { jobs: [
      { id: 410, name: "server / intake", conclusion: "skipped" },
      { id: 411, name: "server / op", conclusion: "skipped" },
      { id: 412, name: "server / cleanup", conclusion: "success" },
    ] } },
    { method: "GET", path: `${base}/jobs/412/logs`, body: "partial response without the label", then: [
      `2026-10-28T00:00:00Z   LABEL: ${label}\n2026-10-28T00:00:01Z Cleaning up orphan processes\n`,
    ] },
  ]);
  const withUrl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    return Object.defineProperty(response, "url", { value: String(input instanceof Request ? input.url : input) });
  }) as typeof globalThis.fetch;
  const ctx: Ctx = { gh: github("test", withUrl), urls: [], untrusted: undefined, ...testMetadata };
  const match = { kind: "approve", repository: "owner/repo", args: { pull_number: 1 }, label };
  const since = new Date(Date.parse(createdAt) - 1_000);

  expect(await serverRuns(ctx, match, since)).toEqual([]);
  expect((await serverRuns(ctx, match, since)).map(({ id }) => id)).toEqual([41]);
  expect(fetch.calls.filter((call) => call.endsWith("/jobs/412/logs"))).toHaveLength(2);
});

test("caches a complete cleanup log that does not match this label", async () => {
  const createdAt = new Date().toISOString();
  const run = { id: 51, status: "completed", conclusion: "success", created_at: createdAt, html_url: "https://example.test/51", display_title: "another human label owner/repo/2" };
  const label = "csm-ci-approve-humanexpected";
  const base = `/repos/${SERVER}/actions`;
  const fetch = fakeFetch([
    { method: "GET", path: `${base}/workflows/csm-ci.yml/runs`, body: { total_count: 1, workflow_runs: [run] } },
    { method: "GET", path: `${base}/runs/51/jobs`, body: { jobs: [
      { id: 510, name: "server / intake", conclusion: "skipped" },
      { id: 511, name: "server / op", conclusion: "skipped" },
      { id: 512, name: "server / cleanup", conclusion: "success" },
    ] } },
    { method: "GET", path: `${base}/jobs/512/logs`, body: "2026-10-28T00:00:00Z   LABEL: csm-ci-approve-other\n2026-10-28T00:00:01Z Cleaning up orphan processes\n" },
  ]);
  const withUrl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    return Object.defineProperty(response, "url", { value: String(input instanceof Request ? input.url : input) });
  }) as typeof globalThis.fetch;
  const ctx: Ctx = { gh: github("test", withUrl), urls: [], untrusted: undefined, ...testMetadata };
  const match = { kind: "approve", repository: "owner/repo", args: { pull_number: 1 }, label };
  const since = new Date(Date.parse(createdAt) - 1_000);

  expect(await serverRuns(ctx, match, since)).toEqual([]);
  expect(await serverRuns(ctx, match, since)).toEqual([]);
  expect(fetch.calls.filter((call) => call.endsWith("/jobs/512/logs"))).toHaveLength(1);
});
