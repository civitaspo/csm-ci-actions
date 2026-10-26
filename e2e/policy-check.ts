import { z } from "zod";
import { POLICY_FAILURE_MARKER } from "../src/lib/policy-report.ts";
import { withRepositoryPolicy } from "./repository-policy.ts";
import { OWNER_IDENTITY } from "./pr-metadata.ts";
import { prCase } from "./harness.ts";
import { type GitHub, splitRepository } from "../src/lib/github.ts";
import { marker } from "../src/lib/notify.ts";
import {
  assert,
  CLIENT,
  expectOp,
  jobs,
  jobLog,
  recentWorkflowRuns,
  serverRuns,
  waitRun,
  openPr,
  type Pr,
  postComment,
  type Scenario,
  SERVER,
  smokeRequest,
  until,
  type Ctx,
  closePr,
} from "./harness.ts";

const SERVER_APP_ID = 5455185;
const SENSITIVE_FILE = `.github/e2e-policy-${Date.now().toString(36)}.yml`;
const OWNER_REVIEWER = { name: "civitaspo", email: "4525500+civitaspo@users.noreply.github.com" };

type PolicyCheck = Awaited<ReturnType<GitHub["rest"]["checks"]["listForRef"]>>["data"]["check_runs"][number];

async function checkForHead(ctx: Ctx, pr: Pr): Promise<PolicyCheck> {
  return until(`the csm-ci/policy check for ${pr.head}`, async () => {
    const checks = await ctx.gh.paginate(ctx.gh.rest.checks.listForRef, { ...splitRepository(CLIENT), ref: pr.head, per_page: 100 });
    const check = checks.find((item) => item.name === "csm-ci/policy" && item.external_id === pr.head && item.status === "completed");
    return check;
  });
}

async function expectPolicy(ctx: Ctx, pr: Pr, since: Date, conclusion: "success" | "failure", failedPolicy?: string): Promise<PolicyCheck> {
  await expectOp(ctx, { kind: "policy-check", repository: CLIENT, args: { pull_number: pr.number } }, since, "success");
  const check = await checkForHead(ctx, pr);
  assert(check.status === "completed", `policy check is ${check.status}`);
  assert(check.conclusion === conclusion, `policy check concluded ${check.conclusion}, expected ${conclusion}`);
  assert(Number(check.app?.id) === SERVER_APP_ID, `policy check was created by app ${check.app?.id}, expected Server App ${SERVER_APP_ID}`);
  assert(check.output?.summary?.includes("| Policy | Result | Details |"), "policy check has no result table");
  if (failedPolicy) assert(check.output?.summary?.includes(`| ${failedPolicy} | fail |`), `policy check summary does not show ${failedPolicy} failed`);
  return check;
}

async function requestPolicy(ctx: Ctx, pr: Pr): Promise<Date> {
  const before = await checkForHead(ctx, pr);
  const request = await smokeRequest(ctx, "policy-check", String(pr.number));
  await expectOp(ctx, { kind: "policy-check", repository: CLIENT, args: { pull_number: pr.number }, label: request.label }, request.since, "success");
  await until("the policy check refresh", async () => {
    const updated = await checkForHead(ctx, pr);
    return updated.completed_at && before.completed_at && Date.parse(updated.completed_at) > Date.parse(before.completed_at) ? updated : undefined;
  });
  return request.since;
}

async function openPolicyPr(ctx: Ctx, kind: "signed" | "unsigned", sensitive = false, prAs?: Ctx["untrusted"], commitAs: Ctx["untrusted"] = ctx.gh, draft = false): Promise<{ pr: Pr; since: Date }> {
  const since = new Date(Date.now() - 2_000);
  const pr = await openPr(ctx, {
    intent: prCase(ctx, "fixture"), kind, as: commitAs,
    author: kind === "signed" ? undefined : OWNER_REVIEWER,
    prAs: prAs ?? ctx.gh, filePath: sensitive ? SENSITIVE_FILE : undefined, draft,
  });
  return { pr, since };
}

async function closePolicyPr(ctx: Ctx, pr: Pr): Promise<void> {
  const { data } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
  // A PR reset to main counts as merged, so GitHub may already have deleted its branch.
  await closePr(ctx, { ...pr, branch: data.head.ref });
}

