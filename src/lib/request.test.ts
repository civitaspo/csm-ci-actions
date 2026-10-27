import { describe, expect, test } from "bun:test";
import { buildLabel, concurrencyKey, type LabelEvent, parseLabel, Rejection, validateIntake } from "./request.ts";
import { CLIENT_BOT_ID, config } from "./testing.ts";

describe("parseLabel", () => {
  const accepts: [string, string, string, object][] = [
    ["csm-ci-approve-abc123", "Owner/Repo/12", "approve", { pull_number: 12 }],
    ["csm-ci-approve-x", "owner/repo/12/3456", "approve", { pull_number: 12, comment_id: 3456 }],
    ["csm-ci-merge-x", "owner/repo/12/3456", "merge", { pull_number: 12, comment_id: 3456 }],
    ["csm-ci-policy-check-x", "owner/repo/12/3456", "policy-check", { pull_number: 12, comment_id: 3456 }],
    ["csm-ci-policy-check-0f", "owner/re.po_-x/1", "policy-check", { pull_number: 1 }],
    ["csm-ci-securefix-9", "owner/repo/99999999999", "securefix", { run_id: 99999999999 }],
    ["csm-ci-release-z", "owner/repo/7", "release", { pull_number: 7 }],
  ];
  test.each(accepts)("accepts %s %s", (name, description, kind, args) => {
    const r = parseLabel(name, description);
    expect(r.kind).toBe(kind as never);
    expect(r.args).toEqual(args as never);
    expect(r.repository).toBe(description.toLowerCase().split("/").slice(0, 2).join("/"));
  });

  const rejects: [string, string, string, RegExp][] = [
    ["name over 50 characters", `csm-ci-approve-${"a".repeat(40)}`, "owner/repo/1", /longer than 50/],
    ["foreign prefix", "other-approve-1", "owner/repo/1", /not a csm-ci request/],
    ["unknown kind", "csm-ci-deploy-1", "owner/repo/1", /not a csm-ci request/],
    ["uppercase suffix", "csm-ci-approve-ABC", "owner/repo/1", /not a csm-ci request/],
    ["missing suffix", "csm-ci-approve-", "owner/repo/1", /not a csm-ci request/],
    ["suffix with hyphen", "csm-ci-approve-a-b", "owner/repo/1", /not a csm-ci request/],
    ["no numbers", "csm-ci-approve-1", "owner/repo", /not owner\/repo\/<numbers>/],
    ["empty description", "csm-ci-approve-1", "", /not owner\/repo\/<numbers>/],
    ["too many numbers", "csm-ci-approve-1", "owner/repo/1/2/3", /approve expects 1 or 2 number/],
    ["merge without a comment", "csm-ci-merge-1", "owner/repo/1", /merge expects 2 number/],
    ["securefix with two numbers", "csm-ci-securefix-1", "owner/repo/1/2", /securefix expects 1 number/],
    ["leading zero", "csm-ci-approve-1", "owner/repo/012", /without leading zeros/],
    ["zero", "csm-ci-approve-1", "owner/repo/0", /without leading zeros/],
    ["negative", "csm-ci-approve-1", "owner/repo/-1", /without leading zeros/],
    ["not a number", "csm-ci-approve-1", "owner/repo/abc", /without leading zeros/],
    ["17 digits", "csm-ci-approve-1", "owner/repo/12345678901234567", /without leading zeros/],
    ["16 digits beyond the safe integer range", "csm-ci-approve-1", "owner/repo/9007199254740993", /safe integer/],
    ["empty segment", "csm-ci-merge-1", "owner/repo//1", /not owner\/repo\/<numbers>/],
    ["invalid owner characters", "csm-ci-approve-1", "own_er/repo/1", /not owner\/repo\/<numbers>/],
  ];
  test.each(rejects)("rejects %s", (_, name, description, message) => {
    expect(() => parseLabel(name, description)).toThrow(message);
    expect(() => parseLabel(name, description)).toThrow(Rejection);
  });
});

function event(overrides: Partial<LabelEvent> = {}): LabelEvent {
  return {
    action: "created",
    repository: { id: 1, full_name: "Owner/Server" },
    label: { name: "csm-ci-approve-abc", description: "owner/repo/12" },
    sender: { id: CLIENT_BOT_ID, type: "Bot" },
    ...overrides,
  };
}
const env = { repositoryId: 1, runAttempt: 1 };

