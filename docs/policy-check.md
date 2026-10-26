# Policy check

The `policy-check` operation evaluates the effective repository policies in `csm-ci.yaml` against the pull request's current head. It creates or updates the `csm-ci/policy` check run with the Server App and pins `external_id` to that head. The check summary contains one row per policy.

Closed pull requests skip evaluation and publication. Immediately before creating or updating a check, the server rereads the pull request and skips publication if it closed or its head changed. This also protects policy refreshes after approval. Skips leave existing checks untouched and the standalone action reports `result=skipped` with a reason in its log. An open pull request with no commits still fails both trust policies.

The `signed-commits` and `trusted-committers` policies always run, even when omitted from configuration. `sensitive-paths` checks changed and renamed paths against the configured patterns. Include these default paths when you want the standard dependency, build, and workflow coverage:

```yaml
paths:
  - "**/Cargo.toml"
  - "**/Cargo.lock"
  - "**/package.json"
  - "**/package-lock.json"
  - "**/npm-shrinkwrap.json"
  - "**/bun.lock*"
  - "**/yarn.lock"
  - "**/pnpm-lock.yaml"
  - "**/go.mod"
  - "**/go.sum"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
  - "**/Pipfile*"
  - "**/poetry.lock"
  - "**/uv.lock"
  - "**/Gemfile*"
  - "**/composer.*"
  - "**/Package.swift"
  - "**/Package.resolved"
  - "Makefile"
  - "**/Dockerfile*"
  - "**/.goreleaser.*"
  - "scripts/**"
  - "**/build.rs"
  - ".cargo/**"
  - ".github/**"
```

The policy fails closed at 3,000 changed files. Exemptions apply only when the pull request author and every commit have the same user identity.