async function withPolicyPr(ctx: Ctx, kind: "signed" | "unsigned", sensitive: boolean, fn: (pr: Pr, check: PolicyCheck) => Promise<void>, prAs?: Ctx["untrusted"]): Promise<void> {
  const { pr, since } = await openPolicyPr(ctx, kind, sensitive, prAs);
  try {
    const check = await expectPolicy(ctx, pr, since, "success");
    await fn(pr, check);
  } finally {
    await closePolicyPr(ctx, pr);
  }
}

function untrusted(ctx: Ctx) {
  assert(ctx.untrusted, "the untrusted committer token is not set");
  return ctx.untrusted;
}

async function policyReports(ctx: Ctx, pr: Pr) {
  const comments = await ctx.gh.paginate(ctx.gh.rest.issues.listComments, {
    ...splitRepository(CLIENT), issue_number: pr.number, per_page: 100, mediaType: { format: "full" },
  });
  const reports = [];
  for (const comment of comments.filter((c) => Number(c.user?.id) === 347400474 && c.user?.type === "Bot" && c.body?.startsWith(`${POLICY_FAILURE_MARKER}\n`))) {
    const response: unknown = await ctx.gh.graphql("query($id: ID!) { node(id: $id) { ... on IssueComment { databaseId isMinimized minimizedReason } } }", { id: comment.node_id });
    const { node } = z.object({ node: z.object({ databaseId: z.number(), isMinimized: z.boolean(), minimizedReason: z.string().nullable() }) }).parse(response);
    assert(node.databaseId === Number(comment.id), "policy report GraphQL identity differs from REST");
    reports.push({ id: Number(comment.id), body: comment.body ?? "", html: comment.body_html ?? "", ...node });
  }
  return reports;
}

