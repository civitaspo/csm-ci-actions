import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { fakeFetch } from "./testing.ts";
import { reconcileAutomergeDisplay } from "./automerge-display.ts";
import { type ReservationRecord } from "./automerge-github.ts";

const sha = "a".repeat(40);
const old = "b".repeat(40);
const payload: ReservationRecord["payload"] = { version: 1, repository_id: 42, repository: "owner/client", pull_number: 12, pull_node_id: "PR_12", base_ref: "main", merger: { id: 5, login: "operator", type: "User" }, mode: "human", command_comment_id: 90, accepted_head: sha, accepted_at: "2026-10-29T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z" };
const record: ReservationRecord = { deploymentId: 77, nodeId: "D_77", createdAt: payload.accepted_at, payload, statuses: [], state: { kind: "active" } };
const correlation = { server_repository: "owner/server", reservation_deployment_id: 77 };
const serverRun = "https://github.com/owner/server/actions/runs/1";

function deployment(id: number, ref: string, creator = 3000, data: unknown = correlation) {
  return { id, sha: ref, task: "csm-ci:automerge-display", environment: "csm-ci-automerge-display", payload: data, creator: { id: creator, type: "Bot" } };
}

function harness(options: { deployments: unknown[]; deploymentsThen?: unknown[][]; createStatus?: number; statusError?: number; statusThen?: unknown[][]; terminal?: string; terminalThen?: string[]; pullId?: number; pullNodeId?: string }) {
  const response = (state?: string) => {
    const status = state ? [{ id: "S_1", state, description: "csm-ci:automerge:reason=cancelled| cancelled", createdAt: "2026-10-29T00:00:01.000Z", creator: { __typename: "Bot", databaseId: 3000 } }] : [];
    return { data: { repository: { deployments: { nodes: [{ id: "D_77", databaseId: 77, task: "csm-ci:automerge", payload, createdAt: payload.accepted_at, creator: { __typename: "Bot", databaseId: 3000 }, statuses: { nodes: status, pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
  };
  const server = fakeFetch([{ method: "POST", path: "/graphql", body: response(options.terminal), ...(options.terminalThen ? { then: options.terminalThen.map((state) => response(state)) } : {}) }]);
  const reader = fakeFetch([{ method: "GET", path: "/repos/owner/client/pulls/12", body: { node_id: options.pullNodeId ?? "PR_12", head: { sha }, base: { repo: { id: options.pullId ?? 42 } } } }]);
  const all = [...options.deployments, ...(options.deploymentsThen?.flat() ?? [])];
  const routes = [{ method: "GET", path: "/repos/owner/client/deployments", body: options.deployments, ...(options.deploymentsThen ? { then: options.deploymentsThen } : {}) }, { method: "POST", path: "/repos/owner/client/deployments", status: options.createStatus ?? 201, body: options.createStatus ? { message: "timeout" } : { id: 2 } }, ...all.flatMap((value) => {
    if (typeof value !== "object" || value === null || !("id" in value)) return [];
    return [{ method: "GET", path: `/repos/owner/client/deployments/${value.id}/statuses`, body: [], ...(options.statusThen ? { then: options.statusThen } : {}) }, { method: "POST", path: `/repos/owner/client/deployments/${value.id}/statuses`, status: options.statusError ?? 201, body: options.statusError ? { message: "timeout" } : { id: 10 } }];
  })];
  const client = fakeFetch(routes);
  return { args: { server: github("server", server), reader: github("reader", reader), client: github("display", client), serverRepository: "owner/server", repository: "owner/client", serverBotId: 3000, record, runUrl: serverRun, now: new Date("2026-10-30T00:00:00.000Z") }, client };
}

test("updates only correlated Server Bot displays and inactivates duplicates and old heads", async () => {
  const h = harness({ deployments: [deployment(3, sha), deployment(2, sha), deployment(4, old), deployment(5, sha, 99), deployment(6, sha, 3000, { ...correlation, reservation_deployment_id: 88 }), deployment(7, sha, 3000, { ...correlation, server_repository: "owner/other" }), { ...deployment(8, sha), task: "other" }, { ...deployment(9, sha), environment: "other" }, { ...deployment(10, sha), creator: { id: 3000, type: "User" } }] });
  expect(await reconcileAutomergeDisplay(h.args)).toBe(2);
  const writes = h.client.requests.filter((request) => request.method === "POST");
  expect(writes.map((write) => write.path)).toEqual(["/repos/owner/client/deployments/2/statuses", "/repos/owner/client/deployments/3/statuses", "/repos/owner/client/deployments/4/statuses"]);
  expect(writes.map((write) => JSON.parse(write.body ?? "{}").state)).toEqual(["queued", "inactive", "inactive"]);
  expect(writes.every((write) => JSON.parse(write.body ?? "{}").auto_inactive === false)).toBe(true);
});

test("creates a display deployment for the validated current head", async () => {
  const h = harness({ deployments: [], deploymentsThen: [[deployment(2, sha)]] });
  expect(await reconcileAutomergeDisplay(h.args)).toBe(2);
  const create = h.client.requests.find((request) => request.path === "/repos/owner/client/deployments" && request.method === "POST");
  expect(JSON.parse(create?.body ?? "{}")).toMatchObject({ ref: sha, environment: "csm-ci-automerge-display", task: "csm-ci:automerge-display", payload: correlation });
});

test("reconstructs a missing terminal display during repair", async () => {
  const h = harness({ deployments: [], deploymentsThen: [[deployment(2, sha)]], terminal: "INACTIVE" });
  expect(await reconcileAutomergeDisplay(h.args)).toBe(2);
  const status = h.client.requests.find((request) => request.path.endsWith("/2/statuses") && request.method === "POST");
  expect(JSON.parse(status?.body ?? "{}").state).toBe("inactive");
});

test("reports failure if a created display is not visible for reconciliation", async () => {
  const h = harness({ deployments: [] });
  await expect(reconcileAutomergeDisplay(h.args)).rejects.toThrow("created client display is not yet observable");
});

test("recovers an ambiguous deployment creation from the correlated Server Bot record", async () => {
  const h = harness({ deployments: [], deploymentsThen: [[deployment(2, sha)]], createStatus: 503 });
  expect(await reconcileAutomergeDisplay(h.args)).toBe(2);
  expect(h.client.calls.filter((call) => call === "POST /repos/owner/client/deployments")).toHaveLength(1);
});

test("recovers an ambiguous status write only from the latest trusted status", async () => {
  const status = { id: 10, state: "queued", log_url: serverRun, environment_url: serverRun, creator: { id: 3000, type: "Bot" } };
  const h = harness({ deployments: [deployment(2, sha)], statusError: 503, statusThen: [[status]] });
  await expect(reconcileAutomergeDisplay(h.args)).resolves.toBe(2);
  expect(h.client.calls.filter((call) => call === "POST /repos/owner/client/deployments/2/statuses")).toHaveLength(1);
});

test("does not recover an ambiguous status write from an untrusted status", async () => {
  const status = { id: 10, state: "queued", log_url: serverRun, environment_url: serverRun, creator: { id: 9, type: "Bot" } };
  const h = harness({ deployments: [deployment(2, sha)], statusError: 503, statusThen: [[status]] });
  await expect(reconcileAutomergeDisplay(h.args)).rejects.toThrow("timeout");
});

test.each([["SUCCESS", "success"], ["INACTIVE", "inactive"], ["FAILURE", "inactive"]])("maps server %s to client %s", async (terminal, expected) => {
  const h = harness({ deployments: [deployment(2, sha)], terminal });
  await reconcileAutomergeDisplay(h.args);
  const write = h.client.requests.find((request) => request.method === "POST");
  expect(JSON.parse(write?.body ?? "{}").state).toBe(expected);
});

test("maps a trusted server error to a client error", async () => {
  const h = harness({ deployments: [deployment(2, sha)], terminal: "ERROR" });
  await reconcileAutomergeDisplay(h.args);
  const write = h.client.requests.find((request) => request.method === "POST");
  expect(JSON.parse(write?.body ?? "{}").state).toBe("error");
});

test("rereads the server state before writing so cancellation is not displayed as queued", async () => {
  const h = harness({ deployments: [deployment(2, sha)], terminalThen: ["INACTIVE"] });
  await reconcileAutomergeDisplay(h.args);
  const write = h.client.requests.find((request) => request.method === "POST");
  expect(JSON.parse(write?.body ?? "{}").state).toBe("inactive");
});

test("does not write a display for a changed immutable repository identity", async () => {
  const h = harness({ deployments: [deployment(2, sha)], pullId: 999 });
  await expect(reconcileAutomergeDisplay(h.args)).rejects.toThrow("display pull request identity changed");
  expect(h.client.requests).toHaveLength(0);
});

test("does not write a display for a changed immutable pull request identity", async () => {
  const h = harness({ deployments: [deployment(2, sha)], pullNodeId: "PR_other" });
  await expect(reconcileAutomergeDisplay(h.args)).rejects.toThrow("display pull request identity changed");
  expect(h.client.requests).toHaveLength(0);
});
