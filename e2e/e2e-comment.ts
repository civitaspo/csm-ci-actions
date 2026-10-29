// Handles the /e2e pull request comment for e2e-comment.yml, which runs from the default branch.
//   bun e2e/e2e-comment.ts authorize|report
// Inputs come from the environment so that comment text is never interpolated into a shell.
import * as core from "@actions/core";
import { github, splitRepository, type GitHub } from "../src/lib/github.ts";
import { FEATURES, type Feature } from "./pr-metadata.ts";

// Immutable IDs allowed to run live e2e: the repository owner civitaspo.
export const ALLOWED_IDS: readonly number[] = [4525500];

const SYNTAX = "/e2e --feature <feature>[,<feature>...] [--scenario <name substring>] or /e2e --cancel [<run-id>]";
const COMMAND = /^\/e2e --feature ([a-z-]+(?:,[a-z-]+)*)(?: --scenario ([^\p{Cc}]{1,200}))?\s*$/u;
const CANCEL_COMMAND = /^\/e2e --cancel(?: ([1-9][0-9]{0,19}))?\s*$/u;
const WORKFLOW_PATH = ".github/workflows/e2e-comment.yml";
const ACTIONS_BOT_ID = 41898282;
const LABEL_PREFIX = "e2e-cancel-";

export type Command = { features: Feature[]; scenario: string };
export type Parsed = { ok: true; command: Command } | { ok: true; cancelRunId?: number } | { ok: false; error: string };

export function parseCommand(body: string): Parsed {
  const cancel = CANCEL_COMMAND.exec(body);
  if (cancel) {
    if (cancel[1] === undefined) return { ok: true };
    const runId = Number(cancel[1]);
    return Number.isSafeInteger(runId) ? { ok: true, cancelRunId: runId } : { ok: false, error: "the run ID must be a positive safe integer." };
  }
  if (/^\/e2e --cancel\s*$/u.test(body)) return { ok: true };
  const m = COMMAND.exec(body);
  if (!m) return { ok: false, error: `the comment must be exactly \`${SYNTAX}\`.` };
  const names = [...new Set(m[1]!.split(","))];
  const unknown = names.find((name) => !(FEATURES as readonly string[]).includes(name));
  if (unknown !== undefined) return { ok: false, error: `unknown feature \`${unknown}\`. Known: ${FEATURES.join(", ")}.` };
  return { ok: true, command: { features: names as Feature[], scenario: (m[2] ?? "").trim() } };
}

export type CancellationTarget = {
  id: number;
  run_attempt: number;
  event: string;
  path: string;
  workflow_id: number;
  status: string;
  repository: { full_name: string } | null;
};

export type CancellationJob = { name: string; status: string };

function activeStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "waiting" || status === "in_progress";
}

export function validateCancellationTarget(input: {
  run: CancellationTarget;
  jobs: readonly CancellationJob[];
  expectedRunId: number;
  expectedWorkflowId: number;
  repository: string;
  prNumber: number;
  comments: readonly { user: { id: number } | null; body: string }[];
  serverUrl: string;
}): string | undefined {
  const { run } = input;
  if (run.id !== input.expectedRunId) return "the run ID does not match the requested run.";
  if (run.event !== "issue_comment" || run.path !== WORKFLOW_PATH || run.workflow_id !== input.expectedWorkflowId) {
    return "the run is not an e2e-comment workflow run.";
  }
  if (run.repository?.full_name.toLowerCase() !== input.repository.toLowerCase()) return "the run belongs to a different repository.";
  if (!activeStatus(run.status)) return "the run is no longer active.";
  const e2eJob = input.jobs.find((job) => job.name === "e2e");
  if (!e2eJob || !activeStatus(e2eJob.status)) return "the e2e job is no longer active.";

  const runUrl = `${input.serverUrl}/${input.repository}/actions/runs/${run.id}`;
  const associated = input.comments.some(({ user, body }) => user?.id === ACTIONS_BOT_ID
    && body.includes(`e2e started for `)
    && body.match(/(?:^|\s)Run: (\S+)/u)?.[1] === runUrl);
  if (!associated) return `no e2e start receipt for run ${run.id} exists on this pull request.`;
  return undefined;
}

