import * as core from "@actions/core";
import { prepareAssets } from "../release/assets.ts";
import { ReleasePlanSchema } from "../release/plan-schema.ts";
import { terraformAssets } from "../release/terraform.ts";

async function main(): Promise<void> {
  const directory = core.getInput("directory", { required: true });
  const plan = ReleasePlanSchema.parse(JSON.parse(core.getInput("plan", { required: true })));
  const release = plan.release;
  const sourceDateEpoch = core.getInput("source-date-epoch");
  const fingerprint = core.getInput("gpg-fingerprint");
  let publicKey = "";
  if (release.build_type === "terraform-provider") {
    const privateKey = core.getInput("gpg-private-key", { required: true, trimWhitespace: false });
    const passphrase = core.getInput("gpg-passphrase", { required: true, trimWhitespace: false });
    core.setSecret(privateKey);
    core.setSecret(passphrase);
    publicKey = await terraformAssets({ directory, providerName: release.provider_name, version: plan.version,
      sourceDateEpoch, fingerprint, credentials: { mode: "prepare", privateKey, passphrase } });
  }
  const assets = await prepareAssets(directory, release.build_type === "terraform-provider"
    ? { ...release, version: plan.version, sourceDateEpoch, fingerprint, publicKey } : release);
  core.setOutput("gpg-public-key", publicKey);
  core.setOutput("subject-path", `${directory}/*`);
  core.setOutput("assets", JSON.stringify(assets.map(({ name, sha256 }) => ({ name, sha256 }))));
  core.info(`prepared ${assets.length} release asset${assets.length === 1 ? "" : "s"} including SHA256SUMS`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
