import * as core from "@actions/core";
import { ReleaseSchema } from "../lib/config.ts";
import { github, splitRepository } from "../lib/github.ts";
import { planRelease } from "../release/plan.ts";
import { CARGO_RUNNERS } from "../release/runners.ts";

async function main(): Promise<void> {
  const repository = core.getInput("repository", { required: true });
  const pullNumber = Number(core.getInput("pull-number", { required: true }));
  const serverBotId = Number(core.getInput("server-bot-id", { required: true }));
  const release = ReleaseSchema.parse(JSON.parse(core.getInput("release-config", { required: true })));
  const plan = await planRelease(github(core.getInput("github-token", { required: true })), { repository, pullNumber, serverBotId, release });
  const { owner, repo } = splitRepository(repository);
  const matrix = release.build_type === "cargo" || release.build_type === "cargo-raw"
    ? release.targets.map((target) => ({ target, runner: CARGO_RUNNERS[target] }))
    : [{ target: "", runner: "ubuntu-24.04" }];
  core.setOutput("plan", JSON.stringify(plan));
  core.setOutput("repository-owner", owner);
  core.setOutput("repository-name", repo);
  core.setOutput("merge-sha", plan.mergeSha);
  core.setOutput("tag", plan.tag);
  core.setOutput("version", plan.version);
  core.setOutput("build-type", release.build_type);
  core.setOutput("tag-exists", String(plan.tagExists));
  core.setOutput("matrix", JSON.stringify(matrix));
  core.info(`planned ${plan.tag} from ${repository}@${plan.mergeSha}`);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
