import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { AUTOMERGE_ENVIRONMENT, AUTOMERGE_TASK, createManagedReservation, createReservation, createReservationStatus, findReservationsForPull, listReservations } from "./automerge-github.ts";

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
const managedPayload = {
  version: 2 as const,
  kind: "managed-files" as const,
  repository_id: 4000,
  repository: "owner/client",
  pull_number: 12,
  pull_node_id: "PR_node_12",
  base_ref: "main",
  managed_ref: "csm-ci/repo-settings" as const,
  accepted_base: "9".repeat(40),
  accepted_head: "a".repeat(40),
  configuration_sha: "b".repeat(40),
  release_version: "v1.2.3",
  release_sha: "c".repeat(40),
  manifest_digest: "d".repeat(64),
  idempotency_key: "e".repeat(64),
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
    statuses: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function harness(options: { malformedDeploymentOneStatus?: boolean; duplicateRecovery?: boolean; createdDeployment?: { task?: string; creator?: { id: number; type: string } } } = {}) {
  const deployments = [
    deployment(1, "2026-10-15T00:00:00.000Z", { payload: JSON.stringify(JSON.stringify(payload)), statuses: { nodes: [
      { id: "STATUS_1", state: "QUEUED", description: "waiting", createdAt: "2026-10-29T00:00:01.000Z", creator: { __typename: "Bot", databaseId: serverBotId } },
      { id: "STATUS_2", state: "SUCCESS", description: "merged", createdAt: "2026-10-29T00:00:02.000Z", creator: { __typename: "Bot", databaseId: serverBotId } },
      ...(options.malformedDeploymentOneStatus ? [{ state: "FAILURE" }] : []),
    ], pageInfo: { hasNextPage: false } } }),
    deployment(2, "2026-10-28T00:00:00.000Z", { payload: { ...payload, pull_number: 99 } }),
    deployment(3, "2026-10-29T00:00:00.000Z", { creator: { __typename: "User" } }),
    deployment(4, "2026-10-29T00:00:00.000Z", { payload: "{invalid json" }),
    deployment(5, "2026-10-14T23:59:59.000Z"),
  ];
  const restWrites: { path: string; body: Record<string, unknown> }[] = [];
  const restReads: string[] = [];
  const restHistory = new Map<number, Record<string, unknown>[]>();
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
      return answer({ data: { repository: { deployments: { nodes: cursor ? [deployment(6, "2026-10-28T00:00:00.000Z", { payload: { ...payload, pull_number: 99 } }), deployment(7, "2026-10-28T00:00:00.000Z", { payload: JSON.stringify(JSON.stringify(JSON.stringify(payload))) })] : deployments.slice(0, 4), pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "deploy-next" } } } } });
    }
    if (path === "/repos/owner/server/deployments" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      restWrites.push({ path, body });
      const createdAt = new Date().toISOString();
      deployments.unshift(deployment(10, createdAt, { payload: body.payload }));
      if (options.duplicateRecovery) deployments.unshift(deployment(11, createdAt, { payload: body.payload }));
      if (loseDeploymentResponse) {
        loseDeploymentResponse = false;
        return answer({ message: "upstream timeout" }, 503);
      }
      return answer({ id: 10, node_id: "DEP_10", task: options.createdDeployment?.task ?? AUTOMERGE_TASK, created_at: createdAt, creator: options.createdDeployment?.creator ?? { id: serverBotId, type: "Bot" } }, 201);
    }
    if (/^\/repos\/owner\/server\/deployments\/\d+\/statuses$/.test(path) && method === "POST") {
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
      restReads.push(path);
      const deploymentId = Number(path.split("/")[5]);
      const history = restHistory.get(deploymentId);
      if (history) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const headers = page * 100 < history.length ? { link: `<https://api.github.com${path}?per_page=100&page=${page + 1}>; rel="next"` } : {};
        return Response.json(history.slice((page - 1) * 100, page * 100), { headers });
      }
      if (deploymentId === 1 && options.malformedDeploymentOneStatus) return answer([
        { id: 2, state: "success", description: "merged", created_at: "2026-10-29T00:00:02.000Z", creator: { id: serverBotId, type: "Bot" } },
        { state: "failure", description: "malformed terminal status", created_at: "2026-10-29T00:00:03.000Z", creator: { id: serverBotId, type: "Bot" } },
      ]);
      if (deploymentId === 1) return answer([
        { id: 1, state: "queued", description: "waiting", created_at: "2026-10-29T00:00:01.000Z", log_url: null, environment_url: null, creator: { id: serverBotId, type: "Bot" } },
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
    restReads,
    restHistory,
    graphQueries,
    statuses,
    loseDeploymentResponse: () => { loseDeploymentResponse = true; },
    loseStatusResponse: () => { loseStatusResponse = true; },
  };
}

