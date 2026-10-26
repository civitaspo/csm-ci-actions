import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Rejection } from "../lib/request.ts";

export type TerraformVerification = { version: string; sourceDateEpoch: string; fingerprint: string; publicKey: string };

export async function terraformAssets(input: {
  directory: string;
  providerName: string;
  version: string;
  sourceDateEpoch: string;
  fingerprint: string;
  credentials: { mode: "prepare"; privateKey: string; passphrase: string } | { mode: "verify"; publicKey: string };
}): Promise<string> {
  // Source tests run from src/release/; bundled Node actions run from dist/.
  const root = import.meta.url.endsWith(".ts") ? "../../" : "../";
  const helper = fileURLToPath(new URL(`${root}actions/server/release-assets/terraform.py`, import.meta.url));
  const credentials = input.credentials.mode === "prepare"
    ? { key: input.credentials.privateKey, passphrase: input.credentials.passphrase }
    : { key: input.credentials.publicKey };
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn("python3", ["-B", helper, input.credentials.mode, resolve(input.directory), input.providerName,
      input.version, input.sourceDateEpoch, input.fingerprint], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? accept(stdout) : reject(new Rejection(stderr.trim() || "Terraform asset validation failed")));
    child.stdin.on("error", () => { /* The exit handler reports a helper that rejected its input. */ });
    child.stdin.end(JSON.stringify(credentials));
  });
  return z.strictObject({ publicKey: z.string().min(1) }).parse(JSON.parse(output)).publicKey;
}
