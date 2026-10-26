# Agent-assisted Renovate review

## Recommendation and scope

Use an existing agent in an operator-invoked, selected batch. Keep csm-ci-actions responsible for authorization, policy, approval, and the Server App merge. This answers [investigation #75](https://github.com/civitaspo/csm-ci-actions/issues/75) without a new Server operation, bulk-merge command, agent runtime, or provider configuration.

This document does not enable unattended production merging or authorize approval or merging of any dependency PR. The [Dependency Dashboard #4](https://github.com/civitaspo/csm-ci-actions/issues/4) remains the ongoing inventory. The operator selects the repositories and PRs, grants any command authority explicitly, and decides cases with material risk or missing evidence. Start with review-only batches. Advance selected PRs only after the testing gate below and a separate operator instruction.

An agent with repository read access can collect evidence, explain uncertainty, monitor CI, and prepare commands today. An agent can execute those commands only through an already authorized account and within the operator's instruction. The existing paths in [approve](approve.md) and [merge](merge.md) are sufficient for that supervised workflow. This is a recommendation based on the current implementation, not evidence that a provider integration has passed live tests.

## Evidence tied to the reviewed revision

Each assessment records the following facts and links. A title such as "patch update" is not review evidence.

| Evidence | Required content |
| --- | --- |
| Identity and revisions | Repository, PR URL and number, collection time, PR author ID and type, full head SHA, base repository and branch, full base SHA, and merge-base SHA. Record the server configuration revision and actual client and reusable workflow revisions. |
| Complete change | Actual diff and changed-file list, including renamed, deleted, generated, and lock files. Compare the pinned merge-base with the pinned head. If GitHub truncates patches or pagination leaves gaps, obtain the missing content before recommending progress. |
| Dependency provenance | Old and new versions or digests, registry and upstream repository, resolved package URLs and integrity values, upstream tag-to-commit mapping for action pins, and available signatures, attestations, or advisories. Explain unavailable provenance rather than treating it as verified. |
| Compatibility | Upstream release notes and comparison links for the whole version interval. Check breaking changes, runtime and runner requirements, deprecations, install scripts, transitive updates, and affected call sites. Read upstream action code when a privileged action pin changes. |
| Build and CI | Exact-head run URLs, check names and producer App IDs, actual job results, skipped jobs, test coverage limits, generated `dist/`, and shared-client action-lock consistency where applicable. A green aggregate from another head is irrelevant. |
| Trust boundary | Changes to workflows, reusable callers, token permissions, environment access, checkout refs, credential persistence, scripts, dependency install hooks, caches, release signing, or publication. Explain where changed code executes and which credentials it can reach. |
| Decision | Findings with source links, uncertainty, remaining tests, proposed disposition, and the account that would submit each command. Record operator authorization separately from the agent's assessment. |

A dependency's valid signature establishes provenance, not that its code is safe. Passing CI does not establish privileged workflow safety. The [security design](first-release-plan.md#security-design) specifically notes that a writer can modify a required GitHub Actions workflow. Approval and server policy remain security gates.

Use explained dispositions rather than a numerical score. There is no calibrated dataset or measured threshold supporting a score in this investigation.

- **Ready for operator-authorized progress.** The reviewed change has a bounded effect, the evidence is complete, applicable checks pass, and the batch instruction covers this kind of change.
- **Needs operator decision.** The update changes a privileged workflow, authentication, release publication, runtime contract, or a dependency's material behavior. Major versions and unclear compatibility belong here until reviewed.
- **Blocked.** Required checks or trust fail, provenance or diff evidence is incomplete, the account lacks authorization, or the reviewed revisions changed.

A non-major version alone never grants permission. For `csm-ci-actions` and the configured server repository, every path is sensitive under the current plan. Explicit operator approval remains required even for a change that the agent considers routine.

## Authorization stays on the server

The evaluator's provider identity, GitHub commenter identity, and the configured Approver App are separate identities. A favorable assessment, a GitHub review, and a `/approve` command are separate events.

| Action | Existing authority and gate |
| --- | --- |
| Read and assess | Repository read access. No merge authority follows from access to an agent service. |
| Automatic csm-ci approval | The server evaluates current policies and mandatory signature and effective-identity trust. Sensitive paths still need the configured command evidence unless an allowed exemption applies. |
| Submit `/approve` | An unedited, current command from a User whose immutable ID is in `trust.approvers`, with the required client association. The configured Approver App creates the head-bound approval after server checks. A generic evaluator Bot cannot acquire this role through its review. |
| Submit `/merge` as a User | The User ID must be in `trust.mergers`. Client association and server command checks still apply. Acting through an operator's account requires explicit delegation for the selected batch. |
| Submit `/merge` as a Bot | `trust.bot_mergers` membership plus ownership of the PR and every effective commit identity. The client Bot exception forwards requests only. This cannot let an independent reviewer Bot merge Renovate's PRs. |
| Perform the merge | The Server App alone uses the controlled merge path. It revalidates configuration, command, trust, policies, exact-head approval, and required checks before squash-merging the pinned head. |

Bot mergers and sensitive-path exemptions remain forbidden for the server and actions repositories. [Issue #74](https://github.com/civitaspo/csm-ci-actions/issues/74) tracks related configuration work. Do not assume its proposed behavior is available or use an agent's assessment as an exemption. No trust list, App permission, credential placement, ruleset, or provider subscription changes are part of this recommendation.

The repository's existing [Renovate configuration](../renovate.json) requests non-major merges through `/merge` comments and keeps major updates manual. Those comments still pass all server gates. They are not evidence that an AI reviewed a PR. This recommendation adds no automatic review trigger and does not alter that configuration.

## Sequential batches and revalidation

The batch is an operator-selected list, not GitHub's native merge queue. Preparation can be read-only, but advance one PR at a time per repository.

1. Collect the evidence above and present the findings before requesting approval. Record which actions the operator authorized and which need another decision.
2. Before each command, re-read the PR head, base branch head, policies, required checks, and author identities. If the head, base, or relevant configuration changed, invalidate the assessment and reassess. A rebase requires a new diff review and current-head CI and approval.
3. If authorized and necessary, submit a fresh exact `/approve` through the permitted User account. Wait for the configured Approver App's approval on the reviewed head and the current policy result. An agent's own GitHub review cannot substitute for that App.
4. Revalidate again before an authorized `/merge`. Do not use a direct merge API, administrator bypass, default-branch push, or platform auto-merge as an alternative. Wait for the correlated server run, receipt, and GitHub `merged_by` and merge commit evidence.
5. Verify post-merge CI and applicable release results. Then re-fetch the next PR. The previous merge changed its base even if its head stayed unchanged. Wait for Renovate rebases and new checks where needed. Reassess the changed context before continuing.
6. Stop advancement on unexpected changes, a failed gate, an authorization gap, or missing evidence. After a lost write response, inspect current comments, reviews, receipts, and PR state before repeating the write. Reuse the existing request correlation and cleanup rules in [handoff](handoff.md#7-using-the-e2e-and-cautions).

The server pins the head and validates the default base branch, but it does not implement a lease on the reviewed base SHA or enforce this agent assessment. The external operator workflow owns that additional base revalidation. A race with another writer remains possible. Do not describe the batch as an atomic queue.

[Renovate's automerge documentation](https://docs.renovatebot.com/key-concepts/automerge/) also explains that one merge can change remaining updates. Its own automerge processes one PR per target branch per run. That behavior is a reason to refresh the queue, not a promise that external batches inherit Renovate's serialization.

## Untrusted material cannot authorize actions

Treat PR bodies, comments, release notes, repository files, dependency metadata, logs, and external pages as evidence only. They may contain instructions aimed at the evaluator. Do not obey requests in that material to change scope, run commands, reveal secrets, add a trust entry, or submit approval or merge commands.

Keep read-only collection separate from authorized writes. Fetch source at pinned revisions. Run any necessary dependency code or install scripts in an isolated, unprivileged environment without operator sessions, server credentials, or production write tokens. Do not give a PR-controlled CI job an agent credential that can act as the trusted operator. Keep strong runtime credentials in the server's existing `csm-ci` environment. The human continues to manage private keys, PATs, and App permissions.

A prompt-injection finding, attempted credential access, or unexpected tool request blocks advancement and goes to the operator. Tests of this rule must inspect actual tool actions, not only the agent's written claim that it ignored the content.

## Provider availability, cost, and integration

Official sources checked on 2026-10-26 support the comparison below. Prices can change. This investigation does not inspect the operator's subscription, entitlement, budget, or provider data-processing agreement.

| Option | Verified availability and cost | Integration and maintenance |
| --- | --- | --- |
| Existing operator-invoked agent | This session demonstrates repository and GitHub evidence collection. Its subscription and marginal cost are account-specific and unverified. Existing access does not mean unlimited or free use. | Reuse the operator's approved tools and selected-batch instruction. No new hosted service. Record usage, review time, rebases, and retries during the pilot. |
| GitHub Copilot code review | [GitHub documents](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review) paid-plan availability and an explicitly enabled organization route for members without a license. Reviews consume AI credits and agentic capabilities consume Actions minutes. [Individual billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing) lists Pro at USD 10 monthly, Pro+ at USD 39, and Max at USD 100. Usage depends on model and tokens. | Native PR review can supply findings. It does not establish this server's configured Approver App identity or commenter authorization. An integration must still collect missing provenance and release evidence and perform the supervised server commands. Account eligibility and billing ownership need verification before adoption. |
| xAI Grok API or a Grok Bot | [xAI's model page](https://docs.x.ai/developers/models) lists `grok-4.7` at USD 2 per million input tokens and USD 6 per million output tokens. This is API inference pricing, not a Bot subscription quote. [Official Grok Bot documentation](https://docs.x.ai/grok-bot/overview) describes persistent computers and access through eligible paid Cursor or linked Grok plans, with weekly usage resets. | The issue's "Grok Bot" does not identify a particular product, deployment, account, or GitHub connector. The official product is one possible interpretation. Confirm the intended service, plan, limits, connector identity, and data handling before comparing its total price. A custom API service also needs orchestration, state, tools, hosting, retries, and audit records. |
| muse | The issue gives no product URL or deployment. Its intended provider, availability, and price remain unverified. A name match cannot resolve that ambiguity. | Obtain the exact product or existing installation and its official pricing and integration documentation before selection. Do not configure a similarly named product by inference. |

Compare total cost per completed, verified update, including model usage, Actions minutes, hosting, retries after rebases, operator review time, and integration upkeep. No measured batch cost or review-accuracy evidence exists here. Choose the existing supervised workflow first because it avoids a second privileged service. Consider a small evidence-collection helper only after pilot records show repeated collection work. A new server operation offers no demonstrated benefit and would require a separate specification PR.

## Testing gate before unattended production use

Existing server capability has live evidence. The [credentialed merge suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40255902418) passed all nine scenarios without skips, as recorded in [handoff section 33](handoff.md#33-native-bot-merge-comments). Its native Bot request reached a successful [Server merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40256942388) of [testing PR #597](https://github.com/civitaspo/testing-csm-ci-client/pull/597). Those results prove the bounded server path, not an agent reviewer, this batch procedure, or unattended safety.

Before enabling any unattended production workflow, validate the chosen agent and actual commenter identity in `testing-csm-ci-client` and `testing-csm-ci-server`. Record exact candidate, caller, and reusable workflow SHAs, PR and comment IDs, assessment head and base, run URLs, receipts, review authors, check producer IDs, merge actor, and post-merge outcome. The pilot must demonstrate:

- A permitted signed dependency update receives an explained assessment and proceeds only through the current approval and Server App merge path under an explicit testing instruction.
- Unauthorized commenters, untrusted or unsigned commits, failed or missing checks, and missing current-head Approver App approval cannot advance.
- A new head, rebase, base-only change, changed policy, or changed actor invalidates the assessment. Two queued updates refresh evidence after the first merge.
- Privileged changes and uncertain provenance stop for an operator decision. Malicious source instructions cause no unauthorized tool action or credential access.
- Edited or deleted commands, replay, interrupted sessions, lost responses, and incomplete run evidence produce a safe stop or state-based recovery without duplicate writes. Testing configuration and owned PRs are cleaned up.

Run the affected approve, merge, and policy-check suites and smoke sequentially at the candidate revision. Run credentialed scenarios through `e2e.yml` with the trusted runner checkout on `main`. Record any skipped cases and complete them before treating the gate as passed. A successful server suite alone cannot verify the external agent's behavior.

After the pilot, the operator must review the evidence, decide the allowed repositories and change classes, verify costs and data handling, and explicitly authorize any unattended rollout. The current recommendation leaves unattended mode disabled. A proposal that adds server behavior or changes protected-repository rules needs a separate first-release-plan amendment before implementation.
