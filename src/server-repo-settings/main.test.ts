import { describe, expect, test } from "bun:test";

function runValidation(stage: string, operationMode: string, eventName = "workflow_dispatch", eventMode = "dispatch") {
  const result = Bun.spawnSync([process.execPath, "src/server-repo-settings/main.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      INPUT_MODE: stage,
      "INPUT_OPERATION-MODE": operationMode,
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
    ["inspect", "managed-files-only", "workflow_dispatch", "dispatch", "repo-settings stage inspect is unavailable in managed-files-only mode"],
    ["preflight", "managed-files-only", "workflow_dispatch", "dispatch", "repo-settings stage preflight is unavailable in managed-files-only mode"],
    ["apply", "managed-files-only", "workflow_dispatch", "dispatch", "repo-settings stage apply is unavailable in managed-files-only mode"],
    ["validate-mode", "unknown", "workflow_dispatch", "dispatch", "unknown repo-settings operation mode unknown"],
    ["validate-target", "managed-files-only", "schedule", "schedule", "a scheduled run cannot use managed-files-only mode"],
    ["validate-target", "managed-files-only", "push", "dispatch", "managed-files-only mode requires a workflow_dispatch event"],
  ])("rejects %s / %s on %s", (stage, operationMode, eventName, eventMode, message) => {
    const result = runValidation(stage, operationMode, eventName, eventMode);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(message);
  });

  test("normalizes an empty input before workflows choose their token stages", () => {
    const result = runValidation("validate-mode", "");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("name=operation-mode::reconcile");
  });

  test("validates a managed-files-only dispatch without repository configuration or token inputs", () => {
    expect(runValidation("validate-mode", "managed-files-only").exitCode).toBe(0);
  });
});
