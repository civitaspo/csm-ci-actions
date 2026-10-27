import { describe, expect, test } from "bun:test";

function runValidation(stage: string, targets: string, eventName = "workflow_dispatch", eventMode = "dispatch") {
  const result = Bun.spawnSync([process.execPath, "src/server-repo-settings/main.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      INPUT_MODE: stage,
      INPUT_TARGETS: targets,
      "INPUT_EVENT-MODE": eventMode,
      GITHUB_EVENT_NAME: eventName,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
}

describe("repo-settings action validation before configuration or tokens", () => {
  test.each([
    ["inspect", "managed-files", "workflow_dispatch", "dispatch", "repo-settings stage inspect is unavailable for targets managed-files"],
    ["preflight", "settings,releases", "workflow_dispatch", "dispatch", "repo-settings stage preflight is unavailable for targets settings,releases"],
    ["apply", "managed-files", "workflow_dispatch", "dispatch", "repo-settings stage apply is unavailable for targets managed-files"],
    ["managed-inspect", "settings", "workflow_dispatch", "dispatch", "repo-settings stage managed-inspect is unavailable for targets settings"],
    ["managed-apply", "rulesets", "workflow_dispatch", "dispatch", "repo-settings stage managed-apply is unavailable for targets rulesets"],
    ["validate-targets", "unknown", "workflow_dispatch", "dispatch", "unknown repo-settings target unknown"],
    ["validate-targets", "", "workflow_dispatch", "dispatch", "repo-settings targets must be a comma-separated list"],
    ["validate-target", "managed-files", "schedule", "schedule", "a scheduled run must select all repo-settings targets"],
    ["validate-target", "managed-files", "push", "dispatch", "selecting repo-settings targets other than all requires a workflow_dispatch event"],
  ])("rejects %s / %s on %s", (stage, targets, eventName, eventMode, message) => {
    const result = runValidation(stage, targets, eventName, eventMode);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(message);
  });

  test.each([
    ["all", "settings,rulesets,releases,managed-files", true, true, true],
    ["managed-files", "managed-files", false, false, true],
    ["settings", "settings", true, false, false],
    ["rulesets", "rulesets", true, true, false],
    ["releases,managed-files", "releases,managed-files", true, false, true],
  ])("emits the token gates for %s without repository configuration or token inputs", (targets, canonical, administration, rulesets, managed) => {
    const result = runValidation("validate-targets", targets);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`name=targets::${canonical}`);
    expect(result.output).toContain(`name=selects-administration::${administration}`);
    expect(result.output).toContain(`name=selects-rulesets::${rulesets}`);
    expect(result.output).toContain(`name=selects-managed-files::${managed}`);
  });
});
