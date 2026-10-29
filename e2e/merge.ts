import { withRepositoryPolicy } from "./repository-policy.ts";
import { OWNER_IDENTITY } from "./pr-metadata.ts";
import { prCase } from "./harness.ts";
import { marker } from "../src/lib/notify.ts";
import { automergeMarker } from "../src/lib/automerge.ts";
import { parseConfig } from "../src/lib/config.ts";
import { splitRepository } from "../src/lib/github.ts";
import { approverReviews, assert, CLIENT, closePr, dispatch, expectOp, openPr, type Pr, postComment, type Scenario, SERVER, SERVER_BOT_ID, serverComments, until, withServerConfig } from "./harness.ts";

const TEST_BOT_ID = 347402450;
const TEST_BOT_LOGIN = "testing-csm-ci-untrusted-committer[bot]";
const SERVER_CONFIG = "csm-ci.yaml";

type MergeRequest = { match: { kind: string; repository: string; args: Record<string, number> }; since: Date };

async function request(ctx: Parameters<Scenario["run"]>[0], pr: Pr, commentId: number): Promise<MergeRequest> {
  const kind = "merge";
  const since = new Date(Date.now() - 2_000);
  const run = await dispatch(ctx, CLIENT, "csm-ci-smoke.yml", { kind, args: `${pr.number}/${commentId}` });
  assert(run.conclusion === "success", `client merge request concluded ${run.conclusion} (${run.html_url})`);
  return { since, match: { kind, repository: CLIENT, args: { pull_number: pr.number, comment_id: commentId } } };
}

function fromComment(pr: Pr, comment: { id: number; since: Date }): MergeRequest {
  return { since: comment.since, match: { kind: "merge", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } } };
}

type AutomergeStatus = { databaseId: number; state: string; description: string | null; createdAt: string; creator: { __typename: string; databaseId: number } | null };
type AutomergeRecord = { id: string; databaseId: number; task: string; payload: unknown; createdAt: string; creator: { __typename: string; databaseId: number } | null; statuses: { nodes: AutomergeStatus[] } };

export function parseAutomergePayload(raw: unknown): unknown {
  let decoded = raw;
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth++) decoded = JSON.parse(decoded) as unknown;
  return decoded;
}

