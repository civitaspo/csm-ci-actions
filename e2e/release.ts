import { assert, CLIENT, closeReleasePrIfOwned, configureRelease, dispatch, expectOp, hasStatus, jobs, jobLog, openReleasePr, postComment, recentWorkflowRuns, SERVER, SERVER_BOT_ID, serverRuns, type Ctx, type Conclusion, type ReleaseBuildType, type Run, type Scenario, until, waitRun, withServerConfig, withoutReleaseOperation } from "./harness.ts";
import { splitRepository } from "../src/lib/github.ts";

const PREDICATE = "https://github.com/civitaspo/csm-ci-actions/attestation/release/v1";
const SIGNER = "civitaspo/csm-ci-actions/.github/workflows/server.yml";
type ReleasePr = Awaited<ReturnType<typeof openReleasePr>>;
type ReleaseRun = { run: Run; jobRows: { name: string; id: number; conclusion: string | null }[]; label: string };

function version(): string {
  return `1.0.${Date.now()}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
  return String(error);
}

async function withPr<T>(ctx: Ctx, ver: string, body: (pr: ReleasePr) => Promise<T>, additions: Record<string, string> = {}): Promise<T> {
  const pr = await openReleasePr(ctx, ver, additions);
  try {
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number } }, pr.openedAt, "success");
    return await body(pr);
  } finally {
    await closeReleasePrIfOwned(ctx, pr);
  }
}

async function mergeAsServer(ctx: Ctx, pr: ReleasePr): Promise<{ sha: string; since: Date }> {
  const comment = await postComment(ctx, pr, "/merge");
  await expectOp(ctx, { kind: "merge", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } }, comment.since, "success");
  const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
  assert(data.merged && data.merge_commit_sha, `release pull request #${pr.number} did not merge`);
  assert(Number(data.merged_by?.id) === SERVER_BOT_ID, `release pull request #${pr.number} was merged by ${data.merged_by?.login}, not the Server App`);
  return { sha: data.merge_commit_sha, since: new Date(data.merged_at ?? Date.now()) };
}

async function releaseClientRun(ctx: Ctx, since: Date, pr: ReleasePr): Promise<Run> {
  const candidate = await until(`client release request for PR #${pr.number}`, async () => {
    const runs = await recentWorkflowRuns(ctx, CLIENT, "csm-ci-release.yml", "pull_request", since);
    for (const run of runs) {
      const { data } = await ctx.gh.rest.actions.getWorkflowRun({ ...splitRepository(CLIENT), run_id: run.id });
      if (data.pull_requests?.some((item) => Number(item.number) === pr.number)) return run;
    }
    return undefined;
  });
  return waitRun(ctx, CLIENT, candidate.id);
}

async function releasePipeline(ctx: Ctx, since: Date, pr: ReleasePr, label?: string): Promise<ReleaseRun> {
  const match = { kind: "release", repository: CLIENT, args: { pull_number: pr.number }, ...(label ? { label } : {}) };
  const candidate = await until(`accepted release request for PR #${pr.number}`, async () => (await serverRuns(ctx, match, since))[0]);
  const run = await waitRun(ctx, SERVER, candidate.id);
  const { data } = await ctx.gh.rest.actions.listJobsForWorkflowRun({ ...splitRepository(SERVER), run_id: run.id });
  const jobRows = data.jobs.map((job) => ({ name: job.name.split(" / ").at(-1) ?? job.name, id: job.id, conclusion: job.conclusion }));
  const cleanup = jobRows.find((job) => job.name === "cleanup");
  assert(cleanup?.conclusion === "success", `release cleanup concluded ${cleanup?.conclusion} (${run.html_url})`);
  const cleanupLog = await jobLog(ctx, SERVER, cleanup.id);
  const cleanedLabel = /LABEL: (csm-ci-[^\s]+)/.exec(cleanupLog)?.[1];
  assert(cleanedLabel, `could not read cleaned request label from ${run.html_url}`);
  try {
    await ctx.gh.rest.issues.getLabel({ ...splitRepository(SERVER), name: cleanedLabel });
    throw new Error(`request label ${cleanedLabel} remains after release workflow`);
  } catch (e) {
    if (!hasStatus(e, 404)) throw e;
  }
  return { run, jobRows, label: cleanedLabel };
}

