import * as core from "@actions/core";
import { createRequestLabel, github } from "../lib/github.ts";

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
  const server = core.getInput("server-repository", { required: true });
  const gh = github(core.getInput("github-token", { required: true }));
  const label = await createRequestLabel(gh, server, core.getInput("kind", { required: true }), repository, core.getInput("args", { required: true }).split("/"));
  core.setOutput("label", label);
  core.info(`created label ${label} in ${server}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