async function reservations(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<AutomergeRecord[]> {
  const data = await ctx.gh.graphql<{ client: { databaseId: number }; server: { deployments: { nodes: Omit<AutomergeRecord, "statuses">[] } } }>(
    "query{client:repository(owner:\"civitaspo\",name:\"testing-csm-ci-client\"){databaseId} server:repository(owner:\"civitaspo\",name:\"testing-csm-ci-server\"){deployments(environments:[\"csm-ci-automerge\"],first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{id databaseId task payload createdAt creator{__typename ... on Bot{databaseId}}}}}}",
  );
  const matching = data.server.deployments.nodes.filter((deployment) => {
    try {
      const payload = parseAutomergePayload(deployment.payload) as { repository_id?: number; pull_number?: number };
      return deployment.task === "csm-ci:automerge" && deployment.creator?.__typename === "Bot" && deployment.creator.databaseId === SERVER_BOT_ID && payload.repository_id === data.client.databaseId && payload.pull_number === pr.number;
    } catch { return false; }
  });
  return Promise.all(matching.map(async (deployment) => {
    const statuses = await ctx.gh.paginate(ctx.gh.rest.repos.listDeploymentStatuses, { owner: "civitaspo", repo: "testing-csm-ci-server", deployment_id: deployment.databaseId, per_page: 100 });
    return {
      ...deployment,
      statuses: { nodes: statuses.map((status) => ({
        databaseId: Number(status.id),
        state: status.state.toUpperCase(),
        description: status.description,
        createdAt: status.created_at,
        creator: status.creator ? { __typename: status.creator.type, databaseId: Number(status.creator.id) } : null,
      })) },
    };
  }));
}

async function awaitReservation(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<AutomergeRecord> {
  return until(`automerge reservation for pull request #${pr.number}`, async () => (await reservations(ctx, pr))[0]);
}

async function assertAutomergeLabel(ctx: Parameters<Scenario["run"]>[0], pr: Pr, expected: boolean): Promise<void> {
  const { data } = await ctx.gh.rest.issues.listLabelsOnIssue({ ...splitRepository(CLIENT), issue_number: pr.number });
  assert(data.some((label) => label.name === "csm-ci/automerge") === expected, `csm-ci/automerge label presence did not equal ${expected} on #${pr.number}`);
}

function terminalStatus(record: AutomergeRecord): AutomergeRecord["statuses"]["nodes"][number] | undefined {
  return record.statuses.nodes.filter((status) => status.creator?.__typename === "Bot" && status.creator.databaseId === SERVER_BOT_ID && ["SUCCESS", "FAILURE", "INACTIVE"].includes(status.state))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.databaseId - b.databaseId)[0];
}

async function assertReservation(ctx: Parameters<Scenario["run"]>[0], pr: Pr, expected: "QUEUED" | "SUCCESS" | "INACTIVE"): Promise<AutomergeRecord> {
  const record = await awaitReservation(ctx, pr);
  assert(record.creator?.__typename === "Bot" && record.creator.databaseId === SERVER_BOT_ID, `deployment ${record.databaseId} was not created by the Server bot`);
  const terminal = terminalStatus(record);
  if (expected === "QUEUED") assert(!terminal, `reservation for #${pr.number} unexpectedly ended as ${terminal?.state}`);
  else assert(terminal?.state === expected, `reservation for #${pr.number} ended as ${terminal?.state ?? "active"}, expected ${expected}`);
  return record;
}

async function assertAutomergeComment(ctx: Parameters<Scenario["run"]>[0], pr: Pr, record: AutomergeRecord, event: "accepted" | "merged" | "cancelled", text: RegExp): Promise<void> {
  const bodies = await serverComments(ctx, pr);
  assert(bodies.filter((body) => body.includes(automergeMarker(record.databaseId, event))).length === 1, `expected one ${event} comment for deployment ${record.databaseId}`);
  assert(bodies.some((body) => body.includes(automergeMarker(record.databaseId, event)) && text.test(body)), `automerge ${event} comment did not match ${text}`);
}

export async function withTestBotConfigured(ctx: Parameters<Scenario["run"]>[0], run: () => Promise<void>): Promise<void> {
  await withServerConfig(ctx, (text) => {
    const botEntry = `    - { id: ${TEST_BOT_ID}, login: "${TEST_BOT_LOGIN}" }`;
    assert(!text.includes(String(TEST_BOT_ID)), `test bot ${TEST_BOT_ID} is already present in ${SERVER_CONFIG}`);
    assert(text.includes("  committers:\n    - { id: 4525500, login: civitaspo }"), "could not find the expected committers fixture entry");
    assert(text.includes("  bot_mergers: []"), "could not find the empty bot_mergers fixture entry");
    const configured = text
      .replace("  committers:\n    - { id: 4525500, login: civitaspo }", `  committers:\n    - { id: 4525500, login: civitaspo }\n${botEntry}`)
      .replace("  bot_mergers: []", `  bot_mergers:\n${botEntry}`);
    const parsed = parseConfig(configured);
    assert(configured !== text && parsed.trust.committers.some((entry) => entry.id === TEST_BOT_ID && entry.login === TEST_BOT_LOGIN), "could not add the isolated test bot as a trusted committer");
    assert(parsed.trust.bot_mergers.some((entry) => entry.id === TEST_BOT_ID && entry.login === TEST_BOT_LOGIN), "could not add the isolated test bot as a merger");
    return configured;
  }, run);
}

async function openBotPr(ctx: Parameters<Scenario["run"]>[0], intent: import("./pr-metadata.ts").PrIntent): Promise<{ pr: Pr; since: Date }> {
  assert(ctx.untrusted, "the untrusted test token is not configured");
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, { intent, kind: "signed", as: ctx.untrusted, prAs: ctx.untrusted });
  const { data } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
  assert(data.user?.id === TEST_BOT_ID, `expected test bot #${TEST_BOT_ID} to author pull request #${pr.number}, found ${data.user?.id}`);
  return { pr, since };
}

