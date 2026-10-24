import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const Id = z.number().int().positive();
const Login = z.string().min(1);
const Principal = z.strictObject({ id: Id, login: Login });
export type Principal = z.infer<typeof Principal>;

const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
  .transform((s) => s.toLowerCase());
const Owner = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/)
  .transform((s) => s.toLowerCase());

export const OPS = ["approve", "merge", "policy-check", "securefix", "release"] as const;
export type Op = (typeof OPS)[number];

export const PolicySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("signed-commits") }),
  z.strictObject({ type: z.literal("trusted-committers") }),
  z.strictObject({ type: z.literal("sensitive-paths"), paths: z.array(z.string().min(1)), exempt: z.array(Principal).default([]) }),
]);
export type Policy = z.infer<typeof PolicySchema>;

const RepositoryEntry = z.strictObject({
  name: z.string().min(1).transform((s) => s.toLowerCase()),
  ops: z.array(z.enum(OPS)).refine((ops) => new Set(ops).size === ops.length, "duplicate op"),
});

export const ConfigSchema = z
  .strictObject({
    owners: z.array(Owner).min(1),
    server_repository: RepoName,
    apps: z.strictObject({ client_bot_id: Id, server_app_id: Id, server_bot_id: Id }),
    approver: Principal,
    trust: z.strictObject({ committers: z.array(Principal), approvers: z.array(Principal) }),
    policies: z.array(PolicySchema),
    repositories: z.array(RepositoryEntry).min(1),
  })
  .superRefine((c, ctx) => {
    for (const list of ["committers", "approvers"] as const) {
      if (c.trust[list].some((p) => p.id === c.apps.server_bot_id || p.id === c.approver.id)) {
        ctx.addIssue({ code: "custom", path: ["trust", list], message: "the server and approver bots must not be in a trust list" });
      }
    }
    const [serverOwner] = c.server_repository.split("/");
    if (!c.owners.includes(serverOwner ?? "")) {
      ctx.addIssue({ code: "custom", path: ["server_repository"], message: "server_repository owner must be listed in owners" });
    }
  });
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(text: string): Config {
  return ConfigSchema.parse(parseYaml(text));
}

// First matching entry wins, so a specific name can be listed before a broader glob.
export function repositoryEntry(config: Config, fullName: string): Config["repositories"][number] | undefined {
  const name = fullName.toLowerCase();
  const [owner] = name.split("/");
  if (!config.owners.includes(owner ?? "")) return undefined;
  return config.repositories.find((r) => picomatch.isMatch(name, r.name, { dot: true }));
}