describe("validateIntake", () => {
  test("accepts a client bot label for a managed repository", () => {
    expect(validateIntake(event(), env, config())).toEqual({ kind: "approve", repository: "owner/repo", label: "csm-ci-approve-abc", args: { pull_number: 12 } });
  });

  test("accepts a command for an enabled op", () => {
    const r = validateIntake(event({ label: { name: "csm-ci-approve-a", description: "owner/repo/1/2" } }), env, config());
    expect(r.args).toEqual({ pull_number: 1, comment_id: 2 });
  });

  const rejects: [string, LabelEvent, typeof env, RegExp][] = [
    ["action other than created", event({ action: "edited" }), env, /action is edited/],
    ["server re-run", event(), { ...env, runAttempt: 2 }, /re-runs are not accepted/],
    ["event from another repository id", event(), { ...env, repositoryId: 2 }, /is not the server repository/],
    ["event repository name mismatch", event({ repository: { id: 1, full_name: "owner/other" } }), env, /is not the server repository/],
    ["sender is a human", event({ sender: { id: CLIENT_BOT_ID, type: "User" } }), env, /is not the client app bot/],
    ["sender is another bot", event({ sender: { id: 9, type: "Bot" } }), env, /is not the client app bot/],
    ["malformed label", event({ label: { name: "bug", description: null } }), env, /not a csm-ci request/],
    ["null description", event({ label: { name: "csm-ci-approve-a", description: null } }), env, /not owner\/repo/],
    ["unmanaged owner", event({ label: { name: "csm-ci-approve-a", description: "other/repo/1" } }), env, /not managed/],
    ["op not enabled", event({ label: { name: "csm-ci-securefix-a", description: "owner/repo/1" } }), env, /does not enable securefix/],
    ["command for an op not enabled", event({ label: { name: "csm-ci-merge-a", description: "owner/repo/1/2" } }), env, /does not enable merge/],
    ["repository with no ops", event({ label: { name: "csm-ci-approve-a", description: "owner/no-ops/1" } }), env, /does not enable approve/],
  ];
  test.each(rejects)("rejects %s", (_, e, en, message) => {
    const cfg = config();
    if (e.label.name.startsWith("csm-ci-merge-")) {
      cfg.repositories = cfg.repositories.map((entry) => ({ ...entry, ops: entry.ops.filter((op) => op !== "merge") }));
    }
    expect(() => validateIntake(e, en, cfg)).toThrow(message);
  });
});

describe("concurrencyKey", () => {
  test("uses the operation kind and the pull request or run number", () => {
    expect(concurrencyKey(parseLabel("csm-ci-merge-a", "Owner/Repo/5/6"))).toBe("merge-owner/repo#5");
    expect(concurrencyKey(parseLabel("csm-ci-securefix-a", "owner/repo/9"))).toBe("securefix-owner/repo#9");
  });
  test("serializes publishing kinds on one pull request and separates merge", () => {
    const merge = concurrencyKey(parseLabel("csm-ci-merge-a", "owner/repo/5/6"));
    const approve = concurrencyKey(parseLabel("csm-ci-approve-b", "owner/repo/5/7"));
    expect(approve).not.toBe(merge);
    expect(concurrencyKey(parseLabel("csm-ci-policy-check-c", "Owner/Repo/5"))).toBe(approve);
    expect(concurrencyKey(parseLabel("csm-ci-merge-c", "Owner/Repo/5/8"))).toBe(merge);
  });
});

describe("buildLabel", () => {
  test("round-trips through parseLabel", () => {
    const { name, description } = buildLabel("merge", "Owner/Repo", ["12", 34]);
    expect(name).toMatch(/^csm-ci-merge-[0-9a-f]{16}$/);
    expect(description).toBe("owner/repo/12/34");
    expect(parseLabel(name, description).args).toEqual({ pull_number: 12, comment_id: 34 });
  });

  const rejects: [string, () => unknown, RegExp][] = [
    ["unknown kind", () => buildLabel("deploy", "owner/repo", [1]), /not a csm-ci request/],
    ["wrong arity", () => buildLabel("merge", "owner/repo", [1]), /expects 2 number/],
    ["bad number", () => buildLabel("approve", "owner/repo", ["01"]), /leading zeros/],
    ["description over 100 characters", () => buildLabel("approve", `owner/${"r".repeat(100)}`, [1]), /longer than 100/],
  ];
  test.each(rejects)("rejects %s", (_, fn, message) => {
    expect(fn).toThrow(message);
  });
});
