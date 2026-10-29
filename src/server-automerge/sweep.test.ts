import { expect, test } from "bun:test";
import type { ReservationRecord } from "../lib/automerge-github.ts";
import { activeReservationForPullByRepositoryId, activeSweepReservations, evaluationReservation, installedRepositoryId, partitionSweepRepositories, resolveRepositoryName, sweepBatch } from "./sweep.ts";

function reservation(deploymentId: number, pullNumber: number, state: ReservationRecord["state"]): ReservationRecord {
  return {
    deploymentId,
    nodeId: `DEP_${deploymentId}`,
    createdAt: new Date(deploymentId).toISOString(),
    payload: {
      version: 1,
      repository_id: 4000,
      repository: "owner/client",
      pull_number: pullNumber,
      pull_node_id: `PR_${pullNumber}`,
      base_ref: "main",
      merger: { id: 5000, login: "operator", type: "User" },
      mode: "human",
      command_comment_id: deploymentId,
      accepted_head: "a".repeat(40),
      accepted_at: "2026-10-29T00:00:00.000Z",
      expires_at: "2026-11-05T00:00:00.000Z",
    },
    statuses: [],
    state,
  };
}

test("sweep selects only the newest active reservation for each pull request", () => {
  const records = [
    reservation(6, 12, { kind: "terminal", state: "failure", at: "2026-10-29T00:00:00.000Z", description: "rejected", reason: "rejected" }),
    reservation(5, 10, { kind: "active" }),
    reservation(4, 11, { kind: "terminal", state: "success", at: "2026-10-29T00:00:00.000Z", description: "merged", reason: "merged" }),
    reservation(3, 10, { kind: "active" }),
    reservation(2, 12, { kind: "active" }),
  ];

  expect(activeSweepReservations(records).map(({ deploymentId }) => deploymentId)).toEqual([2, 5]);
});

test("sweep batch caps active reservations at 256 after terminal records are filtered", () => {
  const records = [
    ...Array.from({ length: 256 }, (_, index) => reservation(1000 - index, index + 1, { kind: "terminal", state: "success", at: "2026-10-29T00:00:00.000Z", description: "merged", reason: "merged" })),
    ...Array.from({ length: 260 }, (_, index) => reservation(2000 - index, 1000 + index, { kind: "active" })),
  ];

  const batch = sweepBatch(activeSweepReservations(records));
  expect(batch).toHaveLength(256);
  expect(batch.every(({ state }) => state.kind === "active")).toBe(true);
});

test("unresolved repositories are skipped until expiration, then isolated for server-side expiry", () => {
  const installed = reservation(1, 12, { kind: "active" });
  const unresolved = { ...reservation(2, 13, { kind: "active" }), payload: { ...reservation(2, 13, { kind: "active" }).payload, repository_id: 9000 } };
  const expired = { ...reservation(3, 14, { kind: "active" }), payload: { ...reservation(3, 14, { kind: "active" }).payload, repository_id: 9001, expires_at: "2026-10-29T00:00:00.000Z" } };
  const partition = partitionSweepRepositories([installed, unresolved, expired], new Map([[4000, "renamed/client"]]), new Date("2026-10-29T00:00:00.000Z"));

  expect(partition.ready.map(({ record }) => record.deploymentId)).toEqual([1, 2]);
  expect(partition.unavailable.map(({ deploymentId }) => deploymentId)).toEqual([2]);
  expect(partition.expire.map(({ deploymentId }) => deploymentId)).toEqual([3]);
});

test("no-ID error lookup resolves renamed repositories by current name then immutable ID", () => {
  const renamed = { ...reservation(7, 12, { kind: "active" }), payload: { ...reservation(7, 12, { kind: "active" }).payload, repository: "old/client" } };
  const otherRepository = { ...reservation(6, 12, { kind: "active" }), payload: { ...reservation(6, 12, { kind: "active" }).payload, repository_id: 9000 } };
  const repositoryId = installedRepositoryId([{ id: 4000, full_name: "Owner/Client" }], "owner/client");

  expect(repositoryId).toBe(4000);
  expect(activeReservationForPullByRepositoryId([otherRepository, renamed], repositoryId!, 12)?.deploymentId).toBe(7);
  expect(activeReservationForPullByRepositoryId([renamed], repositoryId!, 13)).toBeUndefined();
});

test("resolution passes through event repository names without a deployment ID", () => {
  expect(resolveRepositoryName({ deploymentId: "", repository: "Owner/Current", repositories: [] })).toBe("owner/current");
});

test("event evaluation selects the newest terminal reservation when no active reservation remains", () => {
  const terminal = reservation(5, 12, { kind: "terminal", state: "success", at: "2026-10-29T00:00:00.000Z", description: "merged", reason: "merged" });
  const older = reservation(4, 12, { kind: "active" });

  expect(evaluationReservation([terminal, older], "")).toBe(terminal);
});

test("scheduled resolution finds a renamed repository by immutable ID and safely misses an owner transfer", () => {
  const repositories = [{ id: 9000, full_name: "OtherOwner/OtherRepo" }, { id: 4000, full_name: "NewOwner/Renamed" }];
  expect(resolveRepositoryName({ deploymentId: "10", repository: "OldOwner/Original", repositoryId: 4000, repositories })).toBe("NewOwner/Renamed");
  expect(resolveRepositoryName({ deploymentId: "10", repository: "OldOwner/Original", repositoryId: 4000, repositories: [] })).toBeUndefined();
});
