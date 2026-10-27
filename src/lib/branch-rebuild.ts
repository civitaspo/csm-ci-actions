import { randomBytes } from "node:crypto";
import { resetBranchWithLease } from "./git-ref.ts";

export const TEMPORARY_BRANCH_PREFIX = "csm-ci/tmp/";

// Rebuilds a branch on top of a source commit without the branch ever equaling the source.
// A branch that equals its base makes GitHub close or merge its open pull request, so the commit is
// built on a temporary branch and the target moves to it in one conditional ref update.
export async function rebuildBranchWithLease(input: {
  remote: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch: string;
  expectedTargetSha: string | null;
  token: string;
  temporaryName: string;
  commit: (temporaryBranch: string) => Promise<string>;
  deleteBranch: (branch: string) => Promise<void>;
}): Promise<string> {
  const temporaryBranch = `${TEMPORARY_BRANCH_PREFIX}${input.temporaryName}-${randomBytes(8).toString("hex")}`;
  try {
    await resetBranchWithLease({ remote: input.remote, sourceBranch: input.sourceBranch, targetBranch: temporaryBranch, sourceSha: input.sourceSha, expectedTargetSha: null, token: input.token });
    const commit = await input.commit(temporaryBranch);
    await resetBranchWithLease({ remote: input.remote, sourceBranch: temporaryBranch, targetBranch: input.targetBranch, sourceSha: commit, expectedTargetSha: input.expectedTargetSha, token: input.token });
    return commit;
  } finally {
    try {
      await input.deleteBranch(temporaryBranch);
    } catch (error) {
      console.warn(`could not delete temporary branch ${temporaryBranch}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