async function completedRelease(ctx: Ctx, ver: string, buildType: ReleaseBuildType): Promise<{ pipeline: ReleaseRun; pr: ReleasePr; sha: string; clientRun: Run }> {
  return withServerConfig(ctx, configureRelease(buildType), async () => withPr(ctx, ver, async (pr) => {
    const merged = await mergeAsServer(ctx, pr);
    const clientRun = await releaseClientRun(ctx, merged.since, pr);
    assert(clientRun.conclusion === "success", `client release request concluded ${clientRun.conclusion} (${clientRun.html_url})`);
    const pipeline = await releasePipeline(ctx, merged.since, pr);
    return { pipeline, pr, sha: merged.sha, clientRun };
  }));
}

function expectJob(result: ReleaseRun, name: string, conclusion: Conclusion): void {
  const rows = result.jobRows.filter((job) => job.name === name || job.name.startsWith(`${name} (`));
  assert(rows.length > 0, `release job ${name} is missing (${result.run.html_url})`);
  assert(rows.every((job) => job.conclusion === conclusion), `release job ${name} concluded ${rows.map((job) => job.conclusion).join(",")}, expected ${conclusion} (${result.run.html_url})`);
}

async function expectLog(ctx: Ctx, result: ReleaseRun, name: string, pattern: RegExp): Promise<void> {
  const job = result.jobRows.find((row) => row.name === name || row.name.startsWith(`${name} (`));
  assert(job, `release job ${name} is missing`);
  const log = await jobLog(ctx, SERVER, job.id);
  assert(pattern.test(log), `release job ${name} log does not match ${pattern} (${result.run.html_url})`);
}

function expectedNames(type: ReleaseBuildType, ver: string): string[] {
  if (type === "cargo") return [
    ...["aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"].map((target) => `testing-csm-ci-client-${ver}-${target}.tar.gz`),
    "SHA256SUMS",
  ].sort();
  if (type === "goreleaser") return [`testing-csm-ci-client_${ver}_linux_amd64.tar.gz`, "SHA256SUMS"].sort();
  return ["SHA256SUMS"];
}

