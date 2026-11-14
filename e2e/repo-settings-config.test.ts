import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/lib/config.ts";
import { CONFIG_YAML } from "../src/lib/testing.ts";
import { enableManagedFileAutoCompletion } from "./repo-settings.ts";

const DRIFT_PATH = "e2e/repo-settings-managed-drift.txt";
const CONFIG_WITH_DISABLED_FLAG = `${CONFIG_YAML}\nrepo_settings:\n  auto_merge_managed_files: false\n  additional_managed_files:\n    e2e/repo-settings-managed.txt: managed-files/repo-settings-managed.txt\n`;

describe("managed auto-completion e2e configuration", () => {
  test("enables an existing false flag and adds exactly one second managed destination", () => {
    const updated = enableManagedFileAutoCompletion(CONFIG_WITH_DISABLED_FLAG, DRIFT_PATH);
    const parsed = parseConfig(updated);

    expect(parsed.repo_settings?.auto_merge_managed_files).toBe(true);
    expect(parsed.repo_settings?.additional_managed_files).toEqual({
      "e2e/repo-settings-managed.txt": "managed-files/repo-settings-managed.txt",
      [DRIFT_PATH]: "managed-files/repo-settings-managed.txt",
    });
    expect(updated.match(/^  auto_merge_managed_files:/gmu)).toHaveLength(1);
    expect(updated.match(new RegExp(`^    ${DRIFT_PATH.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`, "gmu"))).toHaveLength(1);
  });

  test("inserts the opt-in when omitted without duplicating existing destinations", () => {
    const withoutFlag = CONFIG_WITH_DISABLED_FLAG.replace("  auto_merge_managed_files: false\n", "");
    const once = enableManagedFileAutoCompletion(withoutFlag, DRIFT_PATH);
    const twice = enableManagedFileAutoCompletion(once, DRIFT_PATH);

    expect(parseConfig(twice).repo_settings?.auto_merge_managed_files).toBe(true);
    expect(parseConfig(twice).repo_settings?.additional_managed_files?.[DRIFT_PATH]).toBe("managed-files/repo-settings-managed.txt");
    expect(twice.match(/^  auto_merge_managed_files:/gmu)).toHaveLength(1);
    expect(twice.match(new RegExp(`^    ${DRIFT_PATH.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`, "gmu"))).toHaveLength(1);
  });

  test("rejects duplicate flag and destination keys rather than producing ambiguous YAML", () => {
    expect(() => enableManagedFileAutoCompletion(`${CONFIG_WITH_DISABLED_FLAG}  auto_merge_managed_files: false\n`, DRIFT_PATH)).toThrow("duplicate auto_merge_managed_files");
    const duplicatePath = `${enableManagedFileAutoCompletion(CONFIG_WITH_DISABLED_FLAG, DRIFT_PATH)}    ${DRIFT_PATH}: managed-files/repo-settings-managed.txt\n`;
    expect(() => enableManagedFileAutoCompletion(duplicatePath, DRIFT_PATH)).toThrow(`duplicate ${DRIFT_PATH}`);
  });
});
