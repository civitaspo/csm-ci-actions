import { createHash } from "node:crypto";
import { managedDriftDispatchState, type ManagedDriftWorkflowRun } from "../lib/managed-pull.ts";
import { splitRepository, type GitHub } from "../lib/github.ts";

const REPO_SETTINGS_WORKFLOW = "csm-ci-repo-settings.yml";

export async function reconcileManagedDrift(input: {
  configReader: GitHub;
  serverRepository: string;
  defaultBranch: string;
  repository: string;
  mergeCommit: string;
  reason?: string;
  now?: () => Date;
  pause?: (milliseconds: number) => Promise<void>;
}): Promise<string> {
  const { owner, repo } = splitRepository(input.serverRepository);
  const now = input.now ?? (() => new Date());
  const pause = input.pause ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const detail = input.reason ?? "merged tree differs from the accepted managed manifest";
  const readDispatchState = async (notBefore?: Date) => {
    const runs = await input.configReader.paginate(input.configReader.rest.actions.listWorkflowRuns, {
      owner,
      repo,
      workflow_id: REPO_SETTINGS_WORKFLOW,
      event: "workflow_dispatch",
      per_page: 100,
    });
    return managedDriftDispatchState({
      runs: runs.map((run): ManagedDriftWorkflowRun => ({
        displayTitle: run.display_title,
        headBranch: run.head_branch,
        event: run.event,
        status: run.status ?? "",
        conclusion: run.conclusion ?? null,
        actorId: run.actor?.id == null ? null : Number(run.actor.id),
        actorLogin: run.actor?.login ?? null,
        createdAt: run.created_at,
      })),
      repository: input.repository,
      mergeCommit: input.mergeCommit,
      defaultBranch: input.defaultBranch,
      now: now(),
      ...(notBefore ? { notBefore } : {}),
    });
  };

  try {
    const dispatchState = await readDispatchState();
    if (dispatchState === "already-running" || dispatchState === "already-succeeded") {
      const status = dispatchState === "already-succeeded" ? "already completed successfully" : "is already queued or running";
      return `${detail}; managed-files reconciliation ${status}`;
    }
    const driftKey = createHash("sha256").update(`${input.repository.toLowerCase()}#${input.mergeCommit}`).digest("hex");
    const dispatchStartedAt = now();
    try {
      await input.configReader.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: REPO_SETTINGS_WORKFLOW,
        ref: input.defaultBranch,
        inputs: { repository: input.repository.toLowerCase(), targets: "managed-files", "managed-drift-key": driftKey },
      });
    } catch (dispatchError) {
      let lastReadError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await pause(500);
        try {
          const recovered = await readDispatchState(dispatchStartedAt);
          if (recovered === "already-running" || recovered === "already-succeeded") {
            return `${detail}; reconciliation run was found after an ambiguous dispatch response`;
          }
          if (recovered === "previous-failed") {
            return `${detail}; reconciliation run was created but failed after an ambiguous dispatch response`;
          }
        } catch (error) {
          lastReadError = error;
        }
      }
      const writeMessage = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      const readMessage = lastReadError instanceof Error ? `; run lookup also failed: ${lastReadError.message}` : "; no matching run appeared in bounded recovery lookup";
      return `${detail}; dispatch response was ambiguous and no retry was attempted: ${writeMessage}${readMessage}`;
    }
    return `${detail}; managed-files reconciliation dispatched`;
  } catch (error) {
    const dispatchError = error instanceof Error ? error.message : String(error);
    return `${detail}; managed-files reconciliation dispatch failed: ${dispatchError}`;
  }
}
