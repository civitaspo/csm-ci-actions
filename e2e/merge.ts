import { marker } from "../src/lib/notify.ts";
import { parseConfig } from "../src/lib/config.ts";
import { splitRepository } from "../src/lib/github.ts";
import { assert, CLIENT, closePr, dispatch, expectOp, openPr, type Pr, postComment, type Scenario, SERVER, SERVER_BOT_ID, serverComments, until } from "./harness.ts";

const RULESET_ID = 25785295;
const TEST_BOT_ID = 347402450;
const TEST_BOT_LOGIN = "testing-csm-ci-untrusted-committer[bot]";
const SERVER_CONFIG = "csm-ci.yaml";

type MergeRequest = { match: { kind: string; repository: string; args: Record<string, number> }; since: Date };

async function request(ctx: Parameters<Scenario["run"]>[0], pr: Pr, commentId: number): Promise<MergeRequest> {
  const since = new Date(Date.now() - 2_000);
  const run = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind: "merge", args: `${pr.number}/${commentId}` });
  assert(run.conclusion === "success", `client merge request concluded ${run.conclusion} (${run.html_url})`);
  return { since, match: { kind: "merge", repository: CLIENT, args: { pull_number: pr.number, comment_id: commentId } } };
}

function fromComment(pr: Pr, comment: { id: number; since: Date }): MergeRequest {
  return { since: comment.since, match: { kind: "merge", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } } };
}

async function withTestBotConfigured(ctx: Parameters<Scenario["run"]>[0], run: () => Promise<void>): Promise<void> {
  const repository = splitRepository(SERVER);
  const readConfig = async () => {
    const { data } = await ctx.gh.rest.repos.getContent({ ...repository, path: SERVER_CONFIG, ref: "main" });
    assert(!Array.isArray(data) && data.type === "file", `expected ${SERVER}/${SERVER_CONFIG} to be a file`);
    return { sha: data.sha, text: Buffer.from(data.content, "base64").toString("utf8") };
  };
  const writeConfig = async (sha: string, text: string, message: string): Promise<void> => {
    await ctx.gh.rest.repos.createOrUpdateFileContents({
      ...repository,
      path: SERVER_CONFIG,
      branch: "main",
      sha,
      message,
      content: Buffer.from(text).toString("base64"),
    });
  };
  const original = await readConfig();
  const botCommitter = `    - { id: ${TEST_BOT_ID}, login: "${TEST_BOT_LOGIN}" }`;
  const botMerger = `    - { id: ${TEST_BOT_ID}, login: "${TEST_BOT_LOGIN}" }`;
  assert(!original.text.includes(String(TEST_BOT_ID)), `test bot ${TEST_BOT_ID} is already present in ${SERVER_CONFIG}`);
  assert(original.text.includes("  committers:\n    - { id: 4525500, login: civitaspo }"), "could not find the expected committers fixture entry");
  assert(original.text.includes("  bot_mergers: []"), "could not find the empty bot_mergers fixture entry");
  const configured = original.text
    .replace("  committers:\n    - { id: 4525500, login: civitaspo }", `  committers:\n    - { id: 4525500, login: civitaspo }\n${botCommitter}`)
    .replace("  bot_mergers: []", `  bot_mergers:\n${botMerger}`);
  const parsed = parseConfig(configured);
  assert(configured !== original.text && parsed.trust.committers.some((entry) => entry.id === TEST_BOT_ID && entry.login === TEST_BOT_LOGIN), "could not add the isolated test bot as a trusted committer");
  assert(parsed.trust.bot_mergers.some((entry) => entry.id === TEST_BOT_ID && entry.login === TEST_BOT_LOGIN), "could not add the isolated test bot as a merger");
  try {
    await writeConfig(original.sha, configured, "Temporarily configure the merge e2e bot");
    await run();
  } finally {
    const latest = await readConfig();
    if (latest.text === configured) await writeConfig(latest.sha, original.text, "Restore the merge e2e server fixture");
    else if (latest.text !== original.text) throw new Error(`server fixture changed unexpectedly during merge e2e; refusing to overwrite ${SERVER_CONFIG}`);
  }
}

async function openBotPr(ctx: Parameters<Scenario["run"]>[0]): Promise<{ pr: Pr; since: Date }> {
  assert(ctx.untrusted, "the untrusted test token is not configured");
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, "signed", ctx.untrusted, undefined, ctx.untrusted);
  const { data } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
  assert(data.user?.id === TEST_BOT_ID, `expected test bot #${TEST_BOT_ID} to author pull request #${pr.number}, found ${data.user?.id}`);
  return { pr, since };
}

