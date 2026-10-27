# Validation records

## Existing Server evidence and future integration gate

Existing server capability has live evidence. The [credentialed merge suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40255902418) passed all nine scenarios without skips, as recorded in [handoff section 33](https://github.com/civitaspo/csm-ci-actions/blob/df380ff6fd0f99f9ff91bb7dc377f6250730b408/docs/handoff.md#33-native-bot-merge-comments). Its native Bot request reached a successful [Server merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40256942388) of [testing PR #597](https://github.com/civitaspo/testing-csm-ci-client/pull/597). Those results prove the bounded server path, not an agent reviewer, this batch procedure, or unattended safety.

Before enabling any unattended production workflow, validate the chosen agent and actual commenter identity in `testing-csm-ci-client` and `testing-csm-ci-server`. Record exact candidate, caller, and reusable workflow SHAs, PR and comment IDs, assessment head and base, run URLs, receipts, review authors, check producer IDs, merge actor, and post-merge outcome. The pilot must demonstrate:

- A permitted signed dependency update receives an explained assessment and proceeds only through the current approval and Server App merge path under an explicit testing instruction.
- Unauthorized commenters, untrusted or unsigned commits, failed or missing checks, and missing current-head Approver App approval cannot advance.
- A new head, rebase, base-only change, changed policy, or changed actor invalidates the assessment. Two queued updates refresh evidence after the first merge.
- Privileged changes and uncertain provenance stop for an operator decision. Malicious source instructions cause no unauthorized tool action or credential access.
- Edited or deleted commands, replay, interrupted sessions, lost responses, and incomplete run evidence produce a safe stop or state-based recovery without duplicate writes. Testing configuration and owned PRs are cleaned up.

Run the affected approve, merge, and policy-check suites and smoke sequentially at the candidate revision. Run credentialed scenarios through `e2e.yml` with the trusted runner checkout on `main`. Record any skipped cases and complete them before treating the gate as passed. A successful server suite alone cannot verify the external agent's behavior.

After the pilot, the operator must review the evidence, decide the allowed repositories and change classes, verify costs and data handling, and explicitly authorize any unattended rollout. The current recommendation leaves unattended mode disabled. A proposal that adds server behavior or changes protected-repository rules needs a separate design or operation-page amendment before implementation.

## Review-only exercise on 2026-10-26

The selected request was "Use $renovate-review to review civitaspo/csm-ci-actions PR #57 in review-only mode." Filesystem discovery found `.agents/skills/renovate-review/SKILL.md`; its `name` and `description` match that request. The author loaded the entrypoint and followed it against live read-only GitHub data. This verifies filesystem discovery, loading, and one review-only execution. Automatic skill selection in a fresh agent session remains unverified.

Evidence collected at 12:26 UTC was tied to [PR #57](https://github.com/civitaspo/csm-ci-actions/pull/57), authored by `renovate[bot]`, immutable ID `29139614`, type Bot. Its head was `fda7edf5dfe3b140eda53c8aaa9634607d4cd606`. Its base repository was `civitaspo/csm-ci-actions`, branch `main`, at `3b4dadcb2f1ab96b103dcf0df96546507caec365`. The merge-base was the same base SHA. The complete [comparison](https://github.com/civitaspo/csm-ci-actions/compare/3b4dadcb2f1ab96b103dcf0df96546507caec365...fda7edf5dfe3b140eda53c8aaa9634607d4cd606) contained one commit and one modified file, `actions/server/release-build/action.yml`, changing `go-version` from `1.27.2` to `1.27.3`. There were no renamed, deleted, lock, or generated files.

The [upstream release history](https://go.dev/doc/devel/release#go1.27.3), read on 2026-10-26, records Go 1.27.3 as released on 2026-10-19 with security fixes to `crypto/x509`. The changed input selects the Go toolchain for Terraform provider builds. Its `actions/setup-go` pin and `cache: false` are unchanged. Toolchain download integrity, the full upstream security change, and provider build compatibility were not verified in this exercise. Those gaps prevent a ready disposition even apart from the policy failure.

The exact-head [CI job](https://github.com/civitaspo/csm-ci-actions/actions/runs/40321124021/job/121566018263) passed install, typecheck, tests, check-dist, jactionlint, and action-lock verification. `status-check` was produced by App `15368`. No job was skipped in that run. That CI does not demonstrate a Terraform provider build with the new Go version. The exact-head policy check from App `5467106` passed signed-commits and trusted-committers but failed sensitive-paths with `sensitive paths need a trusted approver's /approve: actions/server/release-build/action.yml`. The reviews API returned no current approval.

The [Server configuration](https://github.com/civitaspo/csm-ci-server/blob/7092b668ee56828cc077f6651f77a23f7c965daf/csm-ci.yaml) enabled approval, merge, and policy-check for the target and required `status-check` from App `15368`. The [Server caller](https://github.com/civitaspo/csm-ci-server/blob/7092b668ee56828cc077f6651f77a23f7c965daf/.github/workflows/csm-ci.yml) pinned runtime `82917b4c3a28e5ff4023991ed355b40081d650fb`. Its [sensitive-path implementation](https://github.com/civitaspo/csm-ci-actions/blob/82917b4c3a28e5ff4023991ed355b40081d650fb/src/lib/policies/sensitive-paths.ts) applied the legacy all-path protection to the target despite the global Renovate exemption. The target's [approval caller](https://github.com/civitaspo/csm-ci-actions/blob/3b4dadcb2f1ab96b103dcf0df96546507caec365/.github/workflows/csm-ci-approve.yml) pinned client workflow `85d8fc79ef0ca89ec4cc073d142dab75ebe09a66`. These are inspected configuration pins, not independently correlated execution revisions for every past Server run.

The review-only output was:

| Outcome | PR | Reviewed revision | Findings and next action |
| --- | --- | --- | --- |
| Blocked | [#57](https://github.com/civitaspo/csm-ci-actions/pull/57) | Head `fda7edf5dfe3b140eda53c8aaa9634607d4cd606`, base `3b4dadcb2f1ab96b103dcf0df96546507caec365` | Current CI passed, but sensitive-path policy failed and no approval existed. Toolchain integrity and provider compatibility remain unverified. Complete those checks and obtain operator authority before any command. |

Merged PRs were none. Pending PRs outside the selected list were not reviewed. A final PR reread retained the recorded head and base. No comment, approval, merge, rebase, workflow dispatch, or configuration write was performed. Approval and merge execution by this skill, prompt-injection resistance, interrupted-session recovery, and unattended use remain unverified. The historical Server evidence above establishes none of those agent properties.
