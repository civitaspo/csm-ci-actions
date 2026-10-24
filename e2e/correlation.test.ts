import { expect, test } from "bun:test";
import { findRunByTitle, matchesAcceptedRequest, recentItems } from "./correlation.ts";
import type { RequestMatch } from "./harness.ts";

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

test("finds the matching run on a later workflow-run page", async () => {
  const since = new Date("2026-10-25T00:00:00Z");
  async function* pages() {
    yield Array.from({ length: 100 }, (_, index) => ({ created_at: "2026-10-25T00:02:00Z", id: index, log: "unrelated" }));
    yield [{ created_at: "2026-10-25T00:01:00Z", id: 101, log: `accepted policy-check for ${request.repository} {"pull_number":23,"comment_id":456}` }];
  }
  const runs = await recentItems(pages(), since);
  expect(runs.filter((run) => matchesAcceptedRequest(run.log, request)).map(({ id }) => id)).toEqual([101]);
});