async function postBotMergeRequest(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<{ comment: { id: number; since: Date }; requestInfo: MergeRequest }> {
  assert(ctx.untrusted, "the untrusted test token is not configured");
  const comment = await postComment(ctx, pr, "/merge", ctx.untrusted);
  const requestInfo = ["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.authorAssociation)
    ? fromComment(pr, comment)
    : await request(ctx, pr, comment.id);
  return { comment, requestInfo };
}

async function closeIfOpen(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<void> {
  const repo = splitRepository(CLIENT);
  const { data } = await ctx.gh.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (data.state === "open") await ctx.gh.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
  await ctx.gh.rest.git.deleteRef({ ...repo, ref: `heads/${pr.branch}` });
}

async function withSignedPr(ctx: Parameters<Scenario["run"]>[0], fn: (pr: Pr) => Promise<void>): Promise<void> {
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, "signed");
  try {
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number } }, since, "success");
    await fn(pr);
  } finally {
    await closePr(ctx, pr);
  }
}

async function dismissApproval(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<void> {
  const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, per_page: 100 });
  for (const review of reviews.filter((r) => r.user?.login === "testing-csm-ci-approver[bot]" && r.state === "APPROVED")) {
    await ctx.gh.rest.pulls.dismissReview({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, review_id: Number(review.id), message: "e2e: test merge readiness" });
  }
}

async function awaitServerWait(ctx: Parameters<Scenario["run"]>[0], commentId: number): Promise<void> {
  await until(`the Server App rocket on comment ${commentId}`, async () => {
    const reactions = await ctx.gh.paginate(ctx.gh.rest.reactions.listForIssueComment, { owner: "civitaspo", repo: "testing-csm-ci-client", comment_id: commentId, per_page: 100 });
    return reactions.some((reaction) => reaction.content === "rocket" && reaction.user?.login === "testing-csm-ci-server[bot]") ? true : undefined;
  });
}

async function pushSignedCommit(ctx: Parameters<Scenario["run"]>[0], pr: Pr, expectedHead: string): Promise<string> {
  const result = await ctx.gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    {
      input: {
        branch: { repositoryNameWithOwner: CLIENT, branchName: pr.branch },
        message: { headline: `e2e update ${pr.branch}` },
        expectedHeadOid: expectedHead,
        fileChanges: { additions: [{ path: `e2e/${pr.branch}.txt`, contents: Buffer.from(`${pr.branch} updated\n`).toString("base64") }] },
      },
    },
  );
  return result.createCommitOnBranch.commit.oid;
}

