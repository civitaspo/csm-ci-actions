import { resolve } from "node:path";
import { z } from "zod";
import { Rejection } from "../lib/request.ts";
import { processAssets } from "./terraform-assets.ts";

export type TerraformVerification = { version: string; sourceDateEpoch: string; fingerprint: string; publicKey: string };

export async function terraformAssets(input: {
  directory: string;
  providerName: string;
  version: string;
  sourceDateEpoch: string;
  fingerprint: string;
  credentials: { mode: "prepare"; privateKey: string; passphrase: string } | { mode: "verify"; publicKey: string };
}): Promise<string> {
  const credentials = input.credentials.mode === "prepare"
    ? { key: input.credentials.privateKey, passphrase: input.credentials.passphrase }
    : { key: input.credentials.publicKey };
  try {
    const publicKey = processAssets(input.credentials.mode, resolve(input.directory), input.providerName, input.version,
      input.sourceDateEpoch, input.fingerprint, credentials);
    return z.string().min(1).parse(publicKey);
  } catch (error) {
    if (error instanceof Rejection) throw error;
    throw new Rejection(error instanceof Error && error.message ? error.message : "Terraform asset validation failed");
  }
}
