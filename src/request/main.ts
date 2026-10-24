import * as core from "@actions/core";
import { github, splitRepository } from "../lib/github.ts";
import { buildLabel } from "../lib/request.ts";

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
  const server = core.getInput("server-repository", { required: true });
  const label = buildLabel(core.getInput("kind", { required: true }), repository, core.getInput("args", { required: true }).split("/"));
  const gh = github(core.getInput("github-token", { required: true }));
  await gh.rest.issues.createLabel({ ...splitRepository(server), ...label, color: "1f6feb" });
  core.setOutput("label", label.name);
  core.info(`created label ${label.name} (${label.description}) in ${server}`);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
