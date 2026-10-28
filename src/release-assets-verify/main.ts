import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processAssets, type Credentials } from "../release/terraform-assets.ts";

// Verifies published Terraform Registry assets; credentials arrive as JSON on stdin so they never appear in argv.
try {
  const [mode = "", directory = "", name = "", version = "", epoch = "", fingerprint = ""] = process.argv.slice(2);
  if (process.argv.length !== 8) {
    throw new Error("usage: release-assets-verify MODE DIRECTORY NAME VERSION EPOCH FINGERPRINT < credentials.json");
  }
  const credentials = JSON.parse(readFileSync(0, "utf8")) as Credentials;
  const publicKey = processAssets(mode, resolve(directory), name, version, epoch, fingerprint, credentials);
  console.log(JSON.stringify({ publicKey }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