export const policyCheck: Scenario[] = [
  {
    id: "policy-check.repository-sensitivity",
    cases: { fixture: { id: "fixture", target: "client", title: "Repository sensitivity requires command approval and recovers", classification: "mixed", checks: ["path-safety", "approval-policy"], steps: [{ operation: "policy-check", outcome: "rejected", expected: "All-path repository sensitivity with no exemptions fails the policy" }, { operation: "approve", outcome: "permitted", expected: "Owner command approval restores a successful policy check" }], identity: OWNER_IDENTITY } },
    name: "repository sensitivity with empty exemptions requires command approval and recovers",
    serial: true,
    run: async (ctx) => withRepositoryPolicy(ctx, { sensitive_paths: { paths: ["**"], exempt: [] }, merge: { allow_bot_requests: false } }, async () => {
      const { pr, since } = await openPolicyPr(ctx, "signed");
      try {
        await expectPolicy(ctx, pr, since, "failure", "sensitive-paths");
        const first = await until("one active policy failure report", async () => {
          const reports = await policyReports(ctx, pr);
          return reports.length === 1 && !reports[0]?.isMinimized ? reports[0] : undefined;
        });
        assert(first.body.includes("sensitive paths need a trusted approver"), "policy report omits its actual reason");
        assert(first.html.includes("<sub>"), "policy metadata does not render as subscript");
        assert(first.html.indexOf("Policy check failed") < first.html.indexOf("<sub>"), "the actionable failure is inside metadata");
        await requestPolicy(ctx, pr);
        const retried = await policyReports(ctx, pr);
        assert(retried.length === 1 && retried[0]?.id === first.id, "identical policy retry duplicated the active report");
        const changedSince = new Date(Date.now() - 2_000);
        const changed = await ctx.gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
          "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
          { i: { branch: { repositoryNameWithOwner: CLIENT, branchName: pr.branch }, expectedHeadOid: pr.head,
            message: { headline: "e2e change the policy failure" },
            fileChanges: { additions: [{ path: `e2e/${pr.branch}-second.txt`, contents: Buffer.from("another sensitive path\n").toString("base64") }] } } },
        );
        pr.head = changed.createCommitOnBranch.commit.oid;
        await expectPolicy(ctx, pr, changedSince, "failure", "sensitive-paths");
        await until("superseded policy failure is outdated", async () => {
          const reports = await policyReports(ctx, pr);
          return reports.length === 2 && reports.filter((r) => !r.isMinimized).length === 1 && reports.find((r) => r.id === first.id)?.minimizedReason?.toLowerCase() === "outdated" ? true : undefined;
        });
        const command = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: command.id } }, command.since, "success");
        const refreshed = await checkForHead(ctx, pr);
        assert(refreshed.conclusion === "success", `command approval left policy ${refreshed.conclusion}`);
        await until("all policy failure history is resolved", async () => {
          const reports = await policyReports(ctx, pr);
          return reports.length === 2 && reports.every((r) => r.isMinimized && r.minimizedReason?.toLowerCase() === "resolved") ? true : undefined;
        });
        await requestPolicy(ctx, pr);
        const recovered = await policyReports(ctx, pr);
        assert(recovered.length === 2 && recovered.every((r) => r.minimizedReason?.toLowerCase() === "resolved"), "repeated recovery changed resolved history");
      } finally { await closePolicyPr(ctx, pr); }
    }),
  },

  {
    id: "policy-check.trusted",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "signed, trusted commits and ordinary paths pass every policy",
        classification: "positive",
        checks: [
          "identity-trust",
          "signature",
          "approval-policy"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "permitted",
            "expected": "The policy check reports success on signed trusted ordinary changes"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "signed, trusted commits and ordinary paths pass every policy",
    run: (ctx) => withPolicyPr(ctx, "signed", false, async (_pr, check) => {
      for (const policy of ["signed-commits", "trusted-committers", "sensitive-paths"]) {
        assert(check.output?.summary?.includes(`| ${policy} | pass |`), `policy check summary does not show ${policy} passing`);
      }
    }),
  },
  {
    id: "policy-check.closed-shared-sha",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a delayed request after resetting a PR to main and closing it leaves shared-SHA checks untouched",
        classification: "negative",
        checks: [
          "head-consistency",
          "request-validation"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "A delayed request for a reset closed PR leaves checks on the shared main SHA unchanged"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "a delayed request after resetting a PR to main and closing it leaves shared-SHA checks untouched",
    run: async (ctx) => {
      const { pr, since } = await openPolicyPr(ctx, "signed");
      try {
        await expectPolicy(ctx, pr, since, "success");
        const { data: main } = await ctx.gh.rest.git.getRef({ ...splitRepository(CLIENT), ref: "heads/main" });
        const resetSince = new Date(Date.now() - 2_000);
        await ctx.gh.rest.git.updateRef({ ...splitRepository(CLIENT), ref: `heads/${pr.branch}`, sha: main.object.sha, force: true });
        const reset = await until("the PR head reset to main", async () => {
          const { data: current } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
          return current.head.sha === main.object.sha && current.base.sha === main.object.sha && current.commits === 0 ? current : undefined;
        });
        if (reset.state === "open") await ctx.gh.rest.pulls.update({ ...splitRepository(CLIENT), pull_number: pr.number, state: "closed" });
        await until("the closed PR retains the zero-commit head", async () => {
          const { data: current } = await ctx.gh.rest.pulls.get({ ...splitRepository(CLIENT), pull_number: pr.number });
          return current.state === "closed" && current.head.sha === main.object.sha && current.base.sha === main.object.sha && current.commits === 0 ? current : undefined;
        });
        // Drain both synchronize requests before adding another request to the PR's concurrency group.
        for (const { workflow, title, kind } of [
          { workflow: "csm-ci-policy-check.yml", title: `csm-ci policy check #${pr.number}`, kind: "policy-check" },
          { workflow: "csm-ci-approve.yml", title: `csm-ci request #${pr.number} comment #automatic`, kind: "approve" },
        ]) {
          const automatic = await until(`the ${kind} synchronize run for #${pr.number}`, async () =>
            (await recentWorkflowRuns(ctx, CLIENT, workflow, "pull_request_target", resetSince)).find((run) => run.display_title === title));
          await waitRun(ctx, CLIENT, automatic.id);
          const requestJob = await until(`the automatic ${kind} request job`, async () => (await jobs(ctx, CLIENT, automatic.id)).get("request"));
          assert(requestJob.conclusion === "success", `automatic ${kind} request did not succeed (${automatic.html_url})`);
          const label = /created label (csm-ci-[^ ]+) \(/.exec(await jobLog(ctx, CLIENT, requestJob.id))?.[1];
          assert(label, `automatic request label missing from ${automatic.html_url}`);
          await until(`the automatic ${kind} server run to finish`, async () =>
            (await serverRuns(ctx, { kind, repository: CLIENT, args: { pull_number: pr.number }, label }, resetSince))[0]);
        }
        const snapshot = async () => {
          const checks = await ctx.gh.paginate(ctx.gh.rest.checks.listForRef, { ...splitRepository(CLIENT), ref: main.object.sha, per_page: 100 });
          return JSON.stringify(checks.filter((check) => check.name === "csm-ci/policy" && Number(check.app?.id) === SERVER_APP_ID).sort((a, b) => String(a.id).localeCompare(String(b.id))));
        };
        const before = await snapshot();
        for (let attempt = 0; attempt < 2; attempt++) {
          const request = await smokeRequest(ctx, "policy-check", String(pr.number));
          await expectOp(ctx, { kind: "policy-check", repository: CLIENT, args: { pull_number: pr.number }, label: request.label }, request.since, "success", /Policy check skipped: #[0-9]+ is closed/);
          assert(await snapshot() === before, "the closed PR request created or overwrote a policy check on main");
        }
      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
  {
    id: "policy-check.unsigned",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "an unsigned commit fails the signed-commits policy",
        classification: "negative",
        checks: [
          "signature",
          "approval-policy"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "The server operation completes but the policy check reports signed-commits failure"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "an unsigned commit fails the signed-commits policy",
    run: async (ctx) => {
      const { pr, since } = await openPolicyPr(ctx, "unsigned");
      try {
        const check = await expectPolicy(ctx, pr, since, "failure", "signed-commits");
        assert(check.output?.summary?.includes("is not signed and verified"), "signed-commits check omits its rejection reason");
      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
  {
    id: "policy-check.untrusted",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a signed commit by an untrusted committer fails trusted-committers",
        classification: "negative",
        checks: [
          "identity-trust",
          "approval-policy"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "The server operation completes but the policy check reports trusted-committers failure"
          }
        ],
        identity: [
          "PR author: civitaspo (ID 4525500).",
          "Effective commit identity: testing-csm-ci-untrusted-committer[bot] (ID 347402450) via a GitHub-signed App commit. The Bot is not a trusted committer.",
          "Command requester: civitaspo (ID 4525500); automatic operations originate from the fixture workflow. Trust is configured by immutable IDs."
        ]
      }
    },
    name: "a signed commit by an untrusted committer fails trusted-committers",
    needsUntrusted: true,
    run: async (ctx) => {
      const token = untrusted(ctx);
      const { pr, since } = await openPolicyPr(ctx, "signed", false, undefined, token);
      try {
        // The helper reports a successfully completed operation; the check itself carries policy failure.
        const check = await expectPolicy(ctx, pr, since, "failure", "trusted-committers");
        assert(check.output?.summary?.includes("not a trusted committer"), "trusted-committers check omits its rejection reason");
      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
  {
    id: "policy-check.sensitive-approval",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a sensitive file needs the marked approver review and /recheck refreshes the check",
        classification: "mixed",
        checks: [
          "approval-policy",
          "path-safety"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "Before the marked approval the policy check fails"
          },
          {
            "operation": "policy-check",
            "outcome": "permitted",
            "expected": "A marked approver review permits the sensitive path and updates the head check"
          }
        ],
        identity: [
          "PR author: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "Effective commit identity: civitaspo (ID 4525500); GitHub-signed commits use the owner as author and web-flow as committer.",
          "Command requester and test review author: civitaspo (ID 4525500). Only the configured Approver App review can carry effective sensitive-path approval."
        ]
      }
    },
    name: "a sensitive file needs the marked approver review and /recheck refreshes the check",
    needsUntrusted: true,
    run: async (ctx) => {
      const token = untrusted(ctx);
      const { pr, since } = await openPolicyPr(ctx, "signed", true, token);
      try {
        const failed = await expectPolicy(ctx, pr, since, "failure", "sensitive-paths");
        assert(failed.output?.summary?.includes("sensitive paths need a trusted approver's /approve"), "sensitive-paths check omits the missing approval reason");

        const command = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: command.id } }, command.since, "success");
        const passed = await checkForHead(ctx, pr);
        assert(passed.id === failed.id, "the /approve path created a second check instead of updating the head's check");
        assert(passed.conclusion === "success", `policy check after /approve concluded ${passed.conclusion}`);
        assert(passed.output?.summary?.includes("| sensitive-paths | pass |"), "sensitive-paths did not pass after the marked approval");

      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
  {
    id: "policy-check.recheck",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "/recheck reevaluates policies and updates the current head check",
        classification: "positive",
        checks: [
          "approval-policy",
          "head-consistency"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "permitted",
            "expected": "Recheck reevaluates policies and refreshes the current head check"
          }
        ],
        identity: OWNER_IDENTITY
      }
    },
    name: "/recheck reevaluates policies and updates the current head check",
    run: (ctx) => withPolicyPr(ctx, "signed", false, async (pr, before) => {
      const recheck = await postComment(ctx, pr, "/recheck");
      await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: recheck.id } }, recheck.since, "success");
      const refreshed = await until("the policy check updated by /recheck", async () => {
        const check = await checkForHead(ctx, pr);
        return check.id === before.id && check.completed_at && before.completed_at && Date.parse(check.completed_at) > Date.parse(before.completed_at) ? check : undefined;
      });
      assert(refreshed.conclusion === "success", `/recheck policy check concluded ${refreshed.conclusion}`);
      assert(Number(refreshed.app?.id) === SERVER_APP_ID, "/recheck replaced the Server App policy check");
    }),
  },
  {
    id: "policy-check.non-approver-marker",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a marker in a review by a non-approver cannot authorize sensitive paths",
        classification: "negative",
        checks: [
          "approval-policy",
          "identity-trust"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "A marker in a non-approver review does not authorize the sensitive path"
          }
        ],
        identity: [
          "PR author: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "Effective commit identity: civitaspo (ID 4525500); GitHub-signed commits use the owner as author and web-flow as committer.",
          "Command requester and test review author: civitaspo (ID 4525500). Only the configured Approver App review can carry effective sensitive-path approval."
        ]
      }
    },
    name: "a marker in a review by a non-approver cannot authorize sensitive paths",
    needsUntrusted: true,
    run: async (ctx) => {
      const { pr, since } = await openPolicyPr(ctx, "signed", true, untrusted(ctx), ctx.gh, true);
      try {
        await expectPolicy(ctx, pr, since, "failure", "sensitive-paths");
        const comment = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } }, comment.since, "failure", /is a draft/);
        await ctx.gh.rest.pulls.createReview({ ...splitRepository(CLIENT), pull_number: pr.number, event: "APPROVE", body: marker("approve:command", comment.id) });
        await requestPolicy(ctx, pr);
        const check = await checkForHead(ctx, pr);
        assert(check.conclusion === "failure", "a review by a non-approver passed sensitive-paths");
        assert(check.output?.summary?.includes("| sensitive-paths | fail |"), "the non-approver marker was not reported as a sensitive-paths failure");
      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
  {
    id: "policy-check.comment-marker",
    cases: {
      fixture: {
        id: "fixture",
        target: "client",
        title: "a COMMENT review carrying an approval marker cannot authorize sensitive paths",
        classification: "negative",
        checks: [
          "approval-policy",
          "command-evidence"
        ],
        steps: [
          {
            "operation": "policy-check",
            "outcome": "rejected",
            "expected": "A COMMENT review marker does not authorize the sensitive path"
          }
        ],
        identity: [
          "PR author: testing-csm-ci-untrusted-committer[bot] (ID 347402450).",
          "Effective commit identity: civitaspo (ID 4525500); GitHub-signed commits use the owner as author and web-flow as committer.",
          "Command requester and test review author: civitaspo (ID 4525500). Only the configured Approver App review can carry effective sensitive-path approval."
        ]
      }
    },
    name: "a COMMENT review carrying an approval marker cannot authorize sensitive paths",
    needsUntrusted: true,
    run: async (ctx) => {
      const { pr, since } = await openPolicyPr(ctx, "signed", true, untrusted(ctx), ctx.gh, true);
      try {
        await expectPolicy(ctx, pr, since, "failure", "sensitive-paths");
        const comment = await postComment(ctx, pr, "/approve");
        await expectOp(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: pr.number, comment_id: comment.id } }, comment.since, "failure", /is a draft/);
        await ctx.gh.rest.pulls.createReview({ ...splitRepository(CLIENT), pull_number: pr.number, event: "COMMENT", body: marker("approve:command", comment.id) });
        await requestPolicy(ctx, pr);
        const check = await checkForHead(ctx, pr);
        assert(check.conclusion === "failure", "a COMMENT review passed sensitive-paths");
        assert(check.output?.summary?.includes("| sensitive-paths | fail |"), "the COMMENT marker was not reported as a sensitive-paths failure");
      } finally {
        await closePolicyPr(ctx, pr);
      }
    },
  },
];
