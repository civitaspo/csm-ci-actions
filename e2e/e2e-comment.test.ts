import { describe, expect, test } from "bun:test";
import { FEATURES } from "./pr-metadata.ts";
import { cancellationDescription, cancellationLabel, chooseHarness, parseCommand, selectCancellationCandidate, validateCancellationTarget, type CancellationTarget, type Command } from "./e2e-comment.ts";

describe("parseCommand", () => {
  test.each<[string, Command]>([
    ["/e2e --feature smoke", { features: ["smoke"], scenario: "" }],
    ["/e2e --feature merge,smoke,merge\n", { features: ["merge", "smoke"], scenario: "" }],
    ["/e2e --feature merge --scenario a head change while /merge waits  ", { features: ["merge"], scenario: "a head change while /merge waits" }],
  ])("accepts %j", (body, command) => {
    expect(parseCommand(body)).toEqual({ ok: true, command });
  });

  test("accepts a safe-stop command with a positive run ID", () => {
    expect(parseCommand("/e2e --cancel 40896049487")).toEqual({ ok: true, cancelRunId: 40896049487 });
  });

  test("accepts automatic selection when the run ID is omitted", () => {
    expect(parseCommand("/e2e --cancel")).toEqual({ ok: true });
  });

  const syntax = "the comment must be exactly `/e2e --feature <feature>[,<feature>...] [--scenario <name substring>] or /e2e --cancel [<run-id>]`.";
  test.each([
    ["/e2e merge", syntax],
    ["/e2e", syntax],
    ["/e2e --feature", syntax],
    ["/e2e --feature merge --scenario", syntax],
    ["/e2e --feature merge\nsecond line", syntax],
    ["/e2e --feature merge --scenario x\ny", syntax],
    ["/e2e --cancel 0", syntax],
    ["/e2e --cancel 001", syntax],
    ["/e2e --cancel 123 --scenario foo", syntax],
    ["/e2e --cancel 9007199254740992", "the run ID must be a positive safe integer."],
    ["/e2e --feature Merge", syntax],
    [`/e2e --feature merge --scenario ${"x".repeat(201)}`, syntax],
    ["/e2e --feature nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
    ["/e2e --feature merge,nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
  ])("rejects %j", (body, error) => {
    expect(parseCommand(body)).toEqual({ ok: false, error });
  });
});

describe("validateCancellationTarget", () => {
  const run: CancellationTarget = {
    id: 40896049487,
    run_attempt: 2,
    event: "issue_comment",
    path: ".github/workflows/e2e-comment.yml",
    workflow_id: 399033070,
    status: "in_progress",
    repository: { full_name: "civitaspo/csm-ci-actions" },
  };
  const input = {
    run,
    jobs: [{ name: "authorize", status: "completed" }, { name: "e2e", status: "queued" }],
    expectedRunId: run.id,
    expectedWorkflowId: run.workflow_id,
    repository: "civitaspo/csm-ci-actions",
    prNumber: 200,
    comments: [{ user: { id: 41898282 }, body: `e2e started for \`smoke\`. Run: https://github.com/civitaspo/csm-ci-actions/actions/runs/${run.id}` }],
    serverUrl: "https://github.com",
  };

  test("accepts an active run with its start receipt on this PR", () => {
    expect(validateCancellationTarget(input)).toBeUndefined();
  });

  test.each(["queued", "pending", "waiting", "in_progress"])("accepts an e2e job with status %s", (status) => {
    expect(validateCancellationTarget({ ...input, run: { ...run, status }, jobs: [{ name: "e2e", status }] })).toBeUndefined();
  });

  test.each([
    ["different run ID", { ...input, expectedRunId: run.id + 1 }, "the run ID does not match the requested run."],
    ["wrong event", { ...input, run: { ...run, event: "workflow_dispatch" } }, "the run is not an e2e-comment workflow run."],
    ["wrong workflow path", { ...input, run: { ...run, path: ".github/workflows/e2e.yml" } }, "the run is not an e2e-comment workflow run."],
    ["wrong workflow ID", { ...input, expectedWorkflowId: 1 }, "the run is not an e2e-comment workflow run."],
    ["different repository", { ...input, run: { ...run, repository: { full_name: "elsewhere/repo" } } }, "the run belongs to a different repository."],
    ["completed workflow", { ...input, run: { ...run, status: "completed" } }, "the run is no longer active."],
    ["completed e2e job", { ...input, jobs: [{ name: "e2e", status: "completed" }] }, "the e2e job is no longer active."],
    ["missing e2e job", { ...input, jobs: [{ name: "authorize", status: "in_progress" }] }, "the e2e job is no longer active."],
    ["start receipt from another author", { ...input, comments: [{ user: { id: 123 }, body: input.comments[0]!.body }] }, `no e2e start receipt for run ${run.id} exists on this pull request.`],
    ["start receipt for another run", { ...input, comments: [{ user: { id: 41898282 }, body: "e2e started for `smoke`. Run: https://github.com/civitaspo/csm-ci-actions/actions/runs/1" }] }, `no e2e start receipt for run ${run.id} exists on this pull request.`],
    ["start receipt for a run with a longer ID", { ...input, comments: [{ user: { id: 41898282 }, body: `${input.comments[0]!.body}1` }] }, `no e2e start receipt for run ${run.id} exists on this pull request.`],
  ] as const)("rejects %s", (_name, args, error) => {
    expect(validateCancellationTarget(args)).toBe(error);
  });
});

describe("cancellation marker", () => {
  test("uses a run-scoped label and idempotent PR/attempt metadata", () => {
    expect(cancellationLabel(40896049487, 2)).toBe("e2e-cancel-40896049487-2");
    expect(cancellationLabel(40896049487, 1)).not.toBe(cancellationLabel(40896049487, 2));
    expect(cancellationDescription(200, 2)).toBe("pr=200;attempt=2");
  });
});

describe("selectCancellationCandidate", () => {
  test("selects the sole active run and ignores finished runs", () => {
    expect(selectCancellationCandidate([
      { runId: 10, status: "finished" },
      { runId: 11, attempt: 2, status: "active" },
    ])).toEqual({ ok: true, candidate: { runId: 11, attempt: 2, status: "active" } });
  });

  test("uses the latest active attempt for a rerun", () => {
    expect(selectCancellationCandidate([{ runId: 11, attempt: 3, status: "active" }], 11)).toEqual({
      ok: true,
      candidate: { runId: 11, attempt: 3, status: "active" },
    });
  });

  test.each([
    ["no active run", [{ runId: 10, status: "finished" }], undefined, "no active e2e run with a trusted start receipt was found on this pull request."],
    ["ambiguous active runs", [{ runId: 10, status: "active" }, { runId: 11, status: "active" }], undefined, "found 2 active e2e runs; specify a run ID to choose one."],
    ["unverifiable run", [{ runId: 10, status: "unverified" }, { runId: 11, status: "active" }], undefined, "run 10 has an e2e start receipt but its active state could not be verified."],
    ["explicitly selected finished run", [{ runId: 10, status: "finished" }], 10, "run 10 is no longer active."],
  ] as const)("rejects %s", (_name, candidates, runId, error) => {
    expect(selectCancellationCandidate(candidates, runId)).toEqual({ ok: false, error });
  });
});

describe("chooseHarness", () => {
  const ok = { verified: true, authorId: 1 };
  const input = { repository: "o/r", headRepository: "o/r", commits: [ok, ok], ownerId: 1 };
  test.each([
    ["own verified commits on a branch of this repository", input, "pr"],
    ["a fork", { ...input, headRepository: "x/r" }, "main"],
    ["a deleted head repository", { ...input, headRepository: undefined }, "main"],
    ["an unverified commit", { ...input, commits: [ok, { verified: false, authorId: 1 }] }, "main"],
    ["another author", { ...input, commits: [ok, { verified: true, authorId: 2 }] }, "main"],
    ["an author without an account", { ...input, commits: [{ verified: true, authorId: undefined }] }, "main"],
    ["no commits", { ...input, commits: [] }, "main"],
  ] as const)("%s", (_name, args, harness) => {
    expect(chooseHarness(args)).toBe(harness);
  });
});
