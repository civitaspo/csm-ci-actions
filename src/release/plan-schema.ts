import { z } from "zod";
import { ReleaseSchema } from "../lib/config.ts";
import { parseSemVer } from "./semver.ts";

export const ReleasePlanSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  pullNumber: z.number().int().positive(),
  mergeSha: z.string().regex(/^[a-f0-9]{40}$/i),
  tag: z.string().min(2),
  version: z.string().refine((version) => parseSemVer(version) !== undefined),
  serverBotId: z.number().int().positive(),
  serverBotLogin: z.string().min(1),
  tagExists: z.boolean(),
  privateRepository: z.boolean(),
  release: ReleaseSchema,
  prerelease: z.boolean(),
}).refine((plan) => plan.release.build_type !== "terraform-provider" || !plan.version.includes("+"),
  "Terraform provider versions cannot contain SemVer build metadata");


export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;
