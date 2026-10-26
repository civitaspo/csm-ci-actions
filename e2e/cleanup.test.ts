import { describe, expect, test } from "bun:test";
import { withCleanup } from "./cleanup.ts";

describe("repo-settings cleanup", () => {
  test("runs every cleanup after a successful scenario", async () => {
    const events: string[] = [];
    await withCleanup(async () => { events.push("scenario"); }, [
      async () => { events.push("managed state"); },
      async () => { events.push("repository settings"); },
    ]);
    expect(events).toEqual(["scenario", "managed state", "repository settings"]);
  });

  test.each([
    ["scenario", true, false, false, "invalid squash setting combination"],
    ["managed cleanup", false, true, false, "managed branch moved"],
    ["repository cleanup", false, false, true, "repository settings were not restored"],
    ["scenario and cleanup", true, false, true, "invalid squash setting combination (HTTP 422); repository settings were not restored"],
    ["all failures", true, true, true, "invalid squash setting combination (HTTP 422); managed branch moved; repository settings were not restored"],
  ])("reports %s failures and finishes all cleanup steps", async (_name, scenarioFails, managedFails, settingsFail, message) => {
    const events: string[] = [];
    const primary = Object.assign(new Error("invalid squash setting combination"), { status: 422 });
    await expect(withCleanup(async () => {
      events.push("scenario");
      if (scenarioFails) throw primary;
    }, [
      async () => {
        events.push("managed state");
        if (managedFails) throw new Error("managed branch moved");
      },
      async () => {
        events.push("repository settings");
        if (settingsFail) throw new Error("repository settings were not restored");
      },
    ])).rejects.toThrow(message);
    expect(events).toEqual(["scenario", "managed state", "repository settings"]);
  });

  test("keeps a sole API error's status for the scenario runner", async () => {
    const primary = Object.assign(new Error("invalid setting combination"), { status: 422 });
    await expect(withCleanup(async () => { throw primary; }, [])).rejects.toBe(primary);
  });

  test.each([true, false])("reports nested restoration failures when the scenario fails: %s", async (scenarioFails) => {
    await expect(withCleanup(async () => { if (scenarioFails) throw new Error("scenario failed"); }, [
      async () => { throw new AggregateError([new Error("ruleset restore failed"), new Error("settings restore failed")], "restoring owner/repo failed in 2 steps"); },
    ])).rejects.toThrow(`${scenarioFails ? "scenario failed; " : ""}restoring owner/repo failed in 2 steps: ruleset restore failed; settings restore failed`);
  });
});
