import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitRefChanged extends Error {
  constructor() {
    super("git ref changed before the conditional update");
    this.name = "GitRefChanged";
  }
}

export async function resetBranchWithLease(input: {
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha: string;
  expectedTargetSha: string | null;
  token: string;
}): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha) || (input.expectedTargetSha !== null && !/^[a-f0-9]{40}$/u.test(input.expectedTargetSha))) {
    throw new Error("git ref update requires full commit shas");
  }
  const root = await mkdtemp(join(tmpdir(), "csm-ci-securefix-git-"));
  const askpass = join(root, "askpass");
  const repository = join(root, "repo.git");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_ASKPASS: askpass,
    GIT_ASKPASS_REQUIRE: "force",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CSM_CI_GIT_TOKEN: input.token,
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
  try {
    await writeFile(askpass, "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' x-access-token ;;\n  *Password*) printf '%s\\n' \"$CSM_CI_GIT_TOKEN\" ;;\n  *) exit 1 ;;\nesac\n", { mode: 0o700, flag: "wx" });
    await chmod(askpass, 0o700);
    execFileSync("git", ["init", "--bare", "--quiet", repository], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 });
    execFileSync("git", ["-C", repository, "remote", "add", "origin", input.remote], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 });
    git(["check-ref-format", `refs/heads/${input.sourceBranch}`]);
    git(["check-ref-format", `refs/heads/${input.targetBranch}`]);
    git(["fetch", "--depth=1", "--no-tags", "origin", `+refs/heads/${input.sourceBranch}:refs/remotes/origin/securefix-source`]);
    const fetchedSource = git(["rev-parse", "refs/remotes/origin/securefix-source"]);
    if (fetchedSource !== input.sourceSha) throw new GitRefChanged();
    const lease = `--force-with-lease=refs/heads/${input.targetBranch}:${input.expectedTargetSha ?? ""}`;
    try {
      git(["push", lease, "origin", `${input.sourceSha}:refs/heads/${input.targetBranch}`]);
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      if (/stale info|remote ref updated since checkout/iu.test(stderr)) throw new GitRefChanged();
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
