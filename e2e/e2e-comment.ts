// Handles the /e2e pull request comment for e2e-comment.yml, which runs from the default branch.
//   bun e2e/e2e-comment.ts authorize|report
// Inputs come from the environment so that comment text is never interpolated into a shell.
import * as core from "@actions/core";
import { github, splitRepository, type GitHub } from "../src/lib/github.ts";
import { FEATURES, type Feature } from "./pr-metadata.ts";

// Immutable IDs allowed to run live e2e: the repository owner civitaspo.
export const ALLOWED_IDS: readonly number[] = [4525500];

const SYNTAX = "/e2e --feature <feature>[,<feature>...] [--scenario <name substring>]";
const COMMAND = /^\/e2e --feature ([a-z-]+(?:,[a-z-]+)*)(?: --scenario ([^\p{Cc}]{1,200}))?\s*$/u;

export type Command = { features: Feature[]; scenario: string };
export type Parsed = { ok: true; command: Command } | { ok: false; error: string };

export function parseCommand(body: string): Parsed {
  const m = COMMAND.exec(body);
  if (!m) return { ok: false, error: `the comment must be exactly \`${SYNTAX}\`.` };
  const names = [...new Set(m[1]!.split(","))];
  const unknown = names.find((name) => !(FEATURES as readonly string[]).includes(name));
  if (unknown !== undefined) return { ok: false, error: `unknown feature \`${unknown}\`. Known: ${FEATURES.join(", ")}.` };
  return { ok: true, command: { features: names as Feature[], scenario: (m[2] ?? "").trim() } };
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
  core.setOutput("ref", pr.head.sha);
  core.setOutput("feature", parsed.command.features.join(","));
  core.setOutput("scenario", parsed.command.scenario);
  core.setOutput("harness", harness);
  core.setOutput("harness-ref", harness === "pr" ? pr.head.sha : "");
}

export async function report(gh: GitHub): Promise<void> {
  const repo = splitRepository(env("REPO"));
  const result = env("RESULT");
  const passed = result === "success";
  const command: Command = { features: env("FEATURE").split(",") as Feature[], scenario: process.env.SCENARIO ?? "" };
  try {
    await gh.rest.reactions.createForIssueComment({ ...repo, comment_id: Number(env("COMMENT_ID")), content: passed ? "rocket" : "-1" });
    await gh.rest.issues.createComment({ ...repo, issue_number: Number(env("PR")),
      body: `e2e ${scope(command)} at \`${env("REF")}\` (harness: ${env("HARNESS")}): **${passed ? "pass" : `fail (${result})`}**. Run: ${env("RUN_URL")}` });
  } finally {
    await gh.rest.repos.createDeploymentStatus({ ...repo, deployment_id: Number(env("DEPLOYMENT_ID")), state: passed ? "success" : result === "cancelled" ? "error" : "failure", description: `e2e ${result}`, log_url: env("RUN_URL"), auto_inactive: false });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "authorize") await authorize(github(env("GH_TOKEN")));
  else if (mode === "report") await report(github(env("GH_TOKEN")));
  else throw new Error("usage: bun e2e/e2e-comment.ts authorize|report");
}