export type CancellationCandidate = { runId: number; attempt?: number; status: "active" | "finished" | "unverified" };

export function selectCancellationCandidate(candidates: readonly CancellationCandidate[], requestedRunId?: number): { ok: true; candidate: CancellationCandidate } | { ok: false; error: string } {
  if (requestedRunId !== undefined) {
    const candidate = candidates.find(({ runId }) => runId === requestedRunId);
    if (!candidate) return { ok: false, error: `run ${requestedRunId} has no trusted e2e start receipt on this pull request.` };
    if (candidate.status === "finished") return { ok: false, error: `run ${requestedRunId} is no longer active.` };
    if (candidate.status === "unverified") return { ok: false, error: `run ${requestedRunId} could not be verified as an active e2e run.` };
    return { ok: true, candidate };
  }

  const unresolved = candidates.find(({ status }) => status === "unverified");
  if (unresolved) return { ok: false, error: `run ${unresolved.runId} has an e2e start receipt but its active state could not be verified.` };
  const active = candidates.filter(({ status }) => status === "active");
  if (active.length === 0) return { ok: false, error: "no active e2e run with a trusted start receipt was found on this pull request." };
  if (active.length > 1) return { ok: false, error: `found ${active.length} active e2e runs; specify a run ID to choose one.` };
  return { ok: true, candidate: active[0]! };
}

export async function findCancellationTarget(gh: ReturnType<typeof github>, repository: string, prNumber: number, serverUrl: string, requestedRunId?: number): Promise<{ ok: true; target: { runId: number; attempt: number } } | { ok: false; error: string }> {
  const repo = splitRepository(repository);
  const { data: workflow } = await gh.rest.actions.getWorkflow({ ...repo, workflow_id: WORKFLOW_PATH });
  const comments = await gh.paginate(gh.rest.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 });
  const prefix = `${serverUrl}/${repository}/actions/runs/`;
  const runIds = [...new Set(comments.flatMap(({ user, body }) => {
    if (Number(user?.id) !== ACTIONS_BOT_ID || !body?.includes("e2e started for ")) return [];
    const url = body.match(/Run: (\S+)/u)?.[1];
    if (!url?.startsWith(prefix)) return [];
    const suffix = url.slice(prefix.length);
    return /^[1-9][0-9]{0,19}$/u.test(suffix) && Number.isSafeInteger(Number(suffix)) ? [Number(suffix)] : [];
  }))];
  const candidates: CancellationCandidate[] = [];
  const attempts = new Map<number, number>();
  for (const runId of runIds) {
    let run;
    try {
      ({ data: run } = await gh.rest.actions.getWorkflowRun({ ...repo, run_id: runId }));
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        candidates.push({ runId, status: "finished" });
        continue;
      }
      candidates.push({ runId, status: "unverified" });
      continue;
    }
    if (run.status === "completed") {
      candidates.push({ runId, status: "finished" });
      continue;
    }
    if (!activeStatus(run.status ?? "")) {
      candidates.push({ runId, status: "unverified" });
      continue;
    }
    if (typeof run.run_attempt !== "number" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
      candidates.push({ runId, status: "unverified" });
      continue;
    }
    try {
      const jobs = await gh.paginate(gh.rest.actions.listJobsForWorkflowRunAttempt, { ...repo, run_id: runId, attempt_number: run.run_attempt, per_page: 100 });
      const invalid = validateCancellationTarget({
        run: run as CancellationTarget,
        jobs: jobs.map(({ name, status }) => ({ name, status })),
        expectedRunId: runId,
        expectedWorkflowId: workflow.id,
        repository,
        prNumber,
        comments: comments.map((comment) => ({ user: comment.user ? { id: Number(comment.user.id) } : null, body: comment.body ?? "" })),
        serverUrl,
      });
      if (invalid) candidates.push({ runId, status: "unverified" });
      else {
        attempts.set(runId, run.run_attempt);
        candidates.push({ runId, attempt: run.run_attempt, status: "active" });
      }
    } catch {
      candidates.push({ runId, status: "unverified" });
    }
  }
  const selected = selectCancellationCandidate(candidates, requestedRunId);
  if (!selected.ok) return selected;
  const attempt = attempts.get(selected.candidate.runId) ?? selected.candidate.attempt;
  if (attempt === undefined) return { ok: false, error: `run ${selected.candidate.runId} has no verified active attempt.` };
  return { ok: true, target: { runId: selected.candidate.runId, attempt } };
}