async function postBotMergeRequest(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<{ comment: Awaited<ReturnType<typeof postComment>>; requestInfo: MergeRequest }> {
  assert(ctx.untrusted, "the untrusted test token is not configured");
  const comment = await postComment(ctx, pr, "/merge", ctx.untrusted);
  return { comment, requestInfo: fromComment(pr, comment) };
}

async function withSignedPr(ctx: Parameters<Scenario["run"]>[0], fn: (pr: Pr) => Promise<void>, intent = prCase(ctx, "fixture")): Promise<void> {
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, { intent, kind: "signed" });
  try {
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number } }, since, "success");
    await fn(pr);
  } finally {
    await closePr(ctx, pr);
  }
}

function automergeScenario(id: string, title: string, run: Scenario["run"], classification: "positive" | "negative" = "positive", needsUntrusted = false): Scenario {
  const fixture: Scenario["cases"][string] = classification === "positive"
    ? { id: "fixture", target: "client" as const, title, classification, checks: ["approval-policy", "head-consistency"] as const, steps: [{ operation: "merge", outcome: "permitted" as const, expected: title }], identity: OWNER_IDENTITY }
    : { id: "fixture", target: "client" as const, title, classification, checks: ["approval-policy", "head-consistency"] as const, steps: [{ operation: "merge", outcome: "rejected" as const, expected: title }], identity: OWNER_IDENTITY };
  return {
    id: `merge.${id}`,
    name: title,
    needsUntrusted,
    cases: { fixture },
    run,
  };
}