test("lists only valid Server-created reservations with GraphQL status history", async () => {
  const h = harness();
  const result = await listReservations({ server: h.server, serverRepository, serverBotId, now });
  expect(result.map((reservation) => reservation.deploymentId)).toEqual([1, 2, 6]);
  expect(result[0]?.statuses.map((item) => item.state)).toEqual(["queued", "success"]);
  expect(result[0]?.state).toEqual({ kind: "terminal", state: "success", at: "2026-10-29T00:00:02.000Z", description: "merged", reason: "other" });
  expect(h.restReads).toEqual([]);
  expect(h.graphQueries.every(({ query }) => query.includes("statuses"))).toBe(true);
});

test("rejects an unparseable status instead of treating the reservation as active", async () => {
  const h = harness({ malformedDeploymentOneStatus: true });
  await expect(listReservations({ server: h.server, serverRepository, serverBotId, now })).rejects.toThrow("GitHub returned an invalid deployment status for deployment 1");
});

test("ignores statuses from untrusted creators", async () => {
  const h = harness();
  h.deployments[0] = deployment(1, "2026-10-15T00:00:00.000Z", { statuses: { nodes: [
    { id: "foreign", state: "SUCCESS", description: "forged", createdAt: "2026-10-29T00:00:01.000Z", creator: { __typename: "Bot", databaseId: 9999 } },
    { id: "human", state: "FAILURE", description: "forged", createdAt: "2026-10-29T00:00:02.000Z", creator: { __typename: "User" } },
    { id: "trusted", state: "QUEUED", description: "waiting", createdAt: "2026-10-29T00:00:03.000Z", creator: { __typename: "Bot", databaseId: serverBotId } },
  ], pageInfo: { hasNextPage: false } } });
  const result = await listReservations({ server: h.server, serverRepository, serverBotId, now });
  expect(result[0]?.state).toEqual({ kind: "active", waitingReason: "waiting" });
});

test.each(["more statuses", "same timestamp"])('reads complete REST history when GraphQL has %s', async (condition) => {
  const h = harness();
  const node = (state: string, createdAt: string) => ({ id: state, state, description: state, createdAt, creator: { __typename: "Bot", databaseId: serverBotId } });
  h.deployments[0] = deployment(1, "2026-10-15T00:00:00.000Z", { statuses: { nodes: [node("QUEUED", "2026-10-29T00:00:01.000Z"), node("SUCCESS", condition === "same timestamp" ? "2026-10-29T00:00:01.000Z" : "2026-10-29T00:00:02.000Z")], pageInfo: { hasNextPage: condition === "more statuses" } } });
  const status = (id: number, state: string, description: string) => ({ id, state, description, created_at: "2026-10-29T00:00:02.000Z", creator: { id: serverBotId, type: "Bot" } });
  h.restHistory.set(1, condition === "same timestamp"
    ? [status(9, "failure", "later"), status(3, "success", "merged")]
    : [...Array.from({ length: 100 }, (_, i) => status(i + 1, "queued", "waiting")), status(101, "success", "merged")]);
  const result = await listReservations({ server: h.server, serverRepository, serverBotId, now });
  expect(result[0]?.state).toEqual({ kind: "terminal", state: "success", at: "2026-10-29T00:00:02.000Z", description: "merged", reason: "other" });
  expect(h.restReads).toEqual(Array(condition === "more statuses" ? 2 : 1).fill("/repos/owner/server/deployments/1/statuses"));
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

test("uses the immutable display commit SHA as the reservation ref", async () => {
  const h = harness();
  const displayCommit = "b".repeat(40);
  await createReservation({ server: h.server, serverRepository, defaultBranch: "main", displayCommit, serverBotId, payload });
  expect(h.restWrites[0]?.body.ref).toBe(displayCommit);
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

test("creates a managed reservation with its deterministic idempotency key in the payload", async () => {
  const h = harness();
  const result = await createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" });
  expect(result).toMatchObject({ deploymentId: 10, payload: managedPayload });
  expect(h.restWrites[0]?.body).toMatchObject({ payload: managedPayload, task: AUTOMERGE_TASK, environment: AUTOMERGE_ENVIRONMENT });
});

test("recovers a lost managed deployment response by exact idempotency key without a duplicate write", async () => {
  const h = harness();
  h.loseDeploymentResponse();
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).resolves.toMatchObject({ deploymentId: 10, payload: managedPayload });
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(1);
});

test("rejects ambiguous recovery when a lost response leaves multiple active same-key records", async () => {
  const h = harness({ duplicateRecovery: true });
  h.deployments.unshift(deployment(20, new Date().toISOString(), { payload: { ...managedPayload, idempotency_key: "f".repeat(64) }, statuses: { nodes: [
    { id: "STATUS_20", state: "INACTIVE", description: "old", createdAt: new Date().toISOString(), creator: { __typename: "Bot", databaseId: serverBotId } },
  ], pageInfo: { hasNextPage: false } } }));
  h.loseDeploymentResponse();
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).rejects.toThrow("multiple managed-file reservations match the idempotency key");
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(1);
});

test("rejects a newly created deployment with the wrong creator identity", async () => {
  const h = harness({ createdDeployment: { creator: { id: 9999, type: "Bot" } } });
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).rejects.toThrow("created deployment identity does not match csm-ci automerge");
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(1);
});

test("reuses an active managed reservation with the same idempotency key", async () => {
  const h = harness();
  h.deployments.unshift(deployment(20, new Date().toISOString(), { payload: managedPayload, statuses: { nodes: [
    { id: "STATUS_20", state: "QUEUED", description: "accepted", createdAt: new Date().toISOString(), creator: { __typename: "Bot", databaseId: serverBotId } },
  ], pageInfo: { hasNextPage: false } } }));
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).resolves.toMatchObject({ deploymentId: 20 });
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(0);
});

