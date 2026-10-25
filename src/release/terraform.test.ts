import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { terraformAssets } from "./terraform.ts";

describe("Terraform Registry assets", () => {
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