async function reserve(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<{ comment: Awaited<ReturnType<typeof postComment>>; record: AutomergeRecord }> {
  const comment = await postComment(ctx, pr, "/merge");
  const info = fromComment(pr, comment);
  await expectOp(ctx, info.match, info.since, "success");
  return { comment, record: await awaitReservation(ctx, pr) };
}

async function waitForCsmMerge(ctx: Parameters<Scenario["run"]>[0], pr: Pr, expectedHead: string): Promise<void> {
  const merged = await until(`csm-ci merge of #${pr.number}`, async () => {
    const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    return data.merged ? data : undefined;
  });
  assert(merged.head.sha === expectedHead && merged.merged_by?.id === SERVER_BOT_ID, `pull request #${pr.number} was not merged by the Server bot at head ${expectedHead}`);
}

async function dismissApproval(ctx: Parameters<Scenario["run"]>[0], pr: Pr): Promise<void> {
  const reviews = await ctx.gh.paginate(ctx.gh.rest.pulls.listReviews, { owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, per_page: 100 });
  for (const review of reviews.filter((r) => r.user?.login === "testing-csm-ci-approver[bot]" && r.state === "APPROVED")) {
    await ctx.gh.rest.pulls.dismissReview({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number, review_id: Number(review.id), message: "e2e: test merge readiness" });
  }
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

// Platform auto-merge requires the branch rules to enforce csm-ci/policy; the shared fixture ruleset may lack it.
export const merge: Scenario[] = [
  {
    id: "merge.authorized",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "/merge by an authorized merger squashes the approved head and posts one receipt",
        classification: "positive",
        checks: [
          "approval-policy",
          "head-consistency"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "permitted",
            "expected": "The authorized command squashes the approved head and posts one receipt"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "/merge by an authorized merger squashes the approved head and posts one receipt",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      const comment = await postComment(ctx, pr, "/merge");
      const requestInfo = fromComment(pr, comment);
      await expectOp(ctx, requestInfo.match, requestInfo.since, "success");
      const reservation = await assertReservation(ctx, pr, "SUCCESS");
      await assertAutomergeLabel(ctx, pr, true);
      const { data: merged } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: pr.number });
      assert(merged.merged && merged.merge_commit_sha, `pull request #${pr.number} was not merged`);
      await assertAutomergeComment(ctx, pr, reservation, "merged", /squash-merged/u);
    }),
  },
  {
    id: "merge.reserve-then-approve",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "/merge reserves an unapproved pull request and merges it after approval",
        classification: "positive",
        checks: [
          "approval-policy",
          "head-consistency"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "permitted",
            "expected": "/merge creates an active deployment and label, then /approve lets csm-ci merge the current head"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "/merge reserves an unapproved pull request and merges it after approval",
    run: (ctx) => withSignedPr(ctx, async (pr) => {
      await dismissApproval(ctx, pr);
      const merge = await postComment(ctx, pr, "/merge");
      const mergeInfo = fromComment(pr, merge);
      await expectOp(ctx, mergeInfo.match, mergeInfo.since, "success");
      const reservation = await assertReservation(ctx, pr, "QUEUED");
      assert(reservation.statuses.nodes.some((status) => status.state === "QUEUED" && status.description?.includes("approval")), "reservation has no queued approval reason");
      await assertAutomergeLabel(ctx, pr, true);
      await assertAutomergeComment(ctx, pr, reservation, "accepted", /merge reserved/iu);
      await noMerge(ctx, pr);
      const approval = await postComment(ctx, pr, "/approve");
      await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: approval.id } }, approval.since, "success");
      const merged = await until(`csm-ci merge of #${pr.number}`, async () => {
        const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
        return data.merged ? data : undefined;
      });
      assert(merged.head.sha === pr.head && merged.merged_by?.id === SERVER_BOT_ID, `pull request #${pr.number} was not merged by the Server bot at its approved head`);
      await assertReservation(ctx, pr, "SUCCESS");
      await assertAutomergeLabel(ctx, pr, true);
    }),
  },
  automergeScenario("head-change-carries-over", "A reservation follows a new head and merges after that head is approved", async (ctx) => withSignedPr(ctx, async (pr) => {
    await dismissApproval(ctx, pr);
    await reserve(ctx, pr);
    const head = await pushSignedCommit(ctx, pr, pr.head);
    await until(`pull request #${pr.number} head update`, async () => {
      const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
      return data.head.sha === head ? true : undefined;
    });
    const approval = await postComment(ctx, pr, "/approve");
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: approval.id } }, approval.since, "success");
    await waitForCsmMerge(ctx, pr, head);
    await assertReservation(ctx, pr, "SUCCESS");
  })),
  { ...automergeScenario("head-change-needs-approval", "A reservation waits when its new head has not been approved", async (ctx) => withSignedPr(ctx, async (pr) => withServerConfig(ctx, (text) => {
    const operations = "ops: [approve, merge, policy-check, securefix, release]";
    assert(text.includes(operations), "could not find the client fixture operations");
    return text.replace(operations, "ops: [merge, policy-check, securefix, release]");
  }, async () => {
    assert((await approverReviews(ctx, pr)).some((review) => review.state === "APPROVED" && review.commit_id === pr.head), "original head did not receive approval");
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){convertPullRequestToDraft(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    await reserve(ctx, pr);
    const head = await pushSignedCommit(ctx, pr, pr.head);
    await until(`pull request #${pr.number} head update`, async () => {
      const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
      return data.head.sha === head ? true : undefined;
    });
    await ctx.gh.graphql("mutation($pull:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    await until(`queued reservation for changed head #${pr.number}`, async () => {
      const record = await awaitReservation(ctx, pr);
      return record.statuses.nodes.some((status) => status.state === "QUEUED" && status.description === `waiting for approval of ${head.slice(0, 7)}`) ? record : undefined;
    });
    assert(!(await approverReviews(ctx, pr)).some((review) => review.state === "APPROVED" && review.commit_id === head), "new head unexpectedly received automatic approval");
    await noMerge(ctx, pr);
  })), "negative"), serial: true },
  automergeScenario("cancel", "The merger can cancel an active reservation", async (ctx) => withSignedPr(ctx, async (pr) => {
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){convertPullRequestToDraft(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    const { record } = await reserve(ctx, pr);
    const comment = await postComment(ctx, pr, "/merge cancel");
    await expectOp(ctx, { kind: "merge", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } }, comment.since, "success");
    await assertReservation(ctx, pr, "INACTIVE");
    await assertAutomergeLabel(ctx, pr, false);
    const bodies = await serverComments(ctx, pr);
    assert(bodies.some((body) => body.includes(`<!-- csm-ci:automerge:${record.databaseId}:cancelled -->`)), "cancel receipt is missing");
    await noMerge(ctx, pr);
  })),
  automergeScenario("cancel-unauthorized", "An untrusted requester cannot cancel another merger reservation", async (ctx) => withSignedPr(ctx, async (pr) => {
    assert(ctx.untrusted, "the untrusted test token is not configured");
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){convertPullRequestToDraft(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    await reserve(ctx, pr);
    const comment = await postComment(ctx, pr, "/merge cancel", ctx.untrusted);
    const info = await request(ctx, pr, comment.id);
    await expectOp(ctx, info.match, info.since, "failure", /only the reserving User or a trusted merger/u);
    await assertReservation(ctx, pr, "QUEUED");
  }), "negative", true),
  { ...automergeScenario("closed", "Closing a pull request ends its reservation without a comment", async (ctx) => withSignedPr(ctx, async (pr) => {
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){convertPullRequestToDraft(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    await reserve(ctx, pr);
    await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: pr.number, state: "closed" });
    const sweep = await dispatch(ctx, SERVER, "csm-ci-automerge.yml");
    assert(sweep.conclusion === "success", `automerge sweep concluded ${sweep.conclusion} (${sweep.html_url})`);
    await assertReservation(ctx, pr, "INACTIVE");
    await assertAutomergeLabel(ctx, pr, false);
    assert(!(await serverComments(ctx, pr)).some((body) => body.includes("pull request closed")), "closing the PR unexpectedly posted an automerge comment");
  }), "negative"), serial: true },
  automergeScenario("command-edit-ignored", "Editing the original command does not revoke an accepted reservation", async (ctx) => withSignedPr(ctx, async (pr) => {
    await dismissApproval(ctx, pr);
    const { comment } = await reserve(ctx, pr);
    await ctx.gh.rest.issues.updateComment({ ...splitRepository(CLIENT), comment_id: comment.id, body: "/merge edited after acceptance" });
    const approval = await postComment(ctx, pr, "/approve");
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: approval.id } }, approval.since, "success");
    await waitForCsmMerge(ctx, pr, pr.head);
    await assertReservation(ctx, pr, "SUCCESS");
  })),
  { ...automergeScenario("label-reconcile", "Evaluation restores the automerge label for an active reservation", async (ctx) => withSignedPr(ctx, async (pr) => {
    await dismissApproval(ctx, pr);
    await reserve(ctx, pr);
    await ctx.gh.rest.issues.removeLabel({ ...splitRepository(CLIENT), issue_number: pr.number, name: "csm-ci/automerge" });
    const sweep = await dispatch(ctx, SERVER, "csm-ci-automerge.yml");
    assert(sweep.conclusion === "success", `automerge sweep concluded ${sweep.conclusion} (${sweep.html_url})`);
    await assertAutomergeLabel(ctx, pr, true);
    await assertReservation(ctx, pr, "QUEUED");
  }), "positive"), serial: true },
  { ...automergeScenario("sweep", "The scheduled sweep evaluates active reservations", async (ctx) => withSignedPr(ctx, async (pr) => {
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){convertPullRequestToDraft(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    await reserve(ctx, pr);
    await ctx.gh.graphql("mutation($pull:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pull}){pullRequest{isDraft}}}", { pull: pull.node_id });
    const sweep = await dispatch(ctx, SERVER, "csm-ci-automerge.yml");
    assert(sweep.conclusion === "success", `automerge sweep concluded ${sweep.conclusion} (${sweep.html_url})`);
    await waitForCsmMerge(ctx, pr, pr.head);
    await assertReservation(ctx, pr, "SUCCESS");
  }), "positive"), serial: true },
  { ...automergeScenario("platform-auto-merge-disabled", "csm-ci disables a pre-existing GitHub auto-merge request before merging", async (ctx) => withSignedPr(ctx, async (pr) => {
    await dismissApproval(ctx, pr);
    const { data: repo } = await ctx.gh.rest.repos.get({ ...splitRepository(CLIENT) });
    assert(repo.allow_auto_merge, "testing client repository must have allow_auto_merge enabled for this scenario");
    const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
    await ctx.gh.graphql("mutation($pull:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pull,mergeMethod:SQUASH}){pullRequest{autoMergeRequest{enabledAt}}}}", { pull: pull.node_id });
    const enabled = await ctx.gh.graphql<{ repository: { pullRequest: { autoMergeRequest: { enabledAt: string } | null } } }>("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){autoMergeRequest{enabledAt}}}}", { owner: "civitaspo", name: "testing-csm-ci-client", number: pr.number });
    assert(enabled.repository.pullRequest.autoMergeRequest, "GitHub auto-merge request was not enabled");
    await reserve(ctx, pr);
    const approval = await postComment(ctx, pr, "/approve");
    await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: approval.id } }, approval.since, "success");
    await waitForCsmMerge(ctx, pr, pr.head);
    const after = await ctx.gh.graphql<{ repository: { pullRequest: { autoMergeRequest: unknown | null } } }>("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){autoMergeRequest{enabledAt}}}}", { owner: "civitaspo", name: "testing-csm-ci-client", number: pr.number });
    assert(after.repository.pullRequest.autoMergeRequest === null, "GitHub auto-merge request remained enabled after csm-ci merged");
    const reservation = await assertReservation(ctx, pr, "SUCCESS");
    await assertAutomergeComment(ctx, pr, reservation, "merged", /squash-merged/u);
  })), serial: true },
  {
    id: "merge.workflow-change",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "/merge squashes an explicitly approved workflow change at the pinned head",
        classification: "positive",
        checks: [
          "approval-policy",
          "path-safety",
          "head-consistency"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "permitted",
            "expected": "Explicit approval permits the workflow change and merge at its pinned head"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "/merge squashes an explicitly approved workflow change at the pinned head",
    serial: true,
    run: (ctx) => withServerConfig(ctx, (text) => {
      const current = 'exempt: [{ id: 4525500, login: civitaspo }]';
      assert(text.includes(current), "could not find the expected sensitive-path exemption");
      return text.replace(current, "exempt: []");
    }, async () => {
      const since = new Date(Date.now() - 2_000);
      const path = `.github/workflows/e2e-merge-${crypto.randomUUID()}.yml`;
      const content = "name: Merge permission fixture\non: workflow_dispatch\npermissions: {}\njobs:\n  fixture:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: 'true'\n";
      const pr = await openPr(ctx, { intent: prCase(ctx, "fixture"), kind: "signed", filePath: path, fileContent: content });
      try {
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number } }, since, "success");
        assert(!(await approverReviews(ctx, pr)).some((review) => review.state === "APPROVED" && review.commit_id === pr.head), "workflow change unexpectedly received automatic approval");
        const approval = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: approval.id } }, approval.since, "success");
        assert((await approverReviews(ctx, pr)).some((review) => review.state === "APPROVED" && review.commit_id === pr.head), "trusted /approve did not approve the workflow change at its pinned head");
        const comment = await postComment(ctx, pr, "/merge");
        const requestInfo = fromComment(pr, comment);
        await expectOp(ctx, requestInfo.match, requestInfo.since, "success");
        const { data: merged } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
        assert(merged.merged && merged.merge_commit_sha && merged.head.sha === pr.head, `workflow pull request #${pr.number} was not merged at its approved head`);
        const { data: file } = await ctx.gh.rest.repos.getContent({ ...splitRepository(CLIENT), path, ref: merged.merge_commit_sha });
        assert(!Array.isArray(file) && file.type === "file" && Buffer.from(file.content, "base64").toString("utf8") === content, "merged workflow content differs from the approved change");
        const reservation = await assertReservation(ctx, pr, "SUCCESS");
        await assertAutomergeComment(ctx, pr, reservation, "merged", /squash-merged/u);
      } finally {
        await closePr(ctx, pr);
      }
    }),
  },
  {
    id: "merge.notification-scope",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "the notification-only Server App token can react and comment but cannot merge an approved pull request",
        classification: "negative",
        checks: [
          "identity-trust"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "rejected",
            "expected": "The notification-only token reacts and comments but cannot merge the approved PR"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
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
    id: "merge.non-merger",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a non-merger's /merge request fails without a receipt and leaves the pull request open",
        classification: "negative",
        checks: [
          "identity-trust",
          "bot-ownership"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "rejected",
            "expected": "The unconfigured Bot merger is rejected without a receipt and the PR remains open"
          }
        ],
        identity: [
          "PR author: civitaspo (ID 4525500).",
          "Effective commit identity: civitaspo (ID 4525500); GitHub-signed commits use the owner as author and web-flow as committer.",
          "Command requester: testing-csm-ci-untrusted-committer[bot] (ID 347402450). The Bot is not configured in trust.bot_mergers."
        ]
      }
    },
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
    id: "merge.configured-bot-ownership",
    cases: {
      "repository-denied": { id: "repository-denied", target: "client", title: "Repository override rejects configured Bot merge requests", classification: "negative", checks: ["identity-trust", "bot-ownership"], steps: [{ operation: "approve", outcome: "permitted", expected: "The signed configured Bot PR receives automatic approval" }, { operation: "merge", outcome: "rejected", expected: "The repository allow_bot_requests override rejects the Bot request and leaves this PR unmerged" }], identity: ["PR author, effective commit identity and command requester: testing-csm-ci-untrusted-committer[bot] (ID 347402450).", "Temporarily configured in trust.committers and trust.bot_mergers with sensitive-path exemptions; the nested repository override sets merge.allow_bot_requests to false. The harness attempts to restore both settings."] },
      "other-author": {
        id: "other-author",
        target: "client",
        title: "Configured Bot cannot merge another author PR",
        classification: "negative",
        checks: [
          "bot-ownership",
          "identity-trust"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "rejected",
            "expected": "PR remains unmerged because its author is the owner, not the requesting Bot."
          }
        ],
        identity: [
          "PR author and effective commit identity: civitaspo (ID 4525500).",
          "Command requester: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "The test temporarily adds testing-csm-ci-untrusted-committer[bot] (ID 347402450) to trust.committers and trust.bot_mergers. The repository permits Bot requests and exempts the owner and this Bot from its all-path sensitivity. The harness attempts to restore the original configuration."
        ]
      },
      "mixed-commits": {
        id: "mixed-commits",
        target: "client",
        title: "Configured Bot cannot merge mixed commit identities",
        classification: "negative",
        checks: [
          "bot-ownership",
          "identity-trust"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "rejected",
            "expected": "PR remains unmerged because an owner commit is added after the Bot commit."
          }
        ],
        identity: [
          "PR author and initial effective commit identity: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "Later effective commit identity: civitaspo (ID 4525500). Command requester: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "The test temporarily adds testing-csm-ci-untrusted-committer[bot] (ID 347402450) to trust.committers and trust.bot_mergers. The repository permits Bot requests and exempts the owner and this Bot from its all-path sensitivity. The harness attempts to restore the original configuration."
        ]
      },
      "own-pr": {
        id: "own-pr",
        target: "client",
        title: "Configured Bot merges its own PR",
        classification: "positive",
        checks: [
          "bot-ownership",
          "identity-trust"
        ],
        steps: [
          {
            "operation": "merge",
            "outcome": "permitted",
            "expected": "The configured Bot request succeeds and the Server App merges this PR."
          }
        ],
        identity: [
          "PR author, effective commit identity and command requester: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "The test temporarily adds testing-csm-ci-untrusted-committer[bot] (ID 347402450) to trust.committers and trust.bot_mergers. The repository permits Bot requests and exempts the owner and this Bot from its all-path sensitivity. The harness attempts to restore the original configuration."
        ]
      }
    },
    name: "a configured bot can merge its own pull request but not another author's pull request or commit",
    needsUntrusted: true,
    serial: true,
    run: async (ctx) => {
      assert(ctx.untrusted, "the untrusted test token is not configured");
      await withTestBotConfigured(ctx, async () => withRepositoryPolicy(ctx, { sensitive_paths: { paths: ["**"], exempt: [{ id: TEST_BOT_ID, login: TEST_BOT_LOGIN }, { id: 4525500, login: "civitaspo" }] }, merge: { allow_bot_requests: true } }, async () => {
        await withSignedPr(ctx, async (pr) => {
          const { comment, requestInfo: commentRequest } = await postBotMergeRequest(ctx, pr);
          // Exercise the server's ownership check independently of the client prefilter.
          const requestInfo = ["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.authorAssociation)
            ? commentRequest
            : await request(ctx, pr, comment.id);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /bot merger testing-csm-ci-untrusted-committer\[bot\] can merge only its own pull request/);
          await noMerge(ctx, pr);
          assert(!(await serverComments(ctx, pr)).some((body) => body.includes(marker("merge", comment.id))), "rejected bot ownership request posted a receipt");
        }, prCase(ctx, "other-author"));

        await withRepositoryPolicy(ctx, { merge: { allow_bot_requests: false } }, async () => {
          let denied: Pr | undefined;
          try {
            const opened = await openBotPr(ctx, prCase(ctx, "repository-denied"));
            denied = opened.pr;
            await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: denied.number } }, opened.since, "success");
            const { comment, requestInfo } = await postBotMergeRequest(ctx, denied);
            await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /bot merge requests are disabled for repository/);
            await noMerge(ctx, denied);
            assert(!(await serverComments(ctx, denied)).some((body) => body.includes(marker("merge", comment.id))), "disabled bot request posted a receipt");
          } finally { if (denied) await closePr(ctx, denied); }
        });

        let mixedPr: Pr | undefined;
        try {
          const opened = await openBotPr(ctx, prCase(ctx, "mixed-commits"));
          mixedPr = opened.pr;
          const pr = opened.pr;
          await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: mixedPr.number } }, opened.since, "success");
          const head = await pushSignedCommit(ctx, pr, pr.head);
          await until(`mixed-identity head for pull request #${pr.number}`, async () => {
            const { data: pull } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
            const commits = await ctx.gh.paginate(ctx.gh.rest.pulls.listCommits, { ...splitRepository(CLIENT), pull_number: pr.number, per_page: 100 });
            return pull.head.sha === head && commits.some((commit) => commit.sha === head && commit.author?.id === 4525500) ? true : undefined;
          });
          const { comment, requestInfo } = await postBotMergeRequest(ctx, mixedPr);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "failure", /bot merger testing-csm-ci-untrusted-committer\[bot\] can merge only its own pull request and commits/);
          await noMerge(ctx, mixedPr);
          assert(!(await serverComments(ctx, mixedPr)).some((body) => body.includes(marker("merge", comment.id))), "rejected mixed-identity bot request unexpectedly posted a receipt");
        } finally {
          if (mixedPr) await closePr(ctx, mixedPr);
        }

        let botPr: Pr | undefined;
        try {
          const opened = await openBotPr(ctx, prCase(ctx, "own-pr"));
          botPr = opened.pr;
          await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: botPr.number } }, opened.since, "success");
          const { comment, requestInfo } = await postBotMergeRequest(ctx, botPr);
          await expectOp(ctx, requestInfo.match, requestInfo.since, "success");
          const { data } = await ctx.gh.rest.pulls.get({ owner: "civitaspo", repo: "testing-csm-ci-client", pull_number: botPr.number });
          assert(data.merged && data.merge_commit_sha, `test bot's pull request #${botPr.number} was not merged`);
          assert((await serverComments(ctx, botPr)).some((body) => body.includes(marker("merge", comment.id)) && body.includes("Squash-merged")), "test bot merge has no success receipt");
        } finally {
          if (botPr) await closePr(ctx, botPr);
        }
      }));
    },
  },
];
