import { expect, test } from "bun:test";
import { parse } from "yaml";
import { ConfigSchema, type Op } from "./config.ts";
import { config } from "./testing.ts";
import { ReleasedRevision, callerPath, generateWorkflows, selectedCallers, STANDARD_CALLERS } from "./generated-workflows.ts";

const revision = { version: "v1.2.3", sha: "a".repeat(40) };
const route = { name: "release-pr", from: "default", to: "release/next", workflow: callerPath("release-pr"), paths: { ".release-version": "semver", "CHANGELOG.md": "any" } };
function candidate(ops: Op[], extra: object = {}, routeExtra: object = {}) {
  return ConfigSchema.parse({ ...config(), securefix: { allow_workflow_changes: false, routes: [{ ...route, ...routeExtra }] }, repositories: [{ name: "owner/client", ops, ...(ops.includes("release") ? { release: { build_type: "none" } } : {}), ...extra }] });
}

for (let mask = 0; mask < 32; mask++) {
  const all: Op[] = ["approve", "policy-check", "merge", "release", "securefix"];
  const ops = all.filter((_, index) => mask & (1 << index));
  test(`generates the exact operation combination ${ops.join(",")}`, () => {
    const settings = candidate(ops);
    const files = generateWorkflows(settings, "owner/client", "trunk", revision);
    expect(Object.keys(files)).toEqual(ops.map((op) => callerPath(op === "securefix" ? "release-pr" : op)));
    for (const [caller] of Object.entries(STANDARD_CALLERS)) {
      const text = files[`.github/workflows/csm-ci-${caller}.yml`];
      if (!text) continue;
      const workflow = parse(text);
      expect(text).toContain(`v1.2.3 (${revision.sha})`);
      expect(workflow.permissions).toEqual({});
      expect(workflow.jobs[caller].uses).toBe(`civitaspo/csm-ci-actions/.github/workflows/${STANDARD_CALLERS[caller as keyof typeof STANDARD_CALLERS]}@${revision.sha}`);
      expect(text).toContain(`@${revision.sha} # v1.2.3\n`);
      expect(text).toContain(`\n# jactionlint ignore=${caller === "release" || caller === "release-pr" ? "concurrency-limits" : "concurrency-limits,dangerous-triggers"}\non:\n`);
      expect(workflow.jobs[caller].secrets).toEqual({ CSM_CI_CLIENT_APP_PRIVATE_KEY: "${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}" });
      expect(workflow.concurrency).toBeUndefined();
      if (caller === "release-pr") {
        expect(workflow.on.push.branches).toEqual(["trunk"]);
        expect(workflow.on.workflow_dispatch.inputs.version).toEqual({ description: "Optional semantic version without a v prefix.", type: "string", required: false, default: "" });
        expect(workflow.jobs[caller].with).toEqual({ version: "${{ inputs.version || '' }}", "update-root-version": true });
        expect(workflow.jobs[caller].permissions).toEqual({ contents: "read" });
        expect(workflow.jobs[caller].if).toContain("!startsWith(github.event.head_commit.message, 'chore(release): v')");
        expect(workflow.jobs[caller].if).toContain("!startsWith(github.event.head_commit.message, 'release-pr: chore(release): v')");
      } else {
        expect(workflow.jobs[caller].if).toBeUndefined();
        expect(workflow.jobs[caller].with).toBeUndefined();
        expect(workflow.jobs[caller].permissions).toEqual({});
      }
    }
  });
}

test.each([true, false, undefined])("preserves root-version setting %s", (value) => {
  const c = candidate(["securefix"], { release_prepare: { ...(value === undefined ? {} : { update_root_version: value }) } });
  expect(parse(generateWorkflows(c, "owner/client", "release/default", revision)[callerPath("release-pr")]!).jobs["release-pr"].with["update-root-version"]).toBe(value ?? true);
});

test.each([
  ["unselected preparation", [], { release_prepare: {} }, {}, "release_prepare requires selected release preparation"],
  ["unknown preparation key", ["securefix"], { release_prepare: { version: "1" } }, {}, "Unrecognized key"],
  ["nonboolean input", ["securefix"], { release_prepare: { update_root_version: "false" } }, {}, "expected boolean"],
  ["conflicting branch", ["securefix"], {}, { to: "release/custom" }, "release-pr route must use release/next"],
  ["conflicting workflow", ["securefix"], {}, { workflow: ".github/workflows/custom.yml" }, "release-pr route must use release/next"],
] satisfies [string, Op[], object, object, string][]) ("rejects %s", (_name, ops, extra, routeExtra, message) => {
  expect(() => candidate(ops, extra, routeExtra)).toThrow(message);
});

test("first matching entry and absent canonical route remain effective", () => {
  const c = candidate(["securefix"]);
  c.securefix!.routes = [];
  expect(selectedCallers(c, "owner/client")).toEqual([]);
  c.repositories.unshift({ name: "owner/client", ops: [] });
  expect(generateWorkflows(c, "owner/client", "trunk", revision)).toEqual({});
});

test("emits exact event sets", () => {
  const files = generateWorkflows(candidate(["approve", "policy-check", "merge", "release"]), "owner/client", "trunk", revision);
  expect(parse(files[callerPath("approve")]!).on).toEqual({ pull_request_target: { types: ["opened", "synchronize", "reopened", "ready_for_review"] }, issue_comment: { types: ["created"] } });
  expect(parse(files[callerPath("policy-check")]!).on).toEqual({ pull_request_target: { types: ["opened", "synchronize", "reopened", "ready_for_review", "edited"] } });
  expect(parse(files[callerPath("merge")]!).on).toEqual({ issue_comment: { types: ["created"] } });
  expect(parse(files[callerPath("release")]!).on).toEqual({ pull_request: { types: ["closed"] } });
});


test.each(["v0.0.0", "v1.2.3", "v1.2.3+build.01.a-b"])("accepts stable release version %s", (version) => {
  expect(ReleasedRevision.parse({ version, sha: revision.sha }).version).toBe(version);
});
