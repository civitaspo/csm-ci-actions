import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a closed PR reports skipped instead of a passing empty policy list", () => {
  const directory = mkdtempSync(join(tmpdir(), "csm-policy-entry-"));
  try {
    const preload = join(directory, "preload.ts");
    const testing = new URL("../lib/testing.ts", import.meta.url).href;
    writeFileSync(preload, `
import { fakeFetch, CONFIG_YAML } from ${JSON.stringify(testing)};
globalThis.fetch = fakeFetch([
  { method: "GET", path: "/repos/owner/server/contents/csm-ci.yaml", body: CONFIG_YAML },
  { method: "GET", path: "/repos/owner/repo/pulls/12", body: {
    number: 12, state: "closed", user: { id: 10 }, head: { sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo", default_branch: "main" } }
  } }
]);
`);
    const result = Bun.spawnSync([process.execPath, "--preload", preload, "src/server-policy-check/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "", GITHUB_REPOSITORY: "owner/server", GITHUB_SHA: "b".repeat(40),
        "INPUT_GITHUB-TOKEN": "fixture", "INPUT_SERVER-TOKEN": "fixture", "INPUT_CONFIG-PATH": "csm-ci.yaml",
        INPUT_REPOSITORY: "owner/repo", "INPUT_PULL-NUMBER": "12",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(output).toContain("name=result::skipped");
    expect(output).toContain("Policy check skipped: #12 is closed");
    expect(output).not.toContain("Policies passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
