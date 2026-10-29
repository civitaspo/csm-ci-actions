import { describe, expect, test } from "bun:test";
import {
  AUTOMERGE_LABEL,
  ReservationPayloadSchema,
  automergeMarker,
  canCancelReservation,
  decide,
  reservationState,
  terminalDescription,
  truncateDeploymentDescription,
} from "./automerge.ts";
import type { DeploymentStatus, ReservationPayload, ReservationState, TerminalState } from "./automerge.ts";

const acceptedAt = "2026-01-01T00:00:00.000Z";
const payload: ReservationPayload = {
  version: 1,
  repository_id: 123,
  repository: "owner/repo",
  pull_number: 7,
  pull_node_id: "PR_kwDOAA",
  base_ref: "main",
  merger: { id: 42, login: "renovate[bot]", type: "Bot" },
  mode: "bot",
  command_comment_id: 99,
  accepted_head: "a".repeat(40),
  accepted_at: acceptedAt,
  expires_at: "2026-01-08T00:00:00.000Z",
};

function status(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    id: 1,
    state: "queued",
    description: "waiting for approval",
    createdAt: acceptedAt,
    creator: { type: "Bot", databaseId: 10 },
    ...overrides,
  };
}

function facts(overrides: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] {
  return {
    reservation: { state: { kind: "active" }, payload },
    pull: { state: "open", merged: false, draft: false, headSha: "b".repeat(40), baseRef: "main" },
    now: new Date("2026-01-02T00:00:00.000Z"),
    trustValid: true,
    mergeEnabled: true,
    allowBotRequests: true,
    botCommitsValid: true,
    readiness: { kind: "ready" },
    ...overrides,
  };
}

describe("reservation payload", () => {
  test.each([
    ["unknown key", { ...payload, extra: true }, "Unrecognized key: \"extra\""],
    ["wrong version", { ...payload, version: 2 }, "Invalid input: expected 1"],
    ["invalid repository id", { ...payload, repository_id: 0 }, "Too small: expected number to be >0"],
    ["non-integer command comment id", { ...payload, command_comment_id: 99.5 }, "Invalid input: expected int, received number"],
    ["non-positive command comment id", { ...payload, command_comment_id: 0 }, "Too small: expected number to be >0"],
    ["invalid owner/name", { ...payload, repository: "repo" }, "Invalid string: must match pattern /^[^/]+\\/[^/]+$/"],
    ["non-SHA accepted head", { ...payload, accepted_head: "abc1234" }, "Invalid string: must match pattern /^[0-9a-f]{40}$/"],
    ["expiry not seven days later", { ...payload, expires_at: "2026-01-09T00:00:00.000Z" }, "expires_at must be exactly seven days after accepted_at"],
    ["wrong merger type", { ...payload, merger: { ...payload.merger, type: "App" } }, "Invalid option: expected one of \"User\"|\"Bot\""],
    ["non-integer merger id", { ...payload, merger: { ...payload.merger, id: 42.5 } }, "Invalid input: expected int, received number"],
    ["non-positive merger id", { ...payload, merger: { ...payload.merger, id: 0 } }, "Too small: expected number to be >0"],
    ["empty merger login", { ...payload, merger: { ...payload.merger, login: "" } }, "Too small: expected string to have >=1 characters"],
    ["invalid mode", { ...payload, mode: "service" }, "Invalid option: expected one of \"human\"|\"bot\""],
    ["invalid accepted timestamp", { ...payload, accepted_at: "not a timestamp" }, "Invalid ISO datetime"],
    ["invalid expiry timestamp", { ...payload, expires_at: "not a timestamp" }, "Invalid ISO datetime"],
    ["mode disagrees with merger type", { ...payload, mode: "human" }, "mode must match the merger type"],
  ])("rejects %s with the expected message", (_name, value, message) => {
    const result = ReservationPayloadSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(message);
  });

  test("accepts the complete version 1 payload", () => {
    expect(ReservationPayloadSchema.parse(payload)).toEqual(payload);
  });
});

describe("reservation state", () => {
  test("uses the latest server queued reason and ignores other authors", () => {
    const state = reservationState({
      serverBotId: 10,
      statuses: [
        status({ description: "waiting for approval" }),
        status({ id: 2, createdAt: "2026-01-02T00:00:00.000Z", description: "waiting for checks" }),
        status({ id: 3, state: "failure", createdAt: "2026-01-03T00:00:00.000Z", creator: { type: "Bot", databaseId: 11 } }),
      ],
    });
    expect(state).toEqual({ kind: "active", waitingReason: "waiting for checks" });
  });

  test("error does not end a reservation", () => {
    expect(reservationState({ serverBotId: 10, statuses: [status({ state: "error" })] })).toEqual({ kind: "active" });
  });

  test("the earliest terminal status wins and ties use the smaller id", () => {
    const terminal = reservationState({
      serverBotId: 10,
      statuses: [
        status({ id: 8, state: "failure", createdAt: "2026-01-03T00:00:00.000Z", description: "later" }),
        status({ id: 9, state: "success", createdAt: "2026-01-02T00:00:00.000Z", description: "earlier" }),
        status({ id: 4, state: "inactive", createdAt: "2026-01-02T00:00:00.000Z", description: "tie wins" }),
      ],
    });
    expect(terminal).toEqual({ kind: "terminal", state: "inactive", at: "2026-01-02T00:00:00.000Z", description: "tie wins", reason: "other" });
  });

  test.each<TerminalState>(["success", "failure", "inactive"])("recognizes %s as terminal", (state) => {
    expect(reservationState({ serverBotId: 10, statuses: [status({ state })] }).kind).toBe("terminal");
  });
});

