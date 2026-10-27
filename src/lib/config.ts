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

export const CARGO_TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
] as const;
export const CARGO_RAW_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
] as const;
export const ReleaseSchema = z.discriminatedUnion("build_type", [
  z.strictObject({ build_type: z.literal("none") }),
  z.strictObject({ build_type: z.literal("js-action") }),
  z.strictObject({ build_type: z.literal("goreleaser") }),
  z.strictObject({
    build_type: z.literal("terraform-provider"),
    provider_name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/u, "provider_name must be lowercase alphanumeric with single internal hyphens"),
  }),
  z.strictObject({
    build_type: z.literal("cargo"),
    targets: z.array(z.enum(CARGO_TARGETS)).min(1).refine((targets) => new Set(targets).size === targets.length, "duplicate cargo target"),
  }),
  z.strictObject({
    build_type: z.literal("cargo-raw"),
    binary: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u, "binary must be a safe Cargo binary name of at most 64 characters"),
    targets: z.array(z.enum(CARGO_RAW_TARGETS)).min(1).refine((targets) => new Set(targets).size === targets.length, "duplicate cargo-raw target"),
  }),
]);
export type Release = z.infer<typeof ReleaseSchema>;

export const OPS = ["approve", "merge", "policy-check", "securefix", "release"] as const;
export type Op = (typeof OPS)[number];

export const PolicySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("signed-commits") }),
  z.strictObject({ type: z.literal("trusted-committers") }),
  z.strictObject({ type: z.literal("sensitive-paths"), paths: z.array(z.string().min(1)), exempt: z.array(Principal).default([]) }),
]);
export type Policy = z.infer<typeof PolicySchema>;

const SecurefixPathRule = z.enum(["any", "semver", "version-only"]);
const SecurefixRoute = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  from: z.literal("default"),
  to: z.string().min(1).refine((branch) => branch !== "default" && isSecurefixBranch(branch), "must be a safe branch name"),
  workflow: z.string().min(1),
  paths: z.record(z.string(), SecurefixPathRule).refine((paths) => Object.keys(paths).length > 0, "must include at least one path"),
});
export type SecurefixRoute = z.infer<typeof SecurefixRoute>;
const SecurefixSchema = z.strictObject({
  allow_workflow_changes: z.boolean(),
  routes: z.array(SecurefixRoute).refine((routes) => new Set(routes.map((route) => route.name)).size === routes.length, "duplicate route name"),
});
export type SecurefixConfig = z.infer<typeof SecurefixSchema>;

const Sponsorships = z.strictObject({
  enabled: z.boolean(),
  github: z.array(z.string().regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, "must be a GitHub recipient login").max(39).transform((login) => login.toLowerCase()))
    .min(1).max(4).refine((logins) => new Set(logins).size === logins.length, "duplicate GitHub recipient login").optional(),
});

export function repoSettingsManagedFiles(settings: { additional_managed_files: Record<string, string>; sponsorships?: z.infer<typeof Sponsorships> | undefined } | undefined, files: Record<string, string> = {}): Record<string, string> {
  const recipients = settings?.sponsorships?.github;
  return { ...files, ...(recipients ? { ".github/FUNDING.yml": `github: [${recipients.map((login) => JSON.stringify(login)).join(", ")}]\n` } : {}) };
}

const RepoSettings = z.preprocess((input, ctx) => {
  if (typeof input === "object" && input !== null && Object.hasOwn(input, "managed_files")) {
    ctx.addIssue({ code: "custom", message: "managed_files was removed: commit inline contents as Server source files and replace the key with repo_settings.additional_managed_files" });
  }
  return input;
}, z.strictObject({
  sponsorships: Sponsorships.optional(),
  settings: z.strictObject({
    delete_branch_on_merge: z.boolean().optional(),
    allow_auto_merge: z.boolean().optional(),
    allow_squash_merge: z.literal(true).optional(),
    allow_merge_commit: z.literal(false).optional(),
    allow_rebase_merge: z.literal(false).optional(),
    has_wiki: z.boolean().optional(),
    has_projects: z.boolean().optional(),
    allow_update_branch: z.boolean().optional(),
  }).optional(),
  additional_managed_files: z.record(z.string(), z.string()).default({}),
}).superRefine((value, ctx) => {
  if (value.sponsorships?.github && Object.hasOwn(value.additional_managed_files, ".github/FUNDING.yml")) {
    ctx.addIssue({ code: "custom", path: ["additional_managed_files", ".github/FUNDING.yml"], message: "destination is reserved by sponsorships.github" });
  }
  const files = repoSettingsManagedFiles(value, value.additional_managed_files);
  const paths = Object.keys(files);
  if (paths.length > 512) ctx.addIssue({ code: "custom", path: ["additional_managed_files"], message: "must contain at most 512 files" });
  for (const path of paths) {
    if (!isSafeManagedFilePath(path)) {
      ctx.addIssue({ code: "custom", path: ["additional_managed_files", path], message: "must be a safe literal relative file path" });
    }
  }
  for (const source of Object.values(value.additional_managed_files)) {
    if (!isSafeManagedFilePath(source)) ctx.addIssue({ code: "custom", path: ["additional_managed_files", source], message: "source must be a safe literal relative file path" });
  }
  for (const path of paths) {
    if (paths.some((other) => other !== path && other.startsWith(`${path}/`))) {
      ctx.addIssue({ code: "custom", path: ["additional_managed_files", path], message: "file paths must not contain a file as a directory prefix" });
    }
  }
}));
export type RepoSettingsConfig = z.infer<typeof RepoSettings>;