Sensitive changes require a current approval by the configured approver App, pinned to the head, with an `approve:command` marker. The marker points to the source `/approve` comment, which must still exist, remain unedited, and have been written by a configured trusted approver. Ordinary GitHub UI approvals do not authorize sensitive paths. The existing runtime treats every path in the server repository and `civitaspo/csm-ci-actions` as sensitive and ignores exemptions. The [repository policy contract and staged migration](first-release-plan.md#repository-policy-overrides-and-staged-migration) replace that fixed rule with explicit server configuration. This specification requires separate implementation and deployment.

The `/approve` command first validates all trust and configured policies other than `sensitive-paths`, then writes its marked approval, and finally refreshes `csm-ci/policy`. This provides the approval evidence required by `sensitive-paths` without creating an approval cycle. Automatic approval and `/recheck` refresh the same check after their evaluation.

The client workflow runs on pull request open, synchronize, reopen, ready-for-review and edited events. It never checks out pull request code. `/recheck` also causes a fresh evaluation through the approve request path.

## Repository policy configuration

The approved repository policy contract adds optional `repositories[].sensitive_paths.paths` and `repositories[].sensitive_paths.exempt`. Each omitted list inherits its global value. Each explicit list replaces its global value, including `[]`. Empty paths match no files. Empty exemptions disable inherited exemptions. The existing first matching repository entry supplies the overrides.

Without a global sensitive-path policy or a repository override, that policy remains disabled. A repository override enables it and uses empty lists for components with no configured value. Preserve the file-count limit, renamed-path checks, signature and trust checks, and the condition that the PR author and every commit have the same effective identity for an exemption.

Automatic approval, command approval, `/recheck`, standalone policy-check, and merge reevaluation share these effective settings. A sensitive-path exemption does not grant permission to request a Bot merge. The independent `repositories[].merge.allow_bot_requests` setting controls that permission under the existing global Bot trust list.

## Failure reports and recovery

This section specifies the requested lifecycle from [issue #71](https://github.com/civitaspo/csm-ci-actions/issues/71). It requires a separate runtime implementation and live verification. The existing check name, head-bound `external_id`, summary, policy decisions, and approval requirements stay unchanged.

The shared full check publication path manages the lifecycle for standalone policy-check, automatic approval, the final `/approve` refresh, and `/recheck`. It uses the same evaluated results for the check and the report. The evaluator itself has no comment side effects. Merge readiness evaluations and `/approve` preflight do not report failures or resolve them. A preflight that omits a policy or provisionally accepts command approval cannot establish recovery.

A failed full evaluation of the current head posts a comment with a clear failure message, every failed policy's name, and its actual rejection reasons. Include commit and file details already present in the results. Give applicable next steps, such as fixing the offending change, obtaining required `/approve` evidence, or using `/recheck` after a temporary issue. Guidance must not suggest that `/approve` bypasses trust restrictions or that a rerun fixes a persistent violation.

Keep the failure message, reasons, and next steps at normal size. Put supplementary metadata in a separate `<sub>...</sub>` footer with HTML anchors to the evaluated head commit and server workflow run and attempt. Include the accepted request identity and the originating command link when available so operators can correlate the evaluation. Bound the rendered reasons and details to 6,000 characters. Preserve each failed policy's name when truncating details, and include an explicit truncation notice and the run link for full details. Escape untrusted HTML, Markdown, control characters, and mentions, including filenames. Format filenames and commands as code without allowing embedded delimiters to escape their formatting.

Use the dedicated hidden marker `<!-- csm-ci:policy-failure -->`. The marker identifies policy reports only. It does not replace the approval command marker or the receipt markers. Manage a report only when it belongs to the target PR and its author has the configured Server Bot's immutable user ID and type `Bot`. User comments, forged markers, other bots' comments, and approval or merge receipts remain untouched.

| Full evaluation | Report behavior |
|---|---|
| First failure | Publish one active failure report. |
| Identical active failure on retry | Retain the existing report without duplication. Compare the evaluated head and failure content, excluding run, attempt, and request metadata. |
| Changed failure or head | Publish or retain the current report, then minimize superseded owned reports with `OUTDATED`. |
| Failure after recovery | Publish a new active report, even if an older minimized report has identical content. |
| All applicable policies pass on the current head | Minimize every owned failure report with `RESOLVED`, including reports already minimized as `OUTDATED`. Post no success comment and delete no report. |
| Repeated recovery | Retain the resolved history without duplicate comments or unnecessary mutations. |

List all pages of prior comments and inspect their minimization state and classifier. Immediately before minimizing a target, reread and verify its PR, immutable author identity, Bot type, and dedicated marker. Verify GraphQL node identity rather than trusting an ID or marker supplied by a client. Confirm that `minimizeComment` succeeded and produced the requested state and classifier. An already outdated report is not sufficient evidence of resolved recovery.

Before posting or minimizing, reread the PR state and confirm that the evaluated head is still current and eligible for the operation. A stale failure cannot post against a newer head, and a stale success cannot hide a newer failure. Keep all publishing paths within the existing normalized repository-and-PR server concurrency group. Reevaluate from current GitHub facts after acquiring that serialization. Head equality alone cannot prevent an older same-head result from undoing newer policy or approval evidence.

REST errors, GraphQL errors, unsuccessful mutation results, missing identity evidence, and reporting or cleanup failures must surface as errors. They cannot become a policy pass or a claim that publication completed. Follow [GitHub API](github-api.md) for bounded read retries and operation-specific recovery after an uncertain write response. Before retrying a lost comment creation response, reread owned reports to avoid duplicates.

The standalone policy-check token currently requests pull-requests read access. Runtime implementation must request the narrowly scoped comment and minimization access needed by the full publication path and verify it with the existing Server App installation. This specification does not authorize App permission or credential changes. If existing capabilities are insufficient, report the exact failure and require the operator to handle any App permission change.

## Verification requirements for the implementation

Table-driven tests must cover every configured policy's actual reasons, mixed passing and failing results, relevant commit and file details, applicable guidance, escaped and truncated content, and normal-size text outside the HTML footer. Verify the unchanged check summary, producer identity, and head-bound `external_id`.

Cover every lifecycle row above, multiple pages of comments, and recovery of already outdated reports. Verify `OUTDATED` for superseded failures and `RESOLVED` for recovery. Exercise standalone policy-check, automatic approval, the final `/approve` refresh, and `/recheck`. Prove that prospective preflight and merge readiness cannot resolve reports.

Test forged markers, wrong PRs, wrong author IDs or types, missing or inconsistent node identity, moved heads, changed PR state, out-of-order evaluations, and REST or GraphQL failures. Assert the rejection messages and mutation results. Mutation-check every new or changed rejection rule individually in bounded isolated copies.

Run the affected policy-check and approve suites, then smoke, at the signed pushed implementation SHA. In the testing repositories, inspect a real first failure, identical retry, changed failure, and passing recovery. Verify rendered `<sub>` metadata, escaped content, minimization classifiers, and recovery of outdated reports with the existing Server App permissions. Record exact run URLs and any skipped or unverified cases in `docs/handoff.md`. Complete CI-only identity cases after an authorized merge, using the runner checkout on `main`.
