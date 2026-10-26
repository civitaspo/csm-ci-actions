import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function prepare(buildType: "none" | "terraform-provider", privateKey: string, passphrase: string) {
  const directory = mkdtempSync(join(tmpdir(), "csm-ci-secret-assets-"));
  try {
    const result = Bun.spawnSync([process.execPath, "src/server-release-assets/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        INPUT_DIRECTORY: directory,
        INPUT_PLAN: JSON.stringify({ repository: "owner/client", pullNumber: 1, mergeSha: "a".repeat(40), tag: "v1.2.3", version: "1.2.3",
          serverBotId: 1, serverBotLogin: "server[bot]", tagExists: true, privateRepository: false, prerelease: false,
          release: buildType === "terraform-provider" ? { build_type: buildType, provider_name: "test" } : { build_type: buildType } }),
        "INPUT_GPG-PRIVATE-KEY": privateKey,
        "INPUT_GPG-PASSPHRASE": passphrase,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      checksums: result.exitCode === 0 ? readFileSync(join(directory, "SHA256SUMS"), "utf8") : undefined };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("selected publication credentials", () => {
  test.each([
    ["", "", "gpg-private-key"],
    ["fixture key that must never reach signing", "", "gpg-passphrase"],
  ])("rejects missing provider input %s / %s before signing", (key, passphrase, input) => {
    const result = prepare("terraform-provider", key, passphrase);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`Input required and not supplied: ${input}`);
    expect(result.output).not.toContain("fixture key that must never reach signing");
  });

  test("publication without a provider needs no signing credentials", () => {
    const result = prepare("none", "", "");
    expect(result.exitCode).toBe(0);
    expect(result.checksums).toBe("\n");
  });
});
