import { describe, expect, test } from "bun:test";
import { parseCreatedRulesets, rulesetCleanupPlan } from "./repo-settings-ownership.ts";

describe("created repo-settings ruleset records", () => {
  test("collects validated records from prefixed workflow log lines", () => {
    const parsed = parseCreatedRulesets(
      "2026-10-25T00:00:00Z INFO created-repo-settings-ruleset {\"repository\":\"owner/repo\",\"id\":17,\"name\":\"integrity\"}",
      "owner/repo",
    );
    expect(parsed).toEqual({ rulesets: [{ repository: "owner/repo", id: 17, name: "integrity" }], errors: [] });
  });

  test("ignores a receipt marker embedded in unrelated log text", () => {
    const parsed = parseCreatedRulesets(
      `unrelated text created-repo-settings-ruleset {"repository":"owner/repo","id":17,"name":"integrity"}`,
      "owner/repo",
    );
    expect(parsed).toEqual({ rulesets: [], errors: [] });
  });

  test("keeps earlier IDs when a later record is malformed", () => {
    const parsed = parseCreatedRulesets(
      [
        "created-repo-settings-ruleset {\"repository\":\"owner/repo\",\"id\":17,\"name\":\"integrity\"}",
        "created-repo-settings-ruleset {broken}",
      ].join("\n"),
      "owner/repo",
    );
    expect(parsed.rulesets.map(({ id }) => id)).toEqual([17]);
    expect(parsed.errors).toEqual(["invalid created ruleset record in owner/repo"]);
  });

  test.each([
    ["malformed JSON", "{broken}", "invalid created ruleset record in owner/repo"],
    ["another repository", "{\"repository\":\"owner/other\",\"id\":17,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an invalid identifier", "{\"repository\":\"owner/repo\",\"id\":0,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an unsafe identifier", "{\"repository\":\"owner/repo\",\"id\":9007199254740992,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an empty name", "{\"repository\":\"owner/repo\",\"id\":17,\"name\":\"\"}", "created ruleset record does not match owner/repo"],
    ["a missing repository", "{\"id\":17,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
  ])("rejects records for %s", (_name, json, message) => {
    expect(parseCreatedRulesets("created-repo-settings-ruleset " + json, "owner/repo").errors).toEqual([message]);
  });

  test("reports malformed JSON receipt lines", () => {
    expect(parseCreatedRulesets("created-repo-settings-ruleset {broken}", "owner/repo").errors)
      .toEqual(["invalid created ruleset record in owner/repo"]);
  });
});

describe("ruleset restoration ownership", () => {
  test.each([19, 20])("deletes only run-created IDs and explains refusing unknown ruleset %s", (unknownId) => {
    expect(rulesetCleanupPlan(
      [{ id: 2 }, { id: 17 }, { id: 18 }, { id: unknownId }],
      new Set([2]),
      new Set([17, 18]),
    )).toEqual({ deleteIds: [17, 18], errors: [`ruleset ${unknownId} was not created by this e2e run; refusing deletion`] });
  });
});