test("rejects multiple existing managed reservations with the same idempotency key", async () => {
  const h = harness();
  for (const id of [20, 21]) h.deployments.unshift(deployment(id, new Date().toISOString(), { payload: managedPayload }));
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).rejects.toThrow("multiple managed-file reservations match the idempotency key");
  expect(h.restWrites).toHaveLength(0);
});

test("creates a new reservation when a same-key reservation is terminal", async () => {
  const h = harness();
  h.deployments.unshift(deployment(20, new Date().toISOString(), { payload: managedPayload, statuses: { nodes: [
    { id: "STATUS_20", state: "INACTIVE", description: "cancelled", createdAt: new Date().toISOString(), creator: { __typename: "Bot", databaseId: serverBotId } },
  ], pageInfo: { hasNextPage: false } } }));
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).resolves.toMatchObject({ deploymentId: 10 });
  expect(h.restWrites.filter((write) => write.path === "/repos/owner/server/deployments")).toHaveLength(1);
});

test("active human or bot reservation takes precedence over a same-key managed replay", async () => {
  const h = harness();
  h.deployments.unshift(
    deployment(20, new Date().toISOString(), { payload: managedPayload, statuses: { nodes: [
      { id: "STATUS_20", state: "QUEUED", description: "accepted", createdAt: new Date().toISOString(), creator: { __typename: "Bot", databaseId: serverBotId } },
    ], pageInfo: { hasNextPage: false } } }),
    deployment(21, new Date().toISOString(), { payload, statuses: { nodes: [], pageInfo: { hasNextPage: false } } }),
  );
  await expect(createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" })).rejects.toThrow("already has an active human or bot merge reservation");
  expect(h.restWrites).toHaveLength(0);
});

test("invalidates an older active managed reservation before creating a new revision", async () => {
  const h = harness();
  const stalePayload = { ...managedPayload, idempotency_key: "f".repeat(64), configuration_sha: "f".repeat(40) };
  h.deployments.unshift(deployment(20, new Date().toISOString(), { payload: stalePayload }));
  await createManagedReservation({ server: h.server, serverRepository, defaultBranch: "main", serverBotId, payload: managedPayload, serverRunUrl: "https://github.com/owner/server/actions/runs/2", pullUrl: "https://github.com/owner/client/pull/12" });
  expect(h.restWrites[0]).toMatchObject({
    path: "/repos/owner/server/deployments/20/statuses",
    body: { state: "inactive", description: "csm-ci:automerge:reason=invalidated| managed-file provenance changed" },
  });
  expect(h.restWrites[1]?.path).toBe("/repos/owner/server/deployments");
});
