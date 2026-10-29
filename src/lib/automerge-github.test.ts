import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { AUTOMERGE_ENVIRONMENT, AUTOMERGE_TASK, createReservation, createReservationStatus, findReservationsForPull, listReservations } from "./automerge-github.ts";

const serverRepository = "owner/server";
const serverBotId = 3000;
const now = new Date("2026-10-29T00:00:00.000Z");
const payload = {
  version: 1 as const,
  repository_id: 4000,
  repository: "owner/client",
  pull_number: 12,
  pull_node_id: "PR_node_12",
  base_ref: "main",
  merger: { id: 5000, login: "operator", type: "User" as const },
  mode: "human" as const,
  command_comment_id: 90,
  accepted_head: "a".repeat(40),
  accepted_at: "2026-10-29T00:00:00.000Z",
  expires_at: "2026-11-05T00:00:00.000Z",
};

function deployment(id: number, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `DEP_${id}`,
    databaseId: id,
    task: AUTOMERGE_TASK,
    payload,
    createdAt,
    creator: { __typename: "Bot", databaseId: serverBotId },
    ...overrides,
  };
}

function harness() {
  const deployments = [
    deployment(1, "2026-10-15T00:00:00.000Z", { payload: JSON.stringify(payload) }),
    deployment(2, "2026-10-28T00:00:00.000Z", { payload: { ...payload, pull_number: 99 } }),
    deployment(3, "2026-10-29T00:00:00.000Z", { creator: { __typename: "User" } }),
    deployment(4, "2026-10-29T00:00:00.000Z", { payload: "{invalid json" }),
    deployment(5, "2026-10-14T23:59:59.000Z"),
  ];
  const restWrites: { path: string; body: Record<string, unknown> }[] = [];
  const graphQueries: { query: string; variables: Record<string, unknown> }[] = [];
  const statuses: Record<string, unknown>[] = [];
  let loseDeploymentResponse = false;
  let loseStatusResponse = false;
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const answer = (value: unknown, status = 200) => Response.json(value, { status });
    if (path === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      graphQueries.push(body);
      const cursor = body.variables.cursor;
      return answer({ data: { repository: { deployments: { nodes: cursor ? [deployment(6, "2026-10-28T00:00:00.000Z", { payload: { ...payload, pull_number: 99 } })] : deployments.slice(0, 4), pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "deploy-next" } } } } });
    }
    if (path === "/repos/owner/server/deployments" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      restWrites.push({ path, body });
      deployments.unshift(deployment(10, "2026-10-29T00:00:00.000Z", { payload: body.payload }));
      if (loseDeploymentResponse) {
        loseDeploymentResponse = false;
        return answer({ message: "upstream timeout" }, 503);
      }
      return answer({ id: 10, node_id: "DEP_10", task: AUTOMERGE_TASK, created_at: "2026-10-29T00:00:00.000Z", creator: { id: serverBotId, type: "Bot" } }, 201);
    }
    if (path === "/repos/owner/server/deployments/10/statuses" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      restWrites.push({ path, body });
      statuses.push({ id: 30, ...body, created_at: "2026-10-29T00:00:00.000Z", creator: { id: serverBotId, type: "Bot" } });
      if (loseStatusResponse) {
        loseStatusResponse = false;
        return answer({ message: "upstream timeout" }, 503);
      }
      return answer({ id: 30, ...body, creator: { id: serverBotId, type: "Bot" } }, 201);
    }
    if (/^\/repos\/owner\/server\/deployments\/\d+\/statuses$/.test(path) && method === "GET") {
      const deploymentId = Number(path.split("/")[5]);
      if (deploymentId === 1) return answer([
        { id: 1, state: "queued", description: "waiting", created_at: "2026-10-29T00:00:01.000Z", creator: { id: serverBotId, type: "Bot" } },
        { id: 2, state: "success", description: "merged", created_at: "2026-10-29T00:00:02.000Z", creator: { id: serverBotId, type: "Bot" } },
      ]);
      return answer(statuses);
    }
    return answer({ message: "Not Found" }, 404);
  }, { preconnect: () => undefined });
  return {
    server: github("test", fetch, { backoffMs: [] }),
    deployments,
    restWrites,
    graphQueries,
    statuses,
    loseDeploymentResponse: () => { loseDeploymentResponse = true; },
    loseStatusResponse: () => { loseStatusResponse = true; },
  };
}

test("lists only valid Server-created reservations and reads REST status history", async () => {
  const h = harness();
  const result = await listReservations({ server: h.server, serverRepository, serverBotId, now });
  expect(result.map((reservation) => reservation.deploymentId)).toEqual([1, 2, 6]);
  expect(result[0]?.statuses.map((item) => item.state)).toEqual(["queued", "success"]);
  expect(result[0]?.state).toEqual({ kind: "terminal", state: "success", at: "2026-10-29T00:00:02.000Z", description: "merged" });
  expect(h.graphQueries.every(({ query }) => !query.includes("statuses"))).toBe(true);
});

test("finds every reservation matching the repository ID and pull number", async () => {
  const h = harness();
  const result = await findReservationsForPull({ server: h.server, serverRepository, serverBotId, now, repositoryId: 4000, pullNumber: 12 });
  expect(result.map((reservation) => reservation.deploymentId)).toEqual([1]);
});

test("creates deployments with object payloads and the specified environment settings", async () => {
  const h = harness();
  const result = await createReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload });
  expect(result).toMatchObject({ deploymentId: 10, nodeId: "DEP_10", payload });
  expect(h.restWrites[0]).toMatchObject({
    path: "/repos/owner/server/deployments",
    body: { ref: "main", task: AUTOMERGE_TASK, environment: AUTOMERGE_ENVIRONMENT, auto_merge: false, required_contexts: [], production_environment: false, transient_environment: false, description: "owner/client#12", payload },
  });
});

test("recovers a deployment after its create response is lost without issuing a second write", async () => {
  const h = harness();
  h.loseDeploymentResponse();
  await expect(createReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload })).resolves.toMatchObject({ deploymentId: 10, payload });
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(1);
});

test("writes status with auto_inactive false and recovers a lost response from Server-authored history", async () => {
  const h = harness();
  h.loseStatusResponse();
  await createReservationStatus({ server: h.server, serverRepository, serverBotId, deploymentId: 10, serverRunUrl: "https://github.com/owner/server/actions/runs/1", pullUrl: "https://github.com/owner/client/pull/12", state: "queued", description: "waiting for approval" });
  expect(h.restWrites.filter((write) => write.path.endsWith("/statuses"))).toHaveLength(1);
  expect(h.restWrites[0]?.body).toMatchObject({ state: "queued", auto_inactive: false, log_url: "https://github.com/owner/server/actions/runs/1", environment_url: "https://github.com/owner/client/pull/12" });
});
