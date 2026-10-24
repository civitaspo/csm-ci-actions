import { describe, expect, test } from "bun:test";
import { github } from "./github.ts";
import { type IntakeInput, runIntake } from "./intake.ts";
import { CLIENT_BOT_ID, CONFIG_YAML, fakeFetch } from "./testing.ts";

const LABEL = "csm-ci-approve-abc";
const event = {
  action: "created",
  repository: { id: 1, full_name: "owner/server" },
  label: { name: LABEL, description: "owner/repo/12" },
  sender: { id: CLIENT_BOT_ID, type: "Bot" },
};
const input: IntakeInput = { event, repository: "owner/server", sha: "abc", repositoryId: 1, runAttempt: 1, configPath: "csm-ci.yaml" };
const configRoute = { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML };
const labelRoute = (body: unknown, status = 200) => ({ method: "GET", path: `/repos/owner/server/labels/${LABEL}`, status, body });

describe("runIntake", () => {
  test("accepts a live label", async () => {
    const fetch = fakeFetch([configRoute, labelRoute({ name: LABEL, description: "owner/repo/12" })]);
    expect(await runIntake(github("t", fetch), input)).toMatchObject({ kind: "approve", args: { pull_number: 12 } });
    expect(fetch.calls).toEqual(["GET /repos/owner/server/contents/csm-ci.yaml", `GET /repos/owner/server/labels/${LABEL}`]);
  });

  const rejects: [string, IntakeInput, ReturnType<typeof labelRoute>, RegExp][] = [
    ["label deleted before intake", input, labelRoute({ message: "Not Found" }, 404), /no longer exists/],
    ["label edited before intake", input, labelRoute({ name: LABEL, description: "owner/repo/13" }), /description changed/],
    ["server re-run", { ...input, runAttempt: 2 }, labelRoute({ name: LABEL, description: "owner/repo/12" }), /re-runs are not accepted/],
    ["malformed event", { ...input, event: { action: "created" } }, labelRoute({}), /repository/],
  ];
  test.each(rejects)("rejects %s", async (_, i, route, message) => {
    await expect(runIntake(github("t", fakeFetch([configRoute, route])), i)).rejects.toThrow(message);
  });
});
