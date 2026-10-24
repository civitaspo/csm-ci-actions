import { ReleaseSchema, type Release } from "../lib/config.ts";
import { type GitHub, splitRepository } from "../lib/github.ts";
import { Rejection } from "../lib/request.ts";
import { parseSemVer } from "./semver.ts";
import { z } from "zod";

export type ReleasePlan = {
  repository: string;
  pullNumber: number;
  mergeSha: string;
  tag: string;
  version: string;
  serverBotId: number;
  serverBotLogin: string;
  tagExists: boolean;
  privateRepository: boolean;
  release: Release;
  prerelease: boolean;
};

export type ReleasePlanInput = {
  repository: string;
  pullNumber: number;
  serverBotId: number;
  release: Release;
};

export const ReleasePlanSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  pullNumber: z.number().int().positive(),
  mergeSha: z.string().regex(/^[a-f0-9]{40}$/i),
  tag: z.string().min(2),
  version: z.string().refine((version) => parseSemVer(version) !== undefined),
  serverBotId: z.number().int().positive(),
  serverBotLogin: z.string().min(1),
  tagExists: z.boolean(),
  privateRepository: z.boolean(),
  release: ReleaseSchema,
  prerelease: z.boolean(),
});

export async function planRelease(gh: GitHub, input: ReleasePlanInput): Promise<ReleasePlan> {
  const repo = splitRepository(input.repository);
  const [{ data: repository }, { data: pull }] = await Promise.all([
    gh.rest.repos.get(repo),
    gh.rest.pulls.get({ ...repo, pull_number: input.pullNumber }),
  ]);
  if (!pull.merged_at) throw new Rejection(`release pull request ${input.pullNumber} is not merged`);
  const mergedBy = pull.merged_by;
  if (!mergedBy || Number(mergedBy.id) !== input.serverBotId) throw new Rejection(`release pull request ${input.pullNumber} was not merged by the Server bot`);
  if (pull.head.repo?.full_name?.toLowerCase() !== input.repository.toLowerCase()) {
    throw new Rejection("release pull request head repository is not the managed repository");
  }
  if (pull.base.repo.full_name.toLowerCase() !== input.repository.toLowerCase()) {
    throw new Rejection("release pull request base repository is not the managed repository");
  }
  if (pull.head.ref !== "release/next") throw new Rejection(`release pull request head is ${pull.head.ref}, not release/next`);
  if (pull.base.ref !== repository.default_branch) {
    throw new Rejection(`release pull request base is ${pull.base.ref}, not the default branch ${repository.default_branch}`);
  }
  const mergeSha = pull.merge_commit_sha;
  if (!mergeSha) throw new Rejection(`release pull request ${input.pullNumber} has no merge commit`);
  const versionData = await gh.rest.repos.getContent({ ...repo, path: ".release-version", ref: mergeSha, mediaType: { format: "raw" } });
  const versionText = z.string().safeParse(versionData.data);
  if (!versionText.success) throw new Rejection(".release-version at the merge commit is not a file");
  const version = versionText.data.trim();
  const semver = parseSemVer(version);
  if (!semver) throw new Rejection(`.release-version ${JSON.stringify(version)} is not semver`);
  const tag = `v${version}`;
  const existingTag = await verifyReleaseTag(gh, repo, tag, { id: input.serverBotId, login: mergedBy.login }, mergeSha);
  const existingRelease = await getReleaseByTag(gh, repo, tag);
  if (existingRelease && Number(existingRelease.author?.id) !== input.serverBotId) {
    throw new Rejection(`release ${tag} already exists and was not created by the Server bot`);
  }
  if (existingRelease && !existingTag) throw new Rejection(`release ${tag} exists without its server-made tag`);
  return {
    repository: input.repository,
    pullNumber: input.pullNumber,
    mergeSha,
    tag,
    version,
    serverBotId: input.serverBotId,
    serverBotLogin: mergedBy.login,
    tagExists: existingTag,
    privateRepository: repository.private,
    release: input.release,
    prerelease: version.includes("-"),
  };
}

export async function verifyReleaseTag(
  gh: GitHub,
  repo: ReturnType<typeof splitRepository>,
  tagName: string,
  bot: { id: number; login: string },
  mergeSha: string,
): Promise<boolean> {
  let ref;
  try {
    ({ data: ref } = await gh.rest.git.getRef({ ...repo, ref: `tags/${tagName}` }));
  } catch (error) {
    if (status(error) === 404) return false;
    throw error;
  }
  if (ref.object.type !== "tag") throw new Rejection(`tag ${tagName} is not an annotated tag created by the Server bot`);
  const { data: annotated } = await gh.rest.git.getTag({ ...repo, tag_sha: ref.object.sha });
  const tagger = annotated.tagger;
  const botEmail = `${bot.id}+${bot.login}@users.noreply.github.com`;
  if (annotated.tag !== tagName || tagger?.name !== bot.login || tagger.email !== botEmail) {
    throw new Rejection(`tag ${tagName} was not created by the Server bot`);
  }
  if (annotated.object.type !== "commit" || annotated.object.sha !== mergeSha) {
    throw new Rejection(`tag ${tagName} points to a different commit`);
  }
  return true;
}

async function getReleaseByTag(gh: GitHub, repo: ReturnType<typeof splitRepository>, tag: string) {
  try {
    const { data } = await gh.rest.repos.getReleaseByTag({ ...repo, tag });
    return data;
  } catch (error) {
    if (status(error) === 404) return undefined;
    throw error;
  }
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}
