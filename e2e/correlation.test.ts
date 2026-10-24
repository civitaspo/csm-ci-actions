import { expect, test } from "bun:test";
import { completedRequestRuns, findRecentRunByTitle, findRunByTitle, matchesAcceptedRequest, matchesCleanupLabel, recentItems, runsForComments } from "./correlation.ts";
import { type RequestMatch, serverRuns } from "./harness.ts";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";

const request: RequestMatch = {
  kind: "policy-check",
  repository: "civitaspo/testing-csm-ci-client",
  args: { pull_number: 23, comment_id: 456 },
};

test("a matching rejection message cannot identify an unrelated run", () => {
  const unrelatedLog = "repository civitaspo/testing-csm-ci-client does not enable securefix";
  expect(matchesAcceptedRequest(unrelatedLog, request)).toBe(false);
  expect(matchesAcceptedRequest(`accepted policy-check for ${request.repository} {"pull_number":23,"comment_id":456}`, request)).toBe(true);
  expect(matchesAcceptedRequest(`accepted policy-check for ${request.repository} {"pull_number":23,"comment_id":457}`, request)).toBe(false);
});

test("selects a workflow dispatch by its unique display title", () => {
  const runs = [
    { id: 9, display_title: "csm-ci-smoke other-correlation" },
    { id: 10, display_title: "csm-ci-smoke this-correlation" },
  ];
  expect(findRunByTitle(runs, "csm-ci-smoke this-correlation")?.id).toBe(10);
  expect(findRunByTitle(runs, "csm-ci-smoke missing-correlation")).toBeUndefined();
});

test("requires one client run for each distinct comment instead of counting duplicate runs", () => {
  const duplicate = [
    { id: 1, display_title: "request #79, comment #123" },
    { id: 2, display_title: "request #79, comment #123" },
  ];
  expect(runsForComments(duplicate, 79, [123, 456])).toBeUndefined();
  const complete = [...duplicate, { id: 3, display_title: "request #79, comment #456" }];
  expect(runsForComments(complete, 79, [123, 456])?.map(({ id }) => id)).toEqual([1, 3]);
  expect(runsForComments([{ id: 4, display_title: "request #79, comment #1230" }], 79, [123])).toBeUndefined();
});

test("finds the matching run on a later workflow-run page", async () => {
  const since = new Date("2026-10-25T00:00:00Z");
  async function* pages() {
    yield Array.from({ length: 100 }, (_, index) => ({ created_at: "2026-10-25T00:02:00Z", id: index, log: "unrelated" }));
    yield [{ created_at: "2026-10-25T00:01:00Z", id: 101, log: `accepted policy-check for ${request.repository} {"pull_number":23,"comment_id":456}` }];
  }
  const runs = await recentItems(pages(), since);
  expect(runs.filter((run) => matchesAcceptedRequest(run.log, request)).map(({ id }) => id)).toEqual([101]);
});

test("does not reuse an old probe or check run while the new run is pending", async () => {
  const since = new Date("2026-10-25T00:01:00Z");
  async function* pages() {
    yield [
      { created_at: "2026-10-25T00:00:00Z", id: 8 },
      { created_at: "2026-10-25T00:02:00Z", id: 9 },
    ];
  }
  expect((await recentItems(pages(), since)).map(({ id }) => id)).toEqual([9]);
});

test("finds a correlated dispatch beyond the first workflow-run page", async () => {
  const since = new Date("2026-10-25T00:00:00Z");
  async function* pages() {
    yield Array.from({ length: 100 }, (_, id) => ({ created_at: "2026-10-25T00:02:00Z", id, display_title: "csm-ci-smoke another-run" }));
    yield [{ created_at: "2026-10-25T00:01:00Z", id: 101, display_title: "csm-ci-smoke target-run" }];
  }
  expect((await findRecentRunByTitle(pages(), since, "csm-ci-smoke target-run"))?.id).toBe(101);
});

test("cleanup matches the whole label value, not another label with that prefix", () => {
  expect(matchesCleanupLabel("2026-10-25T00:00:00Z   LABEL: csm-ci-approve-abc\r\n", "csm-ci-approve-abc")).toBe(true);
  expect(matchesCleanupLabel("LABEL: csm-ci-approve-abc", "csm-ci-approve-abc")).toBe(true);
  expect(matchesCleanupLabel("  LABEL: csm-ci-approve-abcdef", "csm-ci-approve-abc")).toBe(false);
  expect(matchesCleanupLabel("  OTHER_LABEL: csm-ci-approve-abc", "csm-ci-approve-abc")).toBe(false);
});

test("waits for every emitted request despite delayed server run visibility", () => {
  const first = { id: 1, status: "completed" };
  expect(completedRequestRuns([first], 2)).toBeUndefined();
  expect(completedRequestRuns([first, { id: 2, status: "queued" }], 2)).toBeUndefined();
  const all = [first, { id: 2, status: "completed" }];
  expect(completedRequestRuns(all, 2)).toEqual(all);
});

test("correlates a skipped intake through cleanup without downloading a nonexistent intake log", async () => {
  const base = "/repos/civitaspo/testing-csm-ci-server/actions";
  const fetch = fakeFetch([
    { method: "GET", path: `${base}/workflows/csm-ci.yml/runs`, body: { total_count: 1, workflow_runs: [{ id: 10, created_at: "2026-10-25T00:01:00Z", status: "completed", conclusion: "success" }] } },
    { method: "GET", path: `${base}/runs/10/jobs`, body: { jobs: [{ id: 20, name: "server / intake", conclusion: "skipped" }, { id: 21, name: "server / cleanup", conclusion: "success" }] } },
    { method: "GET", path: `${base}/jobs/21/logs`, body: "2026-10-25T00:01:05Z   LABEL: csm-ci-approve-humanabc" },
  ]);
  const fetchWithUrl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    Object.defineProperty(response, "url", { value: typeof input === "string" ? input : input instanceof URL ? input.href : input.url });
    return response;
  }, { preconnect: () => undefined });
  const ctx = { gh: github("t", fetchWithUrl), urls: [], untrusted: undefined };
  const since = new Date("2026-10-25T00:00:00Z");
  expect((await serverRuns(ctx, { ...request, label: "csm-ci-approve-humanabc" }, since)).map((run) => run.id)).toEqual([10]);
  expect(await serverRuns(ctx, request, since)).toEqual([]);
  expect(fetch.calls).not.toContain(`GET ${base}/jobs/20/logs`);
});
