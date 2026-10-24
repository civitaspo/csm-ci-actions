import { describe, expect, test } from "bun:test";
import { type CommentFacts, checkPullState, type PullFacts, parseCommand, requirePrincipal, validateComment } from "./command.ts";
import { Rejection } from "./request.ts";

describe("parseCommand", () => {
  const cases: [string, ReturnType<typeof parseCommand>][] = [
    ["/approve", { name: "approve" }],
    ["\n/approve  ", { name: "approve" }],
    ["  /recheck\n", { name: "recheck" }],
    ["/approve abc1234", undefined],
    [`/approve ${"a".repeat(40)}`, undefined],
    ["/approve please", undefined],
    ["please /approve", undefined],
    ["/approved", undefined],
    ["/recheck now", undefined],
    ["/merge", undefined],
    ["", undefined],
  ];
  test.each(cases)("%p", (body, expected) => {
    expect(parseCommand(body)).toEqual(expected);
  });
});

const NOW = new Date("2026-10-24T12:00:00Z");
function comment(over: Partial<CommentFacts> = {}): CommentFacts {
  return {
    id: 9,
    body: "/approve",
    issueUrl: "https://api.github.com/repos/Owner/Repo/issues/12",
    createdAt: "2026-10-24T11:30:00Z",
    updatedAt: "2026-10-24T11:30:00Z",
    user: { id: 10, login: "alice", type: "User" },
    ...over,
  };
}

describe("validateComment", () => {
  test("accepts a fresh, unedited command on the pull request", () => {
    expect(validateComment(comment(), "owner/repo", 12, NOW)).toEqual({ name: "approve" });
    expect(validateComment(comment({ createdAt: "2026-10-24T11:00:00Z", updatedAt: "2026-10-24T11:00:00Z" }), "owner/repo", 12, NOW)).toEqual({ name: "approve" });
  });

  const rejects: [string, Partial<CommentFacts>, RegExp][] = [
    ["comment on another pull request", { issueUrl: "https://api.github.com/repos/owner/repo/issues/13" }, /not on owner\/repo#12/],
    ["comment on a suffix-matching number", { issueUrl: "https://api.github.com/repos/owner/repo/issues/112" }, /not on owner\/repo#12/],
    ["comment in another repository", { issueUrl: "https://api.github.com/repos/owner/other/issues/12" }, /not on owner\/repo#12/],
    ["not a command", { body: "/approve please" }, /not exactly/],
    ["edited comment", { updatedAt: "2026-10-24T11:31:00Z" }, /was edited/],
    ["older than 60 minutes", { createdAt: "2026-10-24T10:59:59Z", updatedAt: "2026-10-24T10:59:59Z" }, /older than 60 minutes/],
    ["created in the future", { createdAt: "2026-10-24T12:00:01Z", updatedAt: "2026-10-24T12:00:01Z" }, /older than 60 minutes/],
  ];
  test.each(rejects)("rejects %s", (_, over, message) => {
    expect(() => validateComment(comment(over), "owner/repo", 12, NOW)).toThrow(message);
  });

  test("/recheck skips the freshness checks", () => {
    const stale = comment({ body: "/recheck", createdAt: "2026-10-24T09:00:00Z", updatedAt: "2026-10-24T09:30:00Z" });
    expect(validateComment(stale, "owner/repo", 12, NOW)).toEqual({ name: "recheck" });
    expect(() => validateComment({ ...stale, issueUrl: "https://api.github.com/repos/owner/repo/issues/13" }, "owner/repo", 12, NOW)).toThrow(/not on/);
  });
});

describe("requirePrincipal", () => {
  const approvers = [{ id: 10, login: "alice" }];
  test("accepts by id", () => {
    expect(requirePrincipal({ id: 10, login: "renamed", type: "User" }, approvers, "approvers")).toEqual({ id: 10, login: "alice" });
  });
  const rejects: [string, CommentFacts["user"]][] = [
    ["unknown user", { id: 11, login: "alice", type: "User" }],
    ["bot with a listed id", { id: 10, login: "alice", type: "Bot" }],
    ["deleted user", null],
  ];
  test.each(rejects)("rejects %s", (_, user) => {
    expect(() => requirePrincipal(user, approvers, "approvers")).toThrow(Rejection);
  });
});

describe("checkPullState", () => {
  const ok: PullFacts = {
    number: 12,
    state: "open",
    draft: false,
    headSha: "h",
    headRepository: "Owner/Repo",
    baseRepository: "owner/repo",
    baseRef: "main",
    defaultBranch: "main",
    authorId: 10,
  };
  test("accepts an open same-repository pull request to the default branch", () => {
    expect(() => checkPullState(ok)).not.toThrow();
  });
  const rejects: [string, Partial<PullFacts>, RegExp][] = [
    ["closed", { state: "closed" }, /is closed/],
    ["draft", { draft: true }, /is a draft/],
    ["fork", { headRepository: "fork/repo" }, /from a fork/],
    ["deleted head repository", { headRepository: null }, /from a fork/],
    ["other base", { baseRef: "release" }, /not the default branch/],
  ];
  test.each(rejects)("rejects %s", (_, over, message) => {
    expect(() => checkPullState({ ...ok, ...over })).toThrow(message);
  });
});
