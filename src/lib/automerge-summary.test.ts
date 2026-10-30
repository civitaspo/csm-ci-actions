import { expect, test } from "bun:test";
import { reservationSummary } from "./automerge-summary.ts";
import { type ReservationRecord } from "./automerge-github.ts";

test("identifies each reservation and escapes untrusted text", () => {
  const record: ReservationRecord = {
    deploymentId: 77, nodeId: "D_77", createdAt: "2026-10-29T00:00:00.000Z", statuses: [], state: { kind: "active" },
    payload: { version: 1, repository_id: 42, repository: "owner/client", pull_number: 12, pull_node_id: "PR_12", base_ref: "main", merger: { id: 5, login: "operator", type: "User" }, mode: "human", command_comment_id: 90, accepted_head: "a".repeat(40), accepted_at: "2026-10-29T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z" },
  };
  const result = reservationSummary({ record, serverRepository: "owner/server", serverUrl: "https://github.com", runUrl: "https://github.com/owner/server/actions/runs/1", state: "waiting <unsafe>", displayFailure: true }, new Date("2026-10-30T00:00:00.000Z"));
  expect(result).toContain('href="https://github.com/owner/client/pull/12"');
  expect(result).toContain('href="https://api.github.com/repos/owner/server/deployments/77">Deployment 77 (API JSON)');
  expect(result).toContain("waiting &lt;unsafe&gt; at 2026-10-30T00:00:00.000Z");
  expect(result).toContain("Display commit unavailable");
  expect(result).not.toContain("waiting <unsafe>");
  const other = reservationSummary({ record: { ...record, deploymentId: 78, payload: { ...record.payload, pull_number: 13 } }, serverRepository: "owner/server", serverUrl: "https://github.com", runUrl: "https://github.com/owner/server/actions/runs/1", state: "queued" }, new Date("2026-10-30T00:00:00.000Z"));
  expect(other).toContain("reservation 78");
  expect(other).toContain("owner/client#13");
  expect(other).not.toContain("Display commit unavailable");
});
