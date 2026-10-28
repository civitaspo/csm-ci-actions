import { describe, expect, test } from "bun:test";
import { FEATURES } from "./pr-metadata.ts";
import { chooseHarness, parseCommand, type Command } from "./e2e-comment.ts";

describe("parseCommand", () => {
  test.each<[string, Command]>([
    ["/e2e --feature smoke", { features: ["smoke"], scenario: "" }],
    ["/e2e --feature merge,smoke,merge\n", { features: ["merge", "smoke"], scenario: "" }],
    ["/e2e --feature merge --scenario a head change while /merge waits  ", { features: ["merge"], scenario: "a head change while /merge waits" }],
  ])("accepts %j", (body, command) => {
    expect(parseCommand(body)).toEqual({ ok: true, command });
  });

  const syntax = "the comment must be exactly `/e2e --feature <feature>[,<feature>...] [--scenario <name substring>]`.";
  test.each([
    ["/e2e merge", syntax],
    ["/e2e", syntax],
    ["/e2e --feature", syntax],
    ["/e2e --feature merge --scenario", syntax],
    ["/e2e --feature merge\nsecond line", syntax],
    ["/e2e --feature merge --scenario x\ny", syntax],
    ["/e2e --feature Merge", syntax],
    [`/e2e --feature merge --scenario ${"x".repeat(201)}`, syntax],
    ["/e2e --feature nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
    ["/e2e --feature merge,nope", `unknown feature \`nope\`. Known: ${FEATURES.join(", ")}.`],
  ])("rejects %j", (body, error) => {
    expect(parseCommand(body)).toEqual({ ok: false, error });
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
