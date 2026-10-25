import { setTimeout as delay } from "node:timers/promises";
import { type GitHub, splitRepository } from "../lib/github.ts";
import { Rejection } from "../lib/request.ts";
import { type ReleasePlan, ReleasePlanSchema, verifyReleaseTag } from "./plan.ts";

export async function ensureReleaseTag(gh: GitHub, input: unknown): Promise<ReleasePlan> {
  const plan = ReleasePlanSchema.parse(input);
  const repo = splitRepository(plan.repository);
  if (await verifyReleaseTag(gh, repo, plan.tag, { id: plan.serverBotId, login: plan.serverBotLogin }, plan.mergeSha)) return plan;
  const tag = await gh.rest.git.createTag({
    ...repo,
    tag: plan.tag,
    message: `Release ${plan.tag}`,
    object: plan.mergeSha,
    type: "commit",
    tagger: { name: plan.serverBotLogin, email: `${plan.serverBotId}+${plan.serverBotLogin}@users.noreply.github.com` },
  });
  const verifyCreatedTag = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await delay(250 * 2 ** (attempt - 1));
      if (await verifyReleaseTag(gh, repo, plan.tag, { id: plan.serverBotId, login: plan.serverBotLogin }, plan.mergeSha)) return true;
    }
    return false;
  };
  try {
    await gh.rest.git.createRef({ ...repo, ref: `refs/tags/${plan.tag}`, sha: tag.data.sha });
  } catch (error) {
    if (status(error) !== 422) throw error;
    if (await verifyCreatedTag()) return plan;
    throw error;
  }
  if (!(await verifyCreatedTag())) {
    throw new Rejection(`tag ${plan.tag} was not created`);
  }
  return plan;
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}
