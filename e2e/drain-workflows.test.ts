import { expect, test } from "bun:test";
import { drainWorkflowRuns, type Run } from "./harness.ts";
import { github } from "../src/lib/github.ts";

type ListedRun = Run;
type Route = (url: URL) => unknown | Promise<unknown>;

function testGitHub(route: Route) {
  const requests: URL[] = [];
  const fetch = Object.assign(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    const answer = await route(url);
    const response = answer instanceof Response
      ? answer
      : Response.json(answer);
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
  return { gh: github("test-token", fetch, { backoffMs: [] }), requests };
}

function run(id: number, status: string): ListedRun {
  return {
    id,
    status,
    conclusion: status === "completed" ? "success" : null,
    created_at: "2026-10-30T00:00:42Z",
    display_title: `test ${id}`,
    html_url: `https://example.test/runs/${id}`,
  };
}

function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

function routeFor(runs: () => ListedRun[]): Route {
  return (url) => {
    const workflowRuns = /\/repos\/civitaspo\/(testing-csm-ci-client|testing-csm-ci-server)\/actions\/runs$/u.exec(url.pathname);
    if (workflowRuns) {
      const matches = runs().filter((candidate) => {
        const createdQuery = url.searchParams.get("created");
        const createdTime = createdQuery?.slice(2);
        return createdQuery?.startsWith(">=") && createdTime && Date.parse(candidate.created_at) >= Date.parse(createdTime);
      });
      return { total_count: matches.length, workflow_runs: matches };
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

test("waits for active client and server workflows to complete", async () => {
  const time = clock();
  const { gh, requests } = testGitHub(routeFor(() => [
    run(1, time.now() >= 5 ? "completed" : "queued"),
    run(2, time.now() >= 5 ? "completed" : "in_progress"),
  ]));

  await drainWorkflowRuns(gh, new Date("2026-10-30T00:00:42.987Z"), {
    ...time,
    pollMs: 5,
    quietMs: 10,
    timeoutMs: 100,
  });

  expect(requests.some((url) => url.pathname.includes("testing-csm-ci-client") && url.pathname.endsWith("/actions/runs"))).toBe(true);
  expect(requests.some((url) => url.pathname.includes("testing-csm-ci-server") && url.pathname.endsWith("/actions/runs"))).toBe(true);
  expect(time.now()).toBeGreaterThanOrEqual(15);
  expect(requests.find((url) => url.pathname.endsWith("/actions/runs"))?.searchParams.get("created")).toBe(">=2026-10-30T00:00:42Z");
  expect(requests.some((url) => url.searchParams.has("event"))).toBe(false);
});

test("rescans after a delayed workflow run appears and restarts the quiet window", async () => {
  const time = clock();
  let scans = 0;
  const delayed = run(3, "completed");
  const route = (url: URL) => {
    if (url.pathname.endsWith("/actions/runs")) {
      scans++;
      const visible = url.pathname.includes("testing-csm-ci-client") && time.now() >= 5;
      const matches = visible ? [delayed] : [];
      return { total_count: matches.length, workflow_runs: matches };
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  const { gh, requests } = testGitHub(route);

  await drainWorkflowRuns(gh, new Date("2026-10-30T00:00:42Z"), {
    ...time,
    pollMs: 5,
    quietMs: 10,
    timeoutMs: 100,
  });

  expect(scans).toBeGreaterThan(1);
  expect(time.now()).toBeGreaterThanOrEqual(15);
  expect(requests.some((url) => url.pathname.includes("testing-csm-ci-client") && url.searchParams.get("created") === ">=2026-10-30T00:00:42Z")).toBe(true);
});

test("fails closed when workflow-run discovery returns an API error", async () => {
  const { gh } = testGitHub(() => Response.json({ message: "API unavailable" }, { status: 500 }));
  await expect(drainWorkflowRuns(gh, new Date("2026-10-30T00:00:42Z"), { quietMs: 1, timeoutMs: 20 })).rejects.toThrow();
});

test("fails closed when a discovered workflow remains active past the deadline", async () => {
  const time = clock();
  const { gh } = testGitHub(routeFor(() => [run(4, "in_progress")]));

  await expect(drainWorkflowRuns(gh, new Date("2026-10-30T00:00:42Z"), {
    ...time,
    pollMs: 5,
    quietMs: 10,
    timeoutMs: 12,
  })).rejects.toThrow("timed out draining workflow runs");
});
