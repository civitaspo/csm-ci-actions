import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { z } from "zod";
import { parsePreparedNumbers, prepareClientRequest, requestKind } from "./client-request.ts";

const server = "civitaspo/csm-ci-actions";
const repository = "civitaspo/testing-csm-ci-client";
const pullRequest = (action: string) => ({ action, pull_request: { number: 17 } });
const comment = (body: string, options: { action?: string; pullRequest?: boolean; association?: string } = {}) => ({
  action: options.action ?? "created",
  issue: { number: 17, ...(options.pullRequest === false ? {} : { pull_request: { url: "https://api.github.com/repos/example/repo/pulls/17" } }) },
  comment: { id: 235, body, author_association: options.association ?? "MEMBER" },
});
const botComment = (commentUser: unknown = { id: 123, type: "Bot" }, issueUser: unknown = { id: 123 }, body = "/merge") => {
  const event = comment(body, { association: "CONTRIBUTOR" });
  return { ...event, issue: { ...event.issue, user: issueUser }, comment: { ...event.comment, user: commentUser } };
};
const release = (overrides: Record<string, unknown> = {}) => ({
  action: "closed",
  repository: { full_name: repository, default_branch: "main" },
  pull_request: {
    number: 31,
    merged: true,
    head: { ref: "release/next", repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    ...overrides,
  },
});

describe("prepareClientRequest", () => {
  test.each([
    ["automatic approve", "approve", "pull_request_target", pullRequest("opened"), { kind: "approve", numbers: [17] }],
    ["approve comment", "approve", "issue_comment", comment("/approve"), { kind: "approve", numbers: [17, 235] }],
    ["recheck comment", "approve", "issue_comment", comment("/recheck"), { kind: "approve", numbers: [17, 235] }],
    ["policy-check", "policy-check", "pull_request_target", pullRequest("edited"), { kind: "policy-check", numbers: [17] }],
    ["merge command", "merge", "issue_comment", comment("/merge"), { kind: "merge", numbers: [17, 235] }],
    ["bot merging its own PR", "merge", "issue_comment", botComment(), { kind: "merge", numbers: [17, 235] }],
    ["release publish", "release-publish", "pull_request", release(), { kind: "release", numbers: [31] }],
  ] as const)("sends %s with the expected fixed request", (_name, operation, eventName, event, request) => {
    const result = prepareClientRequest(operation, eventName, event, server);
    expect(result).toEqual({ status: "send", request, server: { owner: "civitaspo", name: "csm-ci-actions" } });
  });

  test.each([
    ["approve action", "approve", "pull_request_target", pullRequest("closed"), "pull request action closed is not handled"],
    ["approve wrong event", "approve", "push", {}, "event push is not handled"],
    ["approve malformed payload", "approve", "pull_request_target", {}, "event payload is not a pull request event"],
    ["comment action", "approve", "issue_comment", comment("/approve", { action: "edited" }), "comment action edited is not handled"],
    ["issue comment", "approve", "issue_comment", comment("/approve", { pullRequest: false }), "comment is not on a pull request"],
    ["untrusted association", "approve", "issue_comment", comment("/approve", { association: "FIRST_TIME_CONTRIBUTOR" }), "comment author association FIRST_TIME_CONTRIBUTOR is not allowed"],
    ["approve command body", "approve", "issue_comment", comment("/approve extra"), "comment body is not exactly /approve or /recheck"],
    ["policy wrong action", "policy-check", "pull_request_target", pullRequest("closed"), "pull request action closed is not handled"],
    ["policy wrong event", "policy-check", "issue_comment", comment("/recheck"), "event issue_comment is not handled"],
    ["approve malformed comment", "approve", "issue_comment", {}, "event payload is not an issue comment"],
    ["approve null PR", "approve", "issue_comment", { ...comment("/approve"), issue: { number: 17, pull_request: null } }, "comment is not on a pull request"],
    ["merge malformed comment", "merge", "issue_comment", {}, "event payload is not an issue comment"],
    ["merge edited comment", "merge", "issue_comment", comment("/merge", { action: "edited" }), "comment action edited is not handled"],
    ["merge null PR", "merge", "issue_comment", { ...comment("/merge"), issue: { number: 17, pull_request: null } }, "comment is not on a pull request"],
    ["release malformed payload", "release-publish", "pull_request", {}, "event payload is not a pull request event"],
    ["release missing repository identity", "release-publish", "pull_request", { ...release(), repository: { default_branch: "main" } }, "event payload is not a pull request event"],
    ["release wrong action", "release-publish", "pull_request", { ...release(), action: "opened" }, "pull request action opened is not handled"],
    ["merge wrong event", "merge", "pull_request_target", pullRequest("opened"), "event pull_request_target is not handled"],
    ["merge issue comment", "merge", "issue_comment", comment("/merge", { pullRequest: false }), "comment is not on a pull request"],
    ["merge untrusted association", "merge", "issue_comment", comment("/merge", { association: "NONE" }), "comment author association NONE is not allowed"],
    ["merge command body", "merge", "issue_comment", comment("/Merge"), "comment body is not exactly /merge"],
    ["bot on another author's PR", "merge", "issue_comment", botComment({ id: 456, type: "Bot" }), "comment author association CONTRIBUTOR is not allowed"],
    ["human on their own PR", "merge", "issue_comment", botComment({ id: 123, type: "User" }), "comment author association CONTRIBUTOR is not allowed"],
    ["bot missing type", "merge", "issue_comment", botComment({ id: 123 }), "comment author association CONTRIBUTOR is not allowed"],
    ["bot malformed type", "merge", "issue_comment", botComment({ id: 123, type: "bot" }), "comment author association CONTRIBUTOR is not allowed"],
    ["bot missing user", "merge", "issue_comment", { ...botComment(), comment: comment("/merge", { association: "CONTRIBUTOR" }).comment }, "comment author association CONTRIBUTOR is not allowed"],
    ["bot null user", "merge", "issue_comment", botComment(null), "comment author association CONTRIBUTOR is not allowed"],
    ["bot missing PR author", "merge", "issue_comment", { ...botComment(), issue: comment("/merge").issue }, "comment author association CONTRIBUTOR is not allowed"],
    ["bot null PR author", "merge", "issue_comment", botComment({ id: 123, type: "Bot" }, null), "comment author association CONTRIBUTOR is not allowed"],
    ["bot edited command", "merge", "issue_comment", { ...botComment(), action: "edited" }, "comment action edited is not handled"],
    ["bot on issue", "merge", "issue_comment", { ...botComment(), issue: { number: 17, user: { id: 123 } } }, "comment is not on a pull request"],
    ["bot command body", "merge", "issue_comment", botComment({ id: 123, type: "Bot" }, { id: 123 }, "/merge extra"), "comment body is not exactly /merge"],
    ["bot approve unchanged", "approve", "issue_comment", botComment({ id: 123, type: "Bot" }, { id: 123 }, "/approve"), "comment author association CONTRIBUTOR is not allowed"],
    ["bot recheck unchanged", "approve", "issue_comment", botComment({ id: 123, type: "Bot" }, { id: 123 }, "/recheck"), "comment author association CONTRIBUTOR is not allowed"],
    ["release wrong event", "release-publish", "push", {}, "event push is not handled"],
    ["release not merged", "release-publish", "pull_request", release({ merged: false }), "pull request was not merged"],
    ["release wrong branch", "release-publish", "pull_request", release({ head: { ref: "main", repo: { full_name: repository } } }), "pull request head is not release/next"],
    ["release fork head", "release-publish", "pull_request", release({ head: { ref: "release/next", repo: { full_name: "someone/fork" } } }), "pull request head repository is not this repository"],
    ["release fork base", "release-publish", "pull_request", release({ base: { ref: "main", repo: { full_name: "someone/fork" } } }), "pull request base repository is not this repository"],
    ["release non-default base", "release-publish", "pull_request", release({ base: { ref: "develop", repo: { full_name: repository } } }), "pull request base is not the default branch"],
  ] as const)("skips %s with an observable reason", (_name, operation, eventName, event, reason) => {
    expect(prepareClientRequest(operation, eventName, event, server)).toEqual({ status: "skip", reason });
  });

  test.each([undefined, null, "123", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects malformed bot identity %s with an observable reason", (id) => {
    for (const event of [botComment({ id, type: "Bot" }), botComment({ id, type: "Bot" }, { id }), botComment({ id: 123, type: "Bot" }, { id })]) {
      expect(prepareClientRequest("merge", "issue_comment", event, server)).toEqual({
        status: "skip", reason: "comment author association CONTRIBUTOR is not allowed",
      });
    }
  });

  test("rejects an invalid server repository before returning a request", () => {
    expect(() => prepareClientRequest("merge", "issue_comment", comment("/merge"), "not-a-repository"))
      .toThrow("server-repository must be owner/repo");
  });
});

describe("prepared client request", () => {
  test.each([
    ["approve", "17", [17]],
    ["approve", "17/235", [17, 235]],
    ["merge", "17/235", [17, 235]],
    ["policy-check", "17", [17]],
    ["policy-check", "17/235", [17, 235]],
    ["release-publish", "31", [31]],
  ] as const)("parses fixed args for %s", (operation, value, expected) => {
    expect(parsePreparedNumbers(operation, value)).toEqual([...expected]);
  });

  test.each([
    ["approve", "0"], ["approve", "01"], ["approve", "1/2/3"], ["merge", "1"],
    ["policy-check", "1/0"], ["release-publish", "1/2"], ["merge", "9007199254740992/2"],
  ] as const)("rejects malformed args for %s", (operation, value) => {
    expect(() => parsePreparedNumbers(operation, value)).toThrow(`prepared request arguments are invalid for ${operation}`);
  });

  test.each([
    ["approve", "approve"], ["merge", "merge"], ["policy-check", "policy-check"], ["release-publish", "release"],
  ] as const)("binds %s to its server request kind", (operation, kind) => {
    expect(requestKind(operation)).toBe(kind);
  });
});

const compositeActionSchema = z.object({
  inputs: z.record(z.string(), z.object({ required: z.boolean().optional() })),
  outputs: z.record(z.string(), z.object({ value: z.string().optional() })),
  runs: z.object({ using: z.string(), steps: z.array(z.object({
    id: z.string().optional(), if: z.string().optional(), uses: z.string().optional(),
    run: z.string().optional(), with: z.record(z.string(), z.unknown()).optional(),
  })) }),
});

describe("client composites", () => {
  test.each([
    ["approve", "approve"], ["merge", "merge"], ["policy-check", "policy-check"], ["release-publish", "release-publish"],
  ] as const)("filters %s before minting its fixed-permission token", (operation, kind) => {
    const action = compositeActionSchema.parse(parse(readFileSync(`actions/client/${operation}/action.yml`, "utf8")));
    expect(action.runs.using).toBe("composite");
    for (const input of ["client-id", "private-key", "server-repository"]) expect(action.inputs[input]?.required).toBe(true);
    const [prepare, token, request] = action.runs.steps;
    expect(prepare?.id).toBe("prepare");
    expect(prepare?.run).toContain(`dist/client-${operation}.js`);
    expect(prepare?.if).toBeUndefined();
    expect(token?.if).toBe("steps.prepare.outputs.should-send == 'true'");
    expect(token?.uses?.startsWith("actions/create-github-app-token@")).toBe(true);
    expect(token?.with?.owner).toBe("${{ steps.prepare.outputs.server-owner }}");
    expect(token?.with?.repositories).toBe("${{ steps.prepare.outputs.server-name }}");
    expect(Object.keys(token?.with ?? {}).filter((input) => input.startsWith("permission-"))).toEqual(["permission-issues"]);
    expect(token?.with?.["permission-issues"]).toBe("write");
    expect(request?.if).toBe("steps.prepare.outputs.should-send == 'true'");
    expect(request?.run).toContain(`dist/client-${operation}.js`);
    expect(action.outputs.label?.value).toBe("${{ steps.request.outputs.label }}");
  });
});


test.each(["securefix", "release-prepare"])("%s owns packaging and the scoped request token", (operation) => {
  const action = compositeActionSchema.parse(parse(readFileSync(`actions/client/${operation}/action.yml`, "utf8")));
  for (const input of ["client-id", "private-key", "server-repository"]) expect(action.inputs[input]?.required).toBe(true);
  const steps = action.runs.steps;
  const packageIndex = steps.findIndex((step) => step.id === "package");
  const tokenIndex = steps.findIndex((step) => step.id === "token");
  expect(packageIndex).toBeGreaterThanOrEqual(0);
  expect(tokenIndex).toBeGreaterThan(packageIndex);
  const token = steps[tokenIndex];
  expect(token?.uses?.startsWith("actions/create-github-app-token@")).toBe(true);
  expect(token?.with?.owner).toBe("${{ steps.package.outputs.server-owner }}");
  expect(token?.with?.repositories).toBe("${{ steps.package.outputs.server-name }}");
  expect(Object.keys(token?.with ?? {}).filter((input) => input.startsWith("permission-"))).toEqual(["permission-issues"]);
  expect(token?.with?.["permission-issues"]).toBe("write");
  for (const step of steps.slice(packageIndex + 1)) expect(step.if).toBe("steps.package.outputs.has-changes == 'true'");
  expect(steps.at(-1)?.id).toBe("request");
  expect(action.outputs.label?.value).toBe("${{ steps.request.outputs.label }}");
});
