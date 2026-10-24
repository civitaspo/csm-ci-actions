import { readFile } from "node:fs/promises";
import { type GitHub, splitRepository } from "../lib/github.ts";
import { Rejection } from "../lib/request.ts";
import { type AssetDigest, prepareAssets } from "./assets.ts";
import { type ReleasePlan, ReleasePlanSchema, verifyReleaseTag } from "./plan.ts";
import { z } from "zod";

const ExpectedAssets = z.array(z.strictObject({ name: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }));
const ReleaseSnapshot = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  author: z.object({ id: z.number() }).nullable(),
  immutable: z.boolean(),
});
const RemoteAsset = z.object({ name: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });

export async function publishRelease(
  gh: GitHub,
  input: { plan: unknown; expectedAssets: unknown; directory: string },
): Promise<void> {
  const plan = ReleasePlanSchema.parse(input.plan);
  const expected = ExpectedAssets.parse(input.expectedAssets);
  const local = await prepareAssets(input.directory);
  assertSameAssets(expected, local);
  const repo = splitRepository(plan.repository);
  let release = await findRelease(gh, repo, plan.tag);
  if (release) assertServerRelease(release, plan);
  if (!release) {
    try {
      ({ data: release } = await gh.rest.repos.createRelease({
        ...repo,
        tag_name: plan.tag,
        target_commitish: plan.mergeSha,
        name: plan.tag,
        generate_release_notes: true,
        draft: true,
        prerelease: plan.prerelease,
        make_latest: plan.makeLatest ? "true" : "false",
      }));
    } catch (error) {
      if (status(error) !== 422) throw error;
      release = await findRelease(gh, repo, plan.tag);
      if (!release) throw error;
      assertServerRelease(release, plan);
    }
  }
  if (!release) throw new Rejection(`release ${plan.tag} could not be created`);
  let snapshot = ReleaseSnapshot.parse(release);
  if (snapshot.tag_name !== plan.tag) throw new Rejection(`release ${plan.tag} resolved to unexpected tag ${snapshot.tag_name}`);
  if (!snapshot.draft) {
    await verifyPublishedRelease(gh, plan, release.id, local);
    return;
  }

  const assets = await gh.paginate(gh.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  const existing = new Map(assets.map((asset) => [asset.name, asset]));
  for (const asset of local) {
    const uploaded = existing.get(asset.name);
    if (uploaded) {
      const remote = RemoteAsset.safeParse(uploaded);
      if (!remote.success || remote.data.digest !== `sha256:${asset.sha256}`) {
        throw new Rejection(`release asset ${asset.name} already exists with a different or unavailable digest`);
      }
      continue;
    }
    await gh.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name: asset.name,
      data: await readFile(asset.path),
      headers: { "content-type": "application/octet-stream" },
    });
  }
  await assertRemoteAssets(gh, repo, release.id, local);
  ({ data: release } = await gh.rest.repos.updateRelease({ ...repo, release_id: release.id, draft: false }));
  snapshot = ReleaseSnapshot.parse(release);
  if (snapshot.draft) throw new Rejection(`release ${plan.tag} is still a draft after publishing`);
  await verifyPublishedRelease(gh, plan, release.id, local);
}

async function verifyPublishedRelease(gh: GitHub, plan: ReleasePlan, releaseId: number, expected: AssetDigest[]): Promise<void> {
  const repo = splitRepository(plan.repository);
  const { data: release } = await gh.rest.repos.getRelease({ ...repo, release_id: releaseId });
  const snapshot = ReleaseSnapshot.parse(release);
  assertServerRelease(release, plan);
  if (snapshot.tag_name !== plan.tag || snapshot.draft) throw new Rejection(`release ${plan.tag} is not published`);
  if (!snapshot.immutable) throw new Rejection(`release ${plan.tag} is not immutable`);
  await assertRemoteAssets(gh, repo, releaseId, expected);
  if (!(await verifyReleaseTag(gh, repo, plan.tag, { id: plan.serverBotId, login: plan.serverBotLogin }, plan.mergeSha))) {
    throw new Rejection(`tag ${plan.tag} is missing after release`);
  }
}

async function assertRemoteAssets(gh: GitHub, repo: ReturnType<typeof splitRepository>, releaseId: number, expected: AssetDigest[]): Promise<void> {
  const remote = await gh.paginate(gh.rest.repos.listReleaseAssets, { ...repo, release_id: releaseId, per_page: 100 });
  const parsed = remote.map((asset) => RemoteAsset.parse(asset));
  if (parsed.length !== expected.length) throw new Rejection(`release has ${parsed.length} asset(s), expected exactly ${expected.length}`);
  const expectedByName = new Map(expected.map((asset) => [asset.name, asset.sha256]));
  for (const asset of parsed) {
    if (expectedByName.get(asset.name) !== asset.digest.slice("sha256:".length)) {
      throw new Rejection(`release asset ${asset.name} has an unexpected digest`);
    }
  }
}

function assertSameAssets(expected: z.infer<typeof ExpectedAssets>, actual: AssetDigest[]): void {
  if (expected.length !== actual.length) throw new Rejection("release asset manifest does not match the build outputs");
  const actualByName = new Map(actual.map((asset) => [asset.name, asset.sha256]));
  if (expected.some(({ name, sha256 }) => actualByName.get(name) !== sha256)) {
    throw new Rejection("release asset manifest does not match the build outputs");
  }
}

function assertServerRelease(release: unknown, plan: ReleasePlan): void {
  const parsed = z.object({ author: z.object({ id: z.number() }).nullable(), tag_name: z.string() }).parse(release);
  if (parsed.author?.id !== plan.serverBotId) throw new Rejection(`release ${plan.tag} was not created by the Server bot`);
  if (parsed.tag_name !== plan.tag) throw new Rejection(`release ${plan.tag} points to tag ${parsed.tag_name}`);
}

async function findRelease(gh: GitHub, repo: ReturnType<typeof splitRepository>, tag: string) {
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