describe("reservation decisions", () => {
  const terminalCases: Array<[string, Parameters<typeof decide>[0], string, ReservationState["kind"]]> = [
    ["merged pull request", facts({ pull: { ...facts().pull, merged: true } }), "merged outside csm-ci", "terminal"],
    ["closed pull request", facts({ pull: { ...facts().pull, state: "closed" } }), "pull request closed", "terminal"],
    ["expiry at the boundary", facts({ now: new Date(payload.expires_at) }), "expired", "terminal"],
    ["revoked merger trust", facts({ trustValid: false }), "merger is no longer trusted", "terminal"],
    ["disabled merge", facts({ mergeEnabled: false }), "merge is disabled", "terminal"],
    ["disabled bot requests", facts({ allowBotRequests: false }), "bot merge requests are disabled", "terminal"],
    ["changed base branch", facts({ pull: { ...facts().pull, baseRef: "release" } }), "base branch changed", "terminal"],
    ["untrusted bot commit", facts({ botCommitsValid: false }), `a commit is not authored by ${payload.merger.login}`, "terminal"],
  ];

  test.each(terminalCases)("terminal rule: %s", (_name, input, description) => {
    expect(decide(input)).toMatchObject({ kind: "terminal", description });
  });

  test("a draft waits before readiness", () => {
    expect(decide(facts({ pull: { ...facts().pull, draft: true }, readiness: { kind: "waiting", reason: "approval" } }))).toEqual({ kind: "wait", reason: "draft" });
  });

  test("an unmet readiness condition waits with its reason", () => {
    expect(decide(facts({ readiness: { kind: "waiting", reason: "waiting for check status-check" } }))).toEqual({ kind: "wait", reason: "waiting for check status-check" });
  });

  test("a ready reservation merges the current head", () => {
    expect(decide(facts())).toEqual({ kind: "merge", head: "b".repeat(40) });
  });

  test.each([
    ["merged outside csm-ci", "success", "none"],
    ["pull request closed", "inactive", "none"],
    ["rejected", "failure", "complete"],
  ] as const)("retains an existing terminal status (%s) without repeating skipped comments", (description, stateName, comment) => {
    const reason = description === "merged outside csm-ci" ? "external-merge" : description === "pull request closed" ? "closed" : "other";
    const state: ReservationState = { kind: "terminal", state: stateName, at: acceptedAt, description, reason };
    expect(decide(facts({ reservation: { state, payload }, pull: { ...facts().pull, merged: true } }))).toEqual({ kind: "terminal", state: stateName, reason, description, comment });
  });

  test("terminal comment policy follows typed reason, not display text", () => {
    const state: ReservationState = { kind: "terminal", state: "success", at: acceptedAt, description: "renamed display text", reason: "external-merge" };
    expect(decide(facts({ reservation: { state, payload } }))).toMatchObject({ kind: "terminal", reason: "external-merge", comment: "none" });
  });

  test("durable terminal reason is encoded independently of display wording", () => {
    const description = terminalDescription("external-merge", "wording can change");
    const state = reservationState({ serverBotId: 10, statuses: [status({ state: "success", description })] });
    expect(state).toMatchObject({ kind: "terminal", reason: "external-merge", description });
    expect(decide(facts({ reservation: { state, payload } }))).toMatchObject({ kind: "terminal", comment: "none" });
  });

  test("unknown durable terminal reason fails closed to a commented result", () => {
    const state = reservationState({ serverBotId: 10, statuses: [status({ state: "success", description: "csm-ci:automerge:reason=future-code| text" })] });
    expect(state).toMatchObject({ kind: "terminal", reason: "other" });
    expect(decide(facts({ reservation: { state, payload } }))).toMatchObject({ kind: "terminal", comment: "complete" });
  });
});

describe("cancellation and presentation", () => {
  test("the original requester or any current trusted merger can cancel", () => {
    expect(canCancelReservation({ commenterId: 42, trustedMergerIds: [7], reservationMergerId: 42 })).toBe(true);
    expect(canCancelReservation({ commenterId: 7, trustedMergerIds: [7], reservationMergerId: 42 })).toBe(true);
  });

  test("an unrelated user cannot cancel", () => {
    expect(canCancelReservation({ commenterId: 8, trustedMergerIds: [7], reservationMergerId: 42 })).toBe(false);
  });

  test("uses the stable label and a deployment-specific event marker", () => {
    expect(AUTOMERGE_LABEL).toBe("csm-ci/automerge");
    expect(automergeMarker(123, "accepted")).toBe("<!-- csm-ci:automerge:123:accepted -->");
  });

  test("truncates descriptions at 140 Unicode code points", () => {
    const result = truncateDeploymentDescription("é".repeat(141));
    expect(Array.from(result)).toHaveLength(140);
    expect(result.endsWith("…")).toBe(true);
  });
});