async function publishedRelease(ctx: Ctx, ver: string, mergeSha: string, type: ReleaseBuildType): Promise<string> {
  const tag = `v${ver}`;
  const { data } = await ctx.gh.rest.repos.getReleaseByTag({ ...splitRepository(CLIENT), tag });
  assert(data.draft === false && data.published_at, `release ${tag} is not published`);
  assert(data.immutable === true, `release ${tag} is not immutable`);
  assert(Number(data.author?.id) === SERVER_BOT_ID, `release ${tag} author is ${data.author?.login}, not the Server App`);
  assert(data.target_commitish === mergeSha, `release ${tag} targets ${data.target_commitish}, expected ${mergeSha}`);
  const actual = data.assets.map((asset) => asset.name).sort();
  const expected = expectedNames(type, ver);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `release ${tag} asset set was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  assert(data.assets.every((asset) => asset.digest?.startsWith("sha256:")), `release ${tag} has an asset without a SHA256 digest`);
  ctx.urls.push(data.html_url);
  return tag;
}

async function verifyAttestations(ctx: Ctx, tag: string, mergeSha: string): Promise<void> {
  const run = await dispatch(ctx, SERVER, "csm-ci-release-verify.yml", { tag, merge_sha: mergeSha, client_repository: CLIENT, signer_workflow: SIGNER, predicate_type: PREDICATE });
  assert(run.conclusion === "success", `hosted attestation verification concluded ${run.conclusion} (${run.html_url})`);
}

async function success(ctx: Ctx, type: ReleaseBuildType): Promise<{ tag: string; sha: string }> {
  const ver = version();
  const result = await completedRelease(ctx, ver, type);
  expectJob(result.pipeline, "intake", "success");
  expectJob(result.pipeline, "release-plan", "success");
  expectJob(result.pipeline, "release-build", "success");
  expectJob(result.pipeline, "release-publish", "success");
  const tag = await publishedRelease(ctx, ver, result.sha, type);
  await verifyAttestations(ctx, tag, result.sha);
  return { tag, sha: result.sha };
}

export const release: Scenario[] = [
  {
    name: "release request is rejected when release is disabled, and the label is removed",
    serial: true,
    run: async (ctx) => withServerConfig(ctx, withoutReleaseOperation, async () => {
      const request = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "release", args: "1" });
      assert(request.conclusion === "success", `client request concluded ${request.conclusion} (${request.html_url})`);
      const requestJob = await until("release smoke request job", async () => (await jobs(ctx, CLIENT, request.id)).get("request"));
      const log = await jobLog(ctx, CLIENT, requestJob.id);
      const label = /created label (csm-ci-[^ ]+) \(/.exec(log)?.[1];
      assert(label, "release request label was not created");
      const match = { kind: "release", repository: CLIENT, args: { pull_number: 1 }, label };
      const run = await until("rejected disabled release request", async () => (await serverRuns(ctx, match, new Date(new Date(request.created_at).getTime() - 2_000)))[0]);
      const finished = await waitRun(ctx, SERVER, run.id);
      const byName = await jobs(ctx, SERVER, finished.id);
      assert(byName.get("intake")?.conclusion === "failure", `disabled release intake concluded ${byName.get("intake")?.conclusion}`);
      assert(byName.get("cleanup")?.conclusion === "success", "disabled release cleanup did not succeed");
      assert(/does not enable release/.test(await jobLog(ctx, SERVER, byName.get("intake")!.id)), "disabled release rejection did not explain the missing release operation");
      try { await ctx.gh.rest.issues.getLabel({ ...splitRepository(SERVER), name: label }); throw new Error(`request label ${label} remains`); }
      catch (e) { if (!hasStatus(e, 404)) throw e; }
    }),
  },
  ...(["none", "js-action", "goreleaser", "cargo"] as const).map((type) => ({
    name: `publishes an immutable ${type} release with verified asset attestations`, serial: true,
    run: async (ctx: Ctx) => { await success(ctx, type); },
  })),
  {
    name: "replaying a completed none release preserves the immutable release and asset digests",
    serial: true,
    run: async (ctx) => {
      const ver = version();
      const first = await completedRelease(ctx, ver, "none");
      expectJob(first.pipeline, "release-publish", "success");
      const { data: before } = await ctx.gh.rest.repos.getReleaseByTag({ ...splitRepository(CLIENT), tag: `v${ver}` });
      const since = new Date(Date.now() - 2_000);
      const replay = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "release", args: String(first.pr.number) });
      assert(replay.conclusion === "success", `release replay request concluded ${replay.conclusion}`);
      const req = await jobs(ctx, CLIENT, replay.id);
      const text = await jobLog(ctx, CLIENT, req.get("request")!.id);
      const label = /created label (csm-ci-[^ ]+) \(/.exec(text)?.[1];
      assert(label, "release replay label missing");
      const pipeline = await releasePipeline(ctx, since, first.pr, label);
      expectJob(pipeline, "release-plan", "success");
      expectJob(pipeline, "release-publish", "success");
      const { data: after } = await ctx.gh.rest.repos.getReleaseByTag({ ...splitRepository(CLIENT), tag: `v${ver}` });
      assert(before.id === after.id && before.immutable === after.immutable, "release replay replaced or changed the immutable release");
      assert(JSON.stringify(before.assets.map((asset) => [asset.name, asset.digest]).sort()) === JSON.stringify(after.assets.map((asset) => [asset.name, asset.digest]).sort()), "release replay changed published asset digests");
      await publishedRelease(ctx, ver, first.sha, "none");
    },
  },
  {
    name: "a stale committed dist file fails the js-action build and still cleans up the request",
    serial: true,
    run: async (ctx) => withServerConfig(ctx, configureRelease("js-action"), () => withPr(ctx, version(), async (pr) => {
      const merged = await mergeAsServer(ctx, pr);
      const client = await releaseClientRun(ctx, merged.since, pr);
      assert(client.conclusion === "success", `check-dist release request concluded ${client.conclusion}`);
      const pipeline = await releasePipeline(ctx, merged.since, pr);
      expectJob(pipeline, "release-plan", "success");
      expectJob(pipeline, "release-build", "failure");
      await expectLog(ctx, pipeline, "release-build", /dist.*differs|differs.*dist/i);
      assert(pipeline.jobRows.find((job) => job.name === "cleanup")?.conclusion === "success", "check-dist failure did not clean up the request");
      assert(pipeline.jobRows.find((job) => job.name === "release-publish")?.conclusion === "skipped", "check-dist failure unexpectedly published a release");
    }, { "dist/action.js": "stale e2e dist output\n" })),
  },
  {
    name: "a tag collision at another merge commit is rejected during planning",
    serial: true,
    run: async (ctx) => {
      const ver = version();
      await completedRelease(ctx, ver, "none");
      await withServerConfig(ctx, configureRelease("none"), () => withPr(ctx, ver, async (pr) => {
        const merged = await mergeAsServer(ctx, pr);
        const client = await releaseClientRun(ctx, merged.since, pr);
        assert(client.conclusion === "success", `tag-collision release request concluded ${client.conclusion}`);
        const pipeline = await releasePipeline(ctx, merged.since, pr);
        expectJob(pipeline, "release-plan", "failure");
        await expectLog(ctx, pipeline, "release-plan", /tag v.*points to a different commit/);
        assert(pipeline.jobRows.find((job) => job.name === "cleanup")?.conclusion === "success", "tag-collision request cleanup did not succeed");
      }, { [`e2e/release-collision-${ver}.txt`]: `different release commit ${ver}\n` }));
    },
  },
  {
    name: "rejects a pre-existing release authored outside the Server App",
    serial: true,
    run: async (ctx) => {
      const ver = version();
      await withServerConfig(ctx, configureRelease("js-action"), () => withPr(ctx, ver, async (pr) => {
        const merged = await mergeAsServer(ctx, pr);
        const client = await releaseClientRun(ctx, merged.since, pr);
        assert(client.conclusion === "success", `release request concluded ${client.conclusion}`);
        const first = await releasePipeline(ctx, merged.since, pr);
        expectJob(first, "release-build", "failure");
        const { data: draft } = await ctx.gh.rest.repos.createRelease({
          ...splitRepository(CLIENT), tag_name: `v${ver}`, target_commitish: merged.sha, name: `e2e foreign draft ${ver}`, draft: true,
        });
        try {
          assert(draft.draft && Number(draft.author?.id) !== SERVER_BOT_ID, "foreign draft release was not authored by the owner");
          const replay = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "release", args: String(pr.number) });
          assert(replay.conclusion === "success", `release replay request concluded ${replay.conclusion}`);
          const requestJobs = await jobs(ctx, CLIENT, replay.id);
          const requestLog = await jobLog(ctx, CLIENT, requestJobs.get("request")!.id);
          const label = /created label (csm-ci-[^ ]+) \(/.exec(requestLog)?.[1];
          assert(label, "release replay did not create a request label");
          const pipeline = await releasePipeline(ctx, new Date(new Date(replay.created_at).getTime() - 2_000), pr, label);
          expectJob(pipeline, "release-plan", "failure");
          await expectLog(ctx, pipeline, "release-plan", /already exists and was not created by the Server bot/);
        } finally {
          const { data: latest } = await ctx.gh.rest.repos.getRelease({ ...splitRepository(CLIENT), release_id: draft.id });
          assert(latest.id === draft.id && latest.draft && Number(latest.author?.id) === Number(draft.author?.id), "foreign draft changed during collision test; refusing to delete it");
          await ctx.gh.rest.repos.deleteRelease({ ...splitRepository(CLIENT), release_id: draft.id });
        }
      }, { "dist/action.js": `stale release build ${ver}\n` }));
    },
  },
  {
    name: "rejects an invalid release version during planning",
    serial: true,
    run: async (ctx) => withServerConfig(ctx, configureRelease("none"), () => withPr(ctx, `invalid-${Date.now()}`, async (pr) => {
      const merged = await mergeAsServer(ctx, pr);
      const client = await releaseClientRun(ctx, merged.since, pr);
      assert(client.conclusion === "success", `invalid-version release request concluded ${client.conclusion}`);
      const pipeline = await releasePipeline(ctx, merged.since, pr);
      expectJob(pipeline, "release-plan", "failure");
      await expectLog(ctx, pipeline, "release-plan", /is not semver/);
      assert(pipeline.jobRows.find((job) => job.name === "release-publish")?.conclusion === "skipped", "invalid version unexpectedly reached release publication");
    }, { ".release-version": "not-semver\n" })),
  },
  {
    name: "rejects a pull request merged by the owner instead of the Server App",
    serial: true,
    run: async (ctx) => withServerConfig(ctx, configureRelease("none"), () => withPr(ctx, version(), async (pr) => {
      const { data } = await ctx.gh.rest.pulls.merge({ ...splitRepository(CLIENT), pull_number: pr.number, merge_method: "squash" });
      assert(data.merged, `wrong-merger test PR #${pr.number} did not merge`);
      const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
      assert(Number(pull.merged_by?.id) !== SERVER_BOT_ID, "wrong-merger test was unexpectedly merged by the Server App");
      const client = await releaseClientRun(ctx, pr.openedAt, pr);
      assert(client.conclusion === "success", `wrong-merger release request concluded ${client.conclusion}`);
      const pipeline = await releasePipeline(ctx, pr.openedAt, pr);
      expectJob(pipeline, "release-plan", "failure");
      await expectLog(ctx, pipeline, "release-plan", /was not merged by the Server bot/);
    })),
  },
  {
    name: "the active release tag ruleset rejects tag creation by the owner",
    serial: true,
    run: async (ctx) => {
      const tag = `v-e2e-unauthorized-${Date.now()}`;
      const target = (await ctx.gh.rest.repos.getBranch({ ...splitRepository(CLIENT), branch: "main" })).data.commit.sha;
      let rejected = false;
      let created = false;
      try {
        await ctx.gh.rest.git.createRef({ ...splitRepository(CLIENT), ref: `refs/tags/${tag}`, sha: target });
        created = true;
      } catch (error) {
        const message = errorText(error);
        if (hasStatus(error, 403) || hasStatus(error, 422)) {
          assert(/ruleset|rule violations|protected/i.test(message), `tag creation failed for an unexpected reason: ${message}`);
          rejected = true;
        }
        else throw error;
      } finally {
        if (created) {
          try {
            const { data: ref } = await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: `tags/${tag}` });
            if (ref.object.type === "commit" && ref.object.sha === target) await ctx.gh.rest.git.deleteRef({ ...splitRepository(CLIENT), ref: `tags/${tag}` });
          } catch (error) {
            if (!hasStatus(error, 404)) throw error;
          }
        }
      }
      assert(rejected, `owner unexpectedly created tag ${tag} while release-tags ruleset should be active`);
    },
  },
];