export async function requestCancellation(gh: ReturnType<typeof github>, repository: string, prNumber: number, target: { runId: number; attempt: number }, serverUrl: string): Promise<void> {
  const current = await findCancellationTarget(gh, repository, prNumber, serverUrl, target.runId);
  if (!current.ok) throw new Error(current.error);
  if (current.target.attempt !== target.attempt) throw new Error(`run ${target.runId} changed attempts before the cancellation request`);
  const repo = splitRepository(repository);
  const label = cancellationLabel(target.runId, target.attempt);
  const description = cancellationDescription(prNumber, target.attempt);
  try {
    await gh.rest.issues.createLabel({ ...repo, name: label, description, color: "d73a4a" });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 422) throw error;
    const { data: existing } = await gh.rest.issues.getLabel({ ...repo, name: label });
    if (existing.description !== description) throw new Error(`a cancellation request for run ${target.runId} already exists with different ownership metadata`);
  }
}

export function cancellationLabel(runId: number, attempt: number): string {
  return `${LABEL_PREFIX}${runId}-${attempt}`;
}

export function cancellationDescription(prNumber: number, attempt: number): string {
  return `pr=${prNumber};attempt=${attempt}`;
}

export type CommitFacts = { verified: boolean; authorId: number | undefined };

// The PR's own harness receives the e2e credentials only for the owner's verified commits on a branch of this repository.
export function chooseHarness(input: { repository: string; headRepository: string | undefined; commits: readonly CommitFacts[]; ownerId: number }): "pr" | "main" {
  if (input.headRepository !== input.repository) return "main";
  const own = input.commits.every((c) => c.verified && c.authorId === input.ownerId);
  return input.commits.length > 0 && own ? "pr" : "main";
}

