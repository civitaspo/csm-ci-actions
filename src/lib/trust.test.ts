import { describe, expect, test } from "bun:test";
import { evaluatePolicies } from "./policies/index.ts";
import { type CommitFacts, evaluateTrust, MAX_COMMITS } from "./trust.ts";
import { config, SERVER_BOT_ID } from "./testing.ts";

const alice = { id: 10, login: "alice" };
const mallory = { id: 66, login: "mallory" };
const webFlow = { id: 19864447, login: "web-flow" };
const validWeb = { committedViaWeb: true, signatureValid: true, signedByGitHub: true, authorLogin: "alice" };

function commit(sha: string, over: Partial<CommitFacts> = {}): CommitFacts {
  return { sha, verified: true, author: alice, committer: alice, ...over };
}

function problems(commits: CommitFacts[], head = commits.at(-1)?.sha ?? "h") {
  const trust = evaluateTrust(commits, head, config());
  return evaluatePolicies([{ type: "signed-commits" }, { type: "trusted-committers" }], { trust });
}

describe("evaluateTrust", () => {
  const trusted: [string, CommitFacts][] = [
    ["trusted committer, signed", commit("a")],
    ["no GitHub committer, trusted author", commit("a", { committer: null })],
    ["web-flow commit by a trusted author", commit("a", { committer: webFlow, web: validWeb })],
    ["server-made commit", commit("a", { author: { id: SERVER_BOT_ID, login: "srv[bot]" }, committer: webFlow, web: { ...validWeb, committedViaWeb: false, authorLogin: null } })],
  ];
  test.each(trusted)("trusts %s", (_, c) => {
    const result = evaluateTrust([c], c.sha, config());
    expect(result.problems).toEqual([]);
    expect(result.commits[0]?.trusted).toBe(true);
    expect(problems([c]).every((p) => p.ok)).toBe(true);
  });

  const rejects: [string, CommitFacts[], string, "signed-commits" | "trusted-committers", RegExp][] = [
    ["no commits", [], "h", "signed-commits", /no commits/],
    ["at the 250 commit cap", Array.from({ length: MAX_COMMITS }, (_, i) => commit(`c${i}`)), `c${MAX_COMMITS - 1}`, "signed-commits", /250 or more commits/],
    ["last commit is not the pinned head", [commit("a"), commit("b")], "c", "trusted-committers", /not the pinned head c/],
    ["unsigned commit", [commit("a", { verified: false })], "a", "signed-commits", /a is not signed/],
    ["untrusted committer", [commit("a", { committer: mallory, author: alice })], "a", "trusted-committers", /a is by mallory/],
    ["untrusted author without committer", [commit("a", { committer: null, author: mallory })], "a", "trusted-committers", /a is by mallory/],
    ["no committer and no author", [commit("a", { committer: null, author: null })], "a", "trusted-committers", /neither a GitHub committer nor a GitHub author/],
    ["trusted login but different id", [commit("a", { committer: { id: 99, login: "alice" } })], "a", "trusted-committers", /a is by alice/],
    ["web-flow without GraphQL facts", [commit("a", { committer: webFlow })], "a", "trusted-committers", /not signed by GitHub/],
    ["web-flow not signed by GitHub", [commit("a", { committer: webFlow, web: { ...validWeb, signedByGitHub: false } })], "a", "trusted-committers", /not signed by GitHub/],
    ["web-flow invalid signature", [commit("a", { committer: webFlow, web: { ...validWeb, signatureValid: false } })], "a", "trusted-committers", /not signed by GitHub/],
    ["web-flow without author", [commit("a", { committer: webFlow, author: null, web: validWeb })], "a", "trusted-committers", /no GitHub author/],
    ["web-flow not committed via web", [commit("a", { committer: webFlow, web: { ...validWeb, committedViaWeb: false } })], "a", "trusted-committers", /not committed via the web/],
    ["web-flow author mismatch", [commit("a", { committer: webFlow, web: { ...validWeb, authorLogin: "bob" } })], "a", "trusted-committers", /differs between REST and GraphQL/],
    ["web-flow by untrusted author", [commit("a", { committer: webFlow, author: mallory, web: { ...validWeb, authorLogin: "mallory" } })], "a", "trusted-committers", /a is by mallory/],
    ["server bot as committer is not server-made", [commit("a", { committer: { id: SERVER_BOT_ID, login: "srv[bot]" } })], "a", "trusted-committers", /a is by srv\[bot\]/],
    ["one bad commit among good ones", [commit("a"), commit("b", { committer: mallory }), commit("c")], "c", "trusted-committers", /b is by mallory/],
  ];
  test.each(rejects)("rejects %s", (_, commits, head, policy, pattern) => {
    const results = problems(commits, head);
    const failing = results.find((r) => r.type === policy);
    expect(failing?.ok).toBe(false);
    expect(failing?.problems.join("\n")).toMatch(pattern);
  });

  test("an unsigned commit is never trusted", () => {
    const result = evaluateTrust([commit("a", { verified: false })], "a", config());
    expect(result.commits[0]?.trusted).toBe(false);
  });

  // Policies are chosen per server, so each one must hold on its own.
  const alone: [string, "signed-commits" | "trusted-committers", CommitFacts, RegExp][] = [
    ["trusted-committers rejects an unsigned commit claiming a trusted committer", "trusted-committers", commit("a", { verified: false }), /not signed, so its author cannot be verified/],
    ["trusted-committers rejects an unsigned commit by an untrusted committer", "trusted-committers", commit("a", { verified: false, committer: mallory }), /not signed/],
    ["signed-commits rejects an unsigned commit by a trusted committer", "signed-commits", commit("a", { verified: false }), /a is not signed and verified/],
  ];
  test.each(alone)("%s", (_, type, c, pattern) => {
    const [result] = evaluatePolicies([{ type }], { trust: evaluateTrust([c], c.sha, config()) });
    expect(result?.ok).toBe(false);
    expect(result?.problems.join("\n")).toMatch(pattern);
  });
});