async function noMerge(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<void> {
  const { data } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
  assert(!data.merged && data.state === "open", `request unexpectedly merged pull request #${pr.number}`);
}

async function withReviewRulesetDisabled(ctx: Parameters<Scenario["run"]>[0], run: () => Promise<void>): Promise<void> {
  const { data } = await ctx.gh.rest.repos.getRepoRuleset({ owner: "civitaspo", repo: "testing-csm-ci-client", ruleset_id: RULESET_ID });
  const enforcement = data.enforcement;
  assert(enforcement === "active", `expected review-and-checks ruleset ${RULESET_ID} to be active, found ${enforcement}`);
  const refName = data.conditions?.ref_name;
  assert(data.target === "branch" && refName, `ruleset ${RULESET_ID} is not the expected default-branch rule`);
  const updateEnforcement = async (value: "active" | "disabled"): Promise<void> => {
    await ctx.gh.rest.repos.updateRepoRuleset({
      owner: "civitaspo",
      repo: "testing-csm-ci-client",
      ruleset_id: RULESET_ID,
      name: data.name,
      target: "branch",
      enforcement: value,
      conditions: { ref_name: refName },
      rules: data.rules ?? [],
      bypass_actors: data.bypass_actors ?? [],
    });
  };
  try {
    await updateEnforcement("disabled");
    await run();
  } finally {
    await updateEnforcement(enforcement);
  }
}

export const merge: Scenario[] = [
  {
    name: "/merge by an authorized merger squashes the approved head and posts one receipt",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = fromComment(pr, comment);
      await expectOp(ctx, requestInfo.match, requestInfo.since, "success");
      const { data: merged } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
      assert(merged.merged && merged.merge_commit_sha, `pull request #${pr.number} was not merged`);
      const receipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", comment.id)));
      assert(receipts.length === 1 && receipts[0]?.includes("merged as"), `expected one merge receipt, found ${receipts.length}`);
    }),
  },
  {
    name: "the notification-only Server App token can react and comment but cannot merge an approved pull request",
    serial: true,
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      const comment = await postComment(ctx, pr, "notification permission probe");
      const run = await dispatch(ctx, SERVER, "csm-ci-merge-notify-scope.yml", {
        pull_number: String(pr.number),
        head_sha: pr.head,
        comment_id: String(comment.id),
      });
      assert(run.conclusion === "success", `notification-only token probe concluded ${run.conclusion} (${run.html_url})`);
      const reactions = await ctx.gh.paginate(ctx.gh.rest.reactions.listForIssueComment, {
        owner: "civitaspo", repo: "testing-csm-ci-client", comment_id: comment.id, per_page: 100,
      });
      assert(reactions.some((reaction) => reaction.content === "rocket" && reaction.user?.id === SERVER_BOT_ID), "notification-only token did not add the Server App rocket reaction");
      await noMerge(ctx, pr);
    }),
  },
  {
    name: "a non-merger's /merge request fails without a receipt and leaves the pull request open",
    needsUntrusted: true,
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      assert(ctx.untrusted, "the untrusted test token is not configured");
      const comment = await postComment(ctx, pr, "/merge", ctx.untrusted);
      const requestInfo = await request(ctx, pr, comment.id);
      await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /not one of the bot mergers/);
      await noMerge(ctx, pr);
      const receipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", comment.id)));
      assert(receipts.length === 0, `expected no receipt before command acceptance, found ${receipts.length}`);
    }),
  },
  {
    name: "an unapproved /merge request is rejected even when the review ruleset is disabled",
    serial: true,
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await withReviewRulesetDisabled(ctx, async () => {
        await dismissApproval(ctx, pr);
        const comment = await postComment(ctx, pr, "/merge");
        const requestInfo = fromComment(pr, comment);
        await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /merge readiness deadline passed: the approver has not approved/);
        await noMerge(ctx, pr);
      });
    }),
  },
  {
    name: "a head change while /merge waits aborts the merge",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await dismissApproval(ctx, pr);
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = fromComment(pr, comment);
      await awaitServerWait(ctx, comment.id);
      await pushSignedCommit(ctx, pr, pr.head);
      await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /head changed|newer than comment/);
      await noMerge(ctx, pr);
    }),
  },
  {
    name: "an edited /merge comment while waiting aborts the merge",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await dismissApproval(ctx, pr);
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = fromComment(pr, comment);
      await awaitServerWait(ctx, comment.id);
      await ctx.gh.rest.issues.updateComment({ owner: "civitaspo", repo: "testing-csm-ci-client", comment_id: comment.id, body: "/merge edited" });
      await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /no longer \/merge|has been edited|was edited/i);
      await noMerge(ctx, pr);
    }),
  },
  {
    name: "a deleted /merge comment while waiting aborts the merge",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await dismissApproval(ctx, pr);
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = fromComment(pr, comment);
      await awaitServerWait(ctx, comment.id);
      await ctx.gh.rest.issues.deleteComment({ owner: "civitaspo", repo: "testing-csm-ci-client", comment_id: comment.id });
      await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /not found|missing/i);
      await noMerge(ctx, pr);
    }),
  },
  {
    name: "/merge times out when the approver has not approved the current head",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await dismissApproval(ctx, pr);
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = await request(ctx, pr, comment.id);
      await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /merge readiness deadline passed: the approver has not approved/);
      await noMerge(ctx, pr);
      const receipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", comment.id)));
      assert(receipts.length === 1, `expected one deadline receipt, found ${receipts.length}`);
      const replay = await request(ctx, pr, comment.id);
      await expectOp(ctx, replay.match, replay.since, "failure", /already handled/);
      const replayReceipts = (await serverComments(ctx, pr)).filter((body) => body.includes(marker("merge", comment.id)));
      assert(replayReceipts.length === 1, `replay changed the receipt count to ${replayReceipts.length}`);
    }),
  },
  {
    name: "a configured bot can merge its own pull request but not another author's pull request or commit",
    needsUntrusted: true,
    serial: true,
    run: async (ctx) => {
      assert(ctx.untrusted, "the untrusted test token is not configured");
      await withTestBotConfigured(ctx, async () => {
        await withSignedPr(ctx, async (pr) => {
          const { comment, requestInfo } = await postBotMergeRequest(ctx, pr);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /bot merger testing-csm-ci-untrusted-committer\[bot\] can merge only its own pull request/);
          await noMerge(ctx, pr);
          assert(!(await serverComments(ctx, pr)).some((body) => body.includes(marker("merge", comment.id))), "rejected bot ownership request posted a receipt");
        });

        let mixedPr: Pr | undefined;
        try {
          const opened = await openBotPr(ctx);
          mixedPr = opened.pr;
          await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: mixedPr.number } }, opened.since, "success");
          await pushSignedCommit(ctx, mixedPr, mixedPr.head);
          const { comment, requestInfo } = await postBotMergeRequest(ctx, mixedPr);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /bot merger testing-csm-ci-untrusted-committer\[bot\] can merge only commits by itself/);
          await noMerge(ctx, mixedPr);
          assert(!(await serverComments(ctx, mixedPr)).some((body) => body.includes(marker("merge", comment.id))), "rejected mixed-identity bot request unexpectedly posted a receipt");
        } finally {
          if (mixedPr) await closeIfOpen(ctx, mixedPr);
        }

        let botPr: Pr | undefined;
        try {
          const opened = await openBotPr(ctx);
          botPr = opened.pr;
          await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: botPr.number } }, opened.since, "success");
          const { comment, requestInfo } = await postBotMergeRequest(ctx, botPr);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "success");
          const { data } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: botPr.number });
          assert(data.merged && data.merge_commit_sha, `test bot's pull request #${botPr.number} was not merged`);
          assert((await serverComments(ctx, botPr)).some((body) => body.includes(marker("merge", comment.id)) && body.includes("merged as")), "test bot merge has no success receipt");
        } finally {
          if (botPr) await closeIfOpen(ctx, botPr);
        }
      });
    },
  },
];
