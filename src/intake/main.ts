import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { splitRepository, github } from "../lib/github.ts";
import { runIntake } from "../lib/intake.ts";
import { concurrencyKey } from "../lib/request.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const { request, release, serverBotId } = await runIntake(github(core.getInput("github-token", { required: true })), {
    event: JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")),
    repository: env("GITHUB_REPOSITORY"),
    sha: env("GITHUB_SHA"),
    repositoryId: Number(env("GITHUB_REPOSITORY_ID")),
    runAttempt: Number(env("GITHUB_RUN_ATTEMPT")),
    configPath: core.getInput("config-path", { required: true }),
  });
  const { owner, repo } = splitRepository(request.repository);
  core.setOutput("kind", request.kind);
  core.setOutput("owner", owner);
  core.setOutput("name", repo);
  core.setOutput("args", JSON.stringify(request.args));
  core.setOutput("concurrency-key", concurrencyKey(request));
  core.setOutput("release", release ? JSON.stringify(release) : "");
  core.setOutput("server-bot-id", String(serverBotId));
  core.info(`accepted ${request.kind} for ${request.repository} ${JSON.stringify(request.args)}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