function isSafeManagedFilePath(path: string): boolean {
  return !/^[A-Za-z]:/u.test(path) && !path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(path) &&
    !/[?*\[\]{}!()]/u.test(path) && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

const RepositoryEntry = z.strictObject({
  name: z.string().min(1).transform((s) => s.toLowerCase()),
  ops: z.array(z.enum(OPS)).refine((ops) => new Set(ops).size === ops.length, "duplicate op"),
  release: ReleaseSchema.optional(),
  release_prepare: z.strictObject({ update_root_version: z.boolean().optional() }).optional(),
  // Removed key: reject it explicitly so older configurations fail with an actionable message.
  workflow_adoption: z.never({ error: "workflow_adoption was removed; selected standard callers are always regenerated, so delete this key" }).optional(),
  sensitive_paths: z.strictObject({ paths: z.array(z.string().min(1)).optional(), exempt: z.array(Principal).optional() }).optional(),
  merge: z.strictObject({ allow_bot_requests: z.boolean().optional() }).optional(),
}).superRefine((entry, ctx) => {
  if (entry.ops.includes("release") !== (entry.release !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["release"], message: "release settings must be present exactly when release is enabled" });
  }
});

export const ConfigSchema = z
  .strictObject({
    owners: z.array(Owner).min(1),
    server_repository: RepoName,
    apps: z.strictObject({ client_bot_id: Id, server_app_id: Id, server_bot_id: Id }),
    approver: Principal,
    trust: z.strictObject({ committers: z.array(Principal), approvers: z.array(Principal), mergers: z.array(Principal), bot_mergers: z.array(Principal) }),
    merge: z.strictObject({
      required_checks: z.array(z.strictObject({ name: z.string().min(1), app_id: Id })),
      deadline_minutes: z.number().int().positive().default(60),
    }),
    policies: z.array(PolicySchema),
    securefix: SecurefixSchema.optional(),
    repo_settings: RepoSettings.optional(),
    repositories: z.array(RepositoryEntry).min(1),
  })
  .superRefine((c, ctx) => {
    for (const list of ["committers", "approvers", "mergers", "bot_mergers"] as const) {
      if (c.trust[list].some((p) => p.id === c.apps.server_bot_id || p.id === c.approver.id)) {
      ctx.addIssue({ code: "custom", path: ["trust", list], message: "the server and approver bots must not be in a trust list" });
      }
    }
    const [serverOwner] = c.server_repository.split("/");
    if (!c.owners.includes(serverOwner ?? "")) {
      ctx.addIssue({ code: "custom", path: ["server_repository"], message: "server_repository owner must be listed in owners" });
    }
    if (c.repositories.some((r) => r.ops.includes("securefix")) && c.securefix === undefined) {
      ctx.addIssue({ code: "custom", path: ["securefix"], message: "securefix settings are required when a repository enables securefix" });
    }
    for (const [index, entry] of c.repositories.entries()) {
      const route = c.securefix?.routes.find((route) => route.name === "release-pr");
      const preparation = entry.ops.includes("securefix") && route !== undefined;
      if (preparation && (route.to !== "release/next" || route.workflow !== ".github/workflows/csm-ci-release-pr.yml")) {
        ctx.addIssue({ code: "custom", path: ["repositories", index], message: "release-pr route must use release/next and .github/workflows/csm-ci-release-pr.yml" });
      }
      if (entry.release_prepare !== undefined && !preparation) ctx.addIssue({ code: "custom", path: ["repositories", index, "release_prepare"], message: "release_prepare requires selected release preparation" });
    }
    for (const [index, route] of (c.securefix?.routes ?? []).entries()) {
      if (!isSafeSecurefixPath(route.workflow) || !route.workflow.startsWith(".github/workflows/")) {
        ctx.addIssue({ code: "custom", path: ["securefix", "routes", index, "workflow"], message: "must be a safe path under .github/workflows" });
      }
      if (route.from === route.to) {
        ctx.addIssue({ code: "custom", path: ["securefix", "routes", index], message: "from and to must be different branches" });
      }
      for (const path of Object.keys(route.paths)) {
        if (!isSafeSecurefixPath(path) || path.startsWith("!") || path.includes("!(") || path.includes("[!")) {
          ctx.addIssue({ code: "custom", path: ["securefix", "routes", index, "paths", path], message: "must be a safe relative path or glob" });
        }
      }
    }
  });
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(text: string): Config {
  return ConfigSchema.parse(parseYaml(text));
}

function isSafeSecurefixPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

function isSecurefixBranch(branch: string): boolean {
  return branch === "default" || (/^[A-Za-z0-9._/-]+$/u.test(branch) && !branch.startsWith("-") && !branch.endsWith("/") &&
    !branch.includes("..") && !branch.includes("//") && !branch.includes("@{") && branch !== "HEAD" &&
    branch.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")));
}

// First matching entry wins, so a specific name can be listed before a broader glob.
export function repositoryEntry(config: Config, fullName: string): Config["repositories"][number] | undefined {
  const name = fullName.toLowerCase();
  const [owner] = name.split("/");
  if (!config.owners.includes(owner ?? "")) return undefined;
  return config.repositories.find((r) => picomatch.isMatch(name, r.name, { dot: true }));
}
