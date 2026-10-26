import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terraformAssets } from "./terraform.ts";

describe("Terraform Registry assets", () => {
  test("the bundled Node action finds its helper outside the working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "csm-ci-terraform-bundle-"));
    try {
      const helperDirectory = join(directory, "actions/server/release-assets");
      await mkdir(helperDirectory, { recursive: true });
      await copyFile("actions/server/release-assets/terraform.py", join(helperDirectory, "terraform.py"));
      const bundle = await Bun.build({ entrypoints: [resolve("src/release/terraform.ts")], target: "node", format: "esm",
        outdir: join(directory, "dist"), naming: "terraform.mjs" });
      expect(bundle.success).toBe(true);
      const result = spawnSync("node", ["--input-type=module", "-e", `
        import { terraformAssets } from ${JSON.stringify(pathToFileURL(join(directory, "dist/terraform.mjs")).href)};
        try {
          await terraformAssets({ directory: ".", providerName: "test", version: "1.2.3", sourceDateEpoch: "1",
            fingerprint: "invalid", credentials: { mode: "verify", publicKey: "fixture public key" } });
        } catch (error) { console.error(error.message); process.exitCode = 1; }
      `], { cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Terraform GPG fingerprint must be 40 uppercase hexadecimal characters");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["release-assets", "release-build"])("validates %s without creating private keys", (action) => {
    const result = spawnSync("python3", ["-B", `actions/server/${action}/terraform_test.py`], { encoding: "utf8" });
    expect(result.stderr).toContain("OK");
    expect(result.status).toBe(0);
  });

  test("propagates a helper rejection with its message", async () => {
    await expect(terraformAssets({ directory: ".", providerName: "test", version: "1.2.3", sourceDateEpoch: "1",
      fingerprint: "invalid", credentials: { mode: "verify", publicKey: "fixture public key" } }))
      .rejects.toThrow("Terraform GPG fingerprint must be 40 uppercase hexadecimal characters");
  });
});
