import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terraformAssets } from "./terraform.ts";

const invalid = { directory: ".", providerName: "test", version: "1.2.3", sourceDateEpoch: "1",
  fingerprint: "invalid", credentials: { mode: "verify", publicKey: "fixture public key" } } as const;

describe("Terraform Registry assets", () => {
  test("the bundled Node action validates without any file next to the bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "csm-ci-terraform-bundle-"));
    try {
      const bundle = await Bun.build({ entrypoints: [resolve("src/release/terraform.ts")], target: "node", format: "esm",
        outdir: join(directory, "dist"), naming: "terraform.mjs" });
      expect(bundle.success).toBe(true);
      const result = spawnSync("node", ["--input-type=module", "-e", `
        import { terraformAssets } from ${JSON.stringify(pathToFileURL(join(directory, "dist/terraform.mjs")).href)};
        try {
          await terraformAssets(${JSON.stringify(invalid)});
        } catch (error) { console.error(error.message); process.exitCode = 1; }
      `], { cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Terraform GPG fingerprint must be 40 uppercase hexadecimal characters");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("propagates a validation rejection with its message", async () => {
    await expect(terraformAssets(invalid)).rejects.toThrow("Terraform GPG fingerprint must be 40 uppercase hexadecimal characters");
  });

  test("reports filesystem failures as rejections", async () => {
    await expect(terraformAssets({ ...invalid, directory: "/nonexistent-terraform-assets", fingerprint: "A".repeat(40) }))
      .rejects.toMatchObject({ name: "Rejection" });
  });
});

describe("release helper command line entries", () => {
  const run = (script: string, args: string[], input = "") => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });

  test.each([
    ["src/release-build/main.ts", ["unknown"], "", "usage: release-build package|raw|terraform"],
    ["src/release-build/main.ts", ["package"], "", "usage: release-build package SOURCE_DIRECTORY DESTINATION"],
    ["src/release-assets-verify/main.ts", [], "", "usage: release-assets-verify"],
    ["src/release-assets-verify/main.ts", ["verify", ".", "test", "1.2.3", "1", "invalid"], "{}", "40 uppercase hexadecimal characters"],
  ])("%s %j exits 1 with its message", (script, args, input, message) => {
    const result = run(script, args, input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