export function scope(command: Command): string {
  const features = `\`${command.features.join(",")}\``;
  return command.scenario === "" ? features : `${features}, scenarios containing \`${command.scenario}\``;
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

export async function authorize(gh: GitHub): Promise<void> {
  const repository = env("REPO");
  const repo = splitRepository(repository);
  const number = Number(env("PR"));
  const reply = async (body: string) => { await gh.rest.issues.createComment({ ...repo, issue_number: number, body }); };
  const reject = async (error: string | undefined) => {
    if (error !== undefined) await reply(`e2e rejected: ${error}`);
    core.setOutput("ok", "false");
  };

  if (!ALLOWED_IDS.includes(Number(env("COMMENTER_ID")))) {
    console.log(`commenter ${env("COMMENTER_ID")} is not allowed to run e2e`);
    return reject(undefined);
  }
  const parsed = parseCommand(env("BODY"));
  if (!parsed.ok) return reject(parsed.error);
  const { data: pr } = await gh.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== "open") return reject("the pull request is not open.");
  if (!("command" in parsed)) {
    const selected = await findCancellationTarget(gh, repository, number, env("SERVER_URL"), parsed.cancelRunId);
    if (!selected.ok) return reject(selected.error);
    const { runId, attempt } = selected.target;
    await requestCancellation(gh, repository, number, selected.target, env("SERVER_URL"));
    await gh.rest.reactions.createForIssueComment({ ...repo, comment_id: Number(env("COMMENT_ID")), content: "eyes" });
    await reply(`e2e cancellation requested for run ${runId}, attempt ${attempt}. The active scenario will finish and cleanup must succeed before the run releases its lock. Run: ${env("SERVER_URL")}/${repository}/actions/runs/${runId}`);
    core.setOutput("ok", "true");
    core.setOutput("cancel", "true");
    core.setOutput("target-run-id", String(runId));
    core.setOutput("target-run-attempt", String(attempt));
    return;
  }
  const commits = (await gh.paginate(gh.rest.pulls.listCommits, { ...repo, pull_number: number, per_page: 100 }))
    .map((c): CommitFacts => ({ verified: c.commit.verification?.verified === true, authorId: c.author ? Number(c.author.id) : undefined }));
  const harness = chooseHarness({ repository, headRepository: pr.head.repo?.full_name, commits, ownerId: ALLOWED_IDS[0]! });

  await gh.rest.reactions.createForIssueComment({ ...repo, comment_id: Number(env("COMMENT_ID")), content: "eyes" });
  await reply(`e2e started for ${scope(parsed.command)} at \`${pr.head.sha}\` (harness: ${harness}). Run: ${env("RUN_URL")}`);
  const { data: deployment } = await gh.rest.repos.createDeployment({ ...repo, ref: pr.head.sha, environment: "csm-ci-e2e", auto_merge: false, required_contexts: [], production_environment: false });
  if (!("id" in deployment)) throw new Error(`deployment was not created: ${deployment.message ?? "unknown response"}`);
  await gh.rest.repos.createDeploymentStatus({ ...repo, deployment_id: Number(deployment.id), state: "in_progress", log_url: env("RUN_URL"), auto_inactive: false });
  core.setOutput("ok", "true");
  core.setOutput("deployment-id", Number(deployment.id));
  core.setOutput("cancel", "false");
  core.setOutput("ref", pr.head.sha);
  core.setOutput("feature", parsed.command.features.join(","));
  core.setOutput("scenario", parsed.command.scenario);
  core.setOutput("harness", harness);
  core.setOutput("harness-ref", harness === "pr" ? pr.head.sha : "");
}

export async function report(gh: GitHub): Promise<void> {
  const repo = splitRepository(env("REPO"));
  const result = env("RESULT");
  const cancelled = result === "cancelled";
  const passed = result === "success";
  const command: Command = { features: env("FEATURE").split(",") as Feature[], scenario: process.env.SCENARIO ?? "" };
  try {
    await gh.rest.reactions.createForIssueComment({ ...repo, comment_id: Number(env("COMMENT_ID")), content: cancelled ? "confused" : passed ? "rocket" : "-1" });
    const failureHelp = passed || cancelled ? "" : " Cancellation or cleanup may leave the e2e lock held; inspect the run logs for cleanup and related workflow diagnostics.";
    await gh.rest.issues.createComment({ ...repo, issue_number: Number(env("PR")),
      body: `e2e ${scope(command)} at \`${env("REF")}\` (harness: ${env("HARNESS")}): **${cancelled ? "cancelled after cleanup" : passed ? "pass" : `fail (${result})`}**.${failureHelp} Run: ${env("RUN_URL")}` });
  } finally {
    await gh.rest.repos.createDeploymentStatus({ ...repo, deployment_id: Number(env("DEPLOYMENT_ID")), state: passed ? "success" : cancelled ? "error" : "failure", description: `e2e ${result}`, log_url: env("RUN_URL"), auto_inactive: false });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "authorize") await authorize(github(env("GH_TOKEN")));
  else if (mode === "report") await report(github(env("GH_TOKEN")));
  else throw new Error("usage: bun e2e/e2e-comment.ts authorize|report");
}
