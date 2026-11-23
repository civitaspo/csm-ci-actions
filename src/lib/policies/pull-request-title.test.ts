import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config.ts";
import { CONFIG_YAML } from "../testing.ts";
import type { PolicyContext } from "./index.ts";
import { pullRequestTitle } from "./pull-request-title.ts";

const TYPES = ["feat", "fix", "docs", "refactor", "test", "ci", "build", "chore", "perf", "revert"];
const policy = { type: "pull-request-title" as const, types: TYPES };
const expected = (title: string) => `title ${JSON.stringify(title)} is not a Conventional Commit header; edit it to <type>[(<scope>)][!]: <subject> with type one of ${TYPES.join(", ")}`;
const evaluate = (title: string) => pullRequestTitle(policy, { title } as PolicyContext);

describe("pull-request-title", () => {
  test.each([
    "refactor: name the registration check after skipped files",
    "chore(release): v0.1.0",
    "feat!: drop the old option",
    "chore(deps): update dependency bun to v1.4.5",
    "chore(repo-settings): sync managed files",
    "fix(ci)!: x",
    "feat: add a change (#12)",
  ])("passes %s", (title) => {
    expect(evaluate(title)).toEqual([]);
  });

  test.each([
    "Name test directories by scope",
    "feat:missing space",
    "fix(ci) : extra space",
    "feature: unknown type",
    "feat(Policy): uppercase scope",
    "Revert \"feat: x\"",
    "Bump x from 1.0.0 to 1.1.0",
    "feat:  ",
    "feat: ",
    " feat: leading space",
    "Feat: capitalized type",
    "feat(): empty scope",
    "feat!(ci): bang before scope",
    "[e2e][merge] feat: prefixed",
    "xfeat: prefix of a type",
  ])("rejects %s with the expected form", (title) => {
    expect(evaluate(title)).toEqual([expected(title)]);
  });

  test("lists only the configured types", () => {
    expect(pullRequestTitle({ type: "pull-request-title", types: ["chore"] }, { title: "feat: x" } as PolicyContext))
      .toEqual(["title \"feat: x\" is not a Conventional Commit header; edit it to <type>[(<scope>)][!]: <subject> with type one of chore"]);
  });
});

describe("pull-request-title configuration", () => {
  const withPolicy = (entry: string) => CONFIG_YAML.replace("  - { type: trusted-committers }\n", `  - { type: trusted-committers }\n${entry}\n`);

  test("parses a configured policy", () => {
    expect(parseConfig(withPolicy("  - { type: pull-request-title, types: [feat, chore] }")).policies)
      .toContainEqual({ type: "pull-request-title", types: ["feat", "chore"] });
  });

  test.each([
    ["missing types", "  - { type: pull-request-title }", "types"],
    ["empty types", "  - { type: pull-request-title, types: [] }", "Too small"],
    ["a type outside ^[a-z]+$", "  - { type: pull-request-title, types: [chore, feat-x] }", "must match ^[a-z]+$"],
    ["an uppercase type", "  - { type: pull-request-title, types: [chore, Feat] }", "must match ^[a-z]+$"],
    ["a duplicate type", "  - { type: pull-request-title, types: [chore, feat, feat] }", "duplicate type"],
    ["types without chore", "  - { type: pull-request-title, types: [feat, fix] }", "must include chore, which csm-ci's own pull requests use"],
    ["an unknown key", "  - { type: pull-request-title, types: [chore], scopes: [ci] }", "scopes"],
    ["a second entry", "  - { type: pull-request-title, types: [chore] }\n  - { type: pull-request-title, types: [chore, feat] }", "at most one pull-request-title policy"],
  ])("rejects %s", (_name, entry, message) => {
    expect(() => parseConfig(withPolicy(entry))).toThrow(message);
  });

  test("rejects a repository override", () => {
    const yaml = withPolicy("  - { type: pull-request-title, types: [chore] }")
      .replace("{ name: owner/*, ops: [approve, merge, policy-check] }", "{ name: owner/*, ops: [approve, merge, policy-check], pull_request_title: { types: [chore] } }");
    expect(() => parseConfig(yaml)).toThrow("pull_request_title");
  });
});
