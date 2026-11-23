# Policy check

Reusable client callers declare and map only `CSM_CI_CLIENT_APP_PRIVATE_KEY`. See the [secret contract and staged migration](setup.md#explicit-secret-contract-migration) for server feature credentials and compatible caller pins.

The `policy-check` operation evaluates the effective repository policies in `csm-ci.yaml` against the pull request's current head. It creates or updates the `csm-ci/policy` check run with the Server App and pins `external_id` to that head. The check summary contains one row per policy.

Closed pull requests skip evaluation and publication. Immediately before creating or updating a check, the server rereads the pull request and skips publication if it closed or its head changed. This also protects policy refreshes after approval. Skips leave existing checks untouched and the standalone action reports `result=skipped` with a reason in its log. An open pull request with no commits still fails both trust policies.

The `signed-commits` and `trusted-committers` policies and the built-in `approval` row always run, even when omitted from configuration. The opt-in [`pull-request-title`](#pull-request-title-policy) checks the title against the Conventional Commit header form. `sensitive-paths` checks changed and renamed paths against the configured patterns. Include these default paths when you want the standard dependency, build, and workflow coverage:

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

Sensitive changes require a current approval by the configured approver App, pinned to the head, with an `approve:command` marker. The marker points to the source `/approve` comment, which must still exist, remain unedited, and have been written by a configured trusted approver. Ordinary GitHub UI approvals do not authorize sensitive paths. Protection of the server and actions repositories comes from explicit [repository policy overrides](#effective-repository-policy-resolution); the runtime has no fixed repository rule.

The planned [managed-file automatic completion](repo-settings.md#automatic-completion-planned) adds a separate, narrowly scoped sensitive-path authorization. The server must independently verify the complete managed-file pull request against current trusted inputs for each evaluation. A branch name, Bot identity, marker, reservation, or previously published check does not establish this authorization. The built-in approval row and every other policy still apply. Until that feature is deployed, managed-file pull requests follow the command approval path above.

The built-in `approval` row always runs. It passes only when the latest review by the configured approver is an approval for the current head. GitHub UI approvals by other accounts do not satisfy it, so a csm-ci automerge reservation needs the configured approver. A missing approval alone fails the check, but it neither creates a policy failure report nor prevents resolving an existing one.

The `/approve` command first validates all trust and configured policies other than `sensitive-paths`, `pull-request-title` and `approval`, then writes its marked approval, and finally refreshes `csm-ci/policy`. This provides the approval evidence required by `sensitive-paths` and `approval` without creating an approval cycle. The title is excluded for a different reason: it is not evidence about the code; see [where it runs](#where-it-runs). Automatic approval and `/recheck` refresh the same check after their evaluation.

The client workflow runs on pull request open, synchronize, reopen, ready-for-review and edited events. It never checks out pull request code. `/recheck` also causes a fresh evaluation through the approve request path.

## Pull request title policy

csm-ci squash-merges with the pull request title as the commit subject, and releases build `CHANGELOG.md` from those subjects with git-cliff's Conventional Commit parser. The `pull-request-title` policy fails `csm-ci/policy` when the title is not a Conventional Commit header, so client repositories need no title workflow or third-party title action.

```yaml
policies:
  - type: pull-request-title
    types: [feat, fix, docs, refactor, test, ci, build, chore, perf, revert]
```

`types` is required. It is a non-empty list of unique types, each matching `^[a-z]+$`, and it must include `chore`, because csm-ci's own pull requests use it. The strict parser rejects any other key and a second `pull-request-title` entry.

The title passes when it matches `^(<types>)(\([a-z0-9-]+\))?!?: \S`, where `<types>` is the configured list. The title is matched as GitHub returns it; nothing is trimmed or rewritten.

| Title | Result |
| --- | --- |
| `refactor: name the registration check after skipped files` | pass |
| `chore(release): v0.1.0` | pass |
| `feat!: drop the old option` | pass |
| `chore(deps): update dependency bun to v1.4.5` | pass |
| `Name test directories by scope` | fail: no type |
| `feat:missing space` | fail: no space after the colon |
| `fix(ci) : extra space` | fail: space before the colon |
| `feature: unknown type` | fail: type not configured |
| `feat(Policy): uppercase scope` | fail: scope outside `[a-z0-9-]` |
| `Revert "feat: x"` | fail: GitHub's revert title; rename it to `revert: ...` |
| `Bump x from 1.0.0 to 1.1.0` | fail: Dependabot's default title |

A failing row names the policy, quotes the title, and states the expected form with the configured types. When this policy fails, the failure report adds: "Edit the pull request title. With the `policy-check` operation enabled, the edit re-runs the check; otherwise use `/recheck`." The existing closing guidance stays. Approval cannot change this result.

### Enablement and scope

The policy is opt-in. A server configuration without a `pull-request-title` entry produces no title row and keeps its current behavior. When the entry is present, it applies to every repository in that server's `repositories[]`, like a global `sensitive-paths` policy. There is no repository override: a `repositories[].pull_request_title` key is rejected as unknown.

### Where it runs

`effectivePolicies` returns the configured policy for every caller of the shared resolver. The title is a field of the pull request facts that the caller passes to the evaluation; the evaluator reads nothing itself. The caller takes it from its own `GET /repos/{owner}/{repo}/pulls/{number}` with the Server App token. For check publication, that is the read that confirms the pinned head just before policies are evaluated, not the read made when the request started. For merge readiness, it is the pull request read inside that readiness evaluation. The client event, label description and comment never supply it.

| Path | Title evaluated | Effect of a failing title |
| --- | --- | --- |
| Standalone policy-check (`edited` included) | yes | `csm-ci/policy` fails and the failure report lists it |
| Full refresh after automatic approval, `/recheck`, or `/approve` | yes | same as standalone policy-check |
| Automatic approval and `/recheck` decision | no | does not decline the approval |
| `/approve` preflight | no | does not reject the command |
| Managed-file approval preflight | no | does not reject the approval |
| Managed-file acceptance (`acceptManagedPull`) | no | does not reject the reservation; merge readiness then waits |
| Merge readiness, including the final evaluation before the write | yes | the reservation waits with `policies failed: pull-request-title: ...` |

The title is metadata of the squash commit, not evidence about the code, so approval and reservation decisions ignore it, as `/approve` already ignores `sensitive-paths` and `approval` in its preflight. Approval never makes the row pass. Every full refresh publishes the title result in `csm-ci/policy`, and merge readiness requires it to pass, so a pull request with a failing title cannot merge through csm-ci.

Ignoring the title in approval decisions keeps recovery to one step. The approve caller does not run on `edited`, so if a failing title declined automatic approval, editing the title would leave the approval missing until `/recheck`. Instead the head is approved on its merits, the author edits the title, and the `edited` event's standalone policy-check publishes a passing result for the same head without `/recheck`. Merge evaluation follows that policy-check, as described in [merge](merge.md). Policy-check shares the repository-and-PR concurrency group with approve. A newer pending run replaces an older pending one, so the run that executes after an earlier evaluation finishes reads the latest title.

Only the generated policy-check caller runs on `edited`, and it exists only when the repository enables the `policy-check` operation. Without that operation, a fixed title takes effect at the next approve request, such as `/recheck`, or at the next merge evaluation, which reads the title itself.

### The validated title is the commit subject

GitHub's merge API takes `sha` to bind the head, but nothing binds the title, and the title can change at any time. csm-ci passes the commit title explicitly. The squash commit title is the pull request title that the final readiness evaluation read and validated, plus ` (#<number>)`. That evaluation is the one that runs after GitHub auto-merge is disabled and immediately before the merge write. It returns the validated title with its merge decision, and the merge write uses that value. Each revalidation before a retry of HTTP 405, 422, or 503 returns the title for that retry in the same way. A title read at any other point, including one read before the final evaluation, is never used for the commit.

A title edited after the final evaluation does not reach the commit. The merged commit carries the validated title, and the pull request may then show a different title. A title edited before the final evaluation is validated by it: a failing title stops the merge and the reservation waits; a passing title becomes the subject.

The ` (#<number>)` suffix keeps a passing title passing, because the pattern constrains only the header prefix.

### csm-ci's own pull requests

csm-ci creates and titles these pull requests. Each title passes whenever `types` includes `chore`, which the parser requires.

| Pull request | Title | Source |
| --- | --- | --- |
| Release PR (`release/next`) | `chore(release): v<version>` | `actions/client/release-prepare/action.yml` sets the commit message; the `release-pr` securefix route uses its subject without a route prefix (`src/lib/securefix-operation.ts`, [release-pr](release-pr.md)) |
| Managed-file PR (`csm-ci/repo-settings`) | `chore(repo-settings): sync managed files` | `MANAGED_FILES_TITLE` in `src/lib/managed-files.ts`, restored on every run ([repo-settings](repo-settings.md)) |

Other securefix routes are titled `<route name>: <subject>`. Such a pull request passes only when the route name is one of `types` and the subject starts with a non-space character. Route names allow digits and hyphens, but only a name matching `^[a-z]+$` can be a type. Name a route after a type, such as `chore`, when its pull requests must merge with the policy enabled. securefix PR mode does not create or retitle pull requests.

### Verification requirements for the implementation

Add the variant to `PolicySchema` and an evaluator registered in `EVALUATORS`. Cover every title in the table above and every parser rule, including a duplicate entry, in table-driven tests that assert the rejection message. Prove that automatic approval, `/recheck`, `/approve` preflight, managed approval preflight, and managed acceptance ignore a failing title, and that the full refresh and merge readiness fail on it. Prove that the merge write uses the title from the final evaluation: a title changed after the first readiness evaluation and before the final one must be validated before it is used, a title read before the final evaluation must never reach `commit_title`, and a title changed after the final evaluation must not reach it either. Mutation-check each new rule individually.

Enable the policy in the e2e server fixture together with a harness PR title format that passes, `test(e2e): <scenario title> [<feature>][<classification>] — <fixture>`, and update every exact-title match in the harness in the same change. Without it, scenarios that expect a passing `csm-ci/policy` or a merge fail; approval scenarios still approve. The `e2e-route` securefix route PR never merges, so its title may fail; its scenarios must not assert a passing `csm-ci/policy`.

Add live scenarios for a failing title that `/approve` does not clear, an `edited` fix that passes without `/recheck`, and a title edited to a failing value after approval with an active reservation: the reservation waits with the title reason, and after a passing edit the merged commit subject equals that title plus ` (#<number>)`. Leave the edit after the final evaluation to unit tests, because a live run cannot hit that window reliably.

## Repository policy configuration

The approved repository policy contract adds optional `repositories[].sensitive_paths.paths` and `repositories[].sensitive_paths.exempt`. Each omitted list inherits its global value. Each explicit list replaces its global value, including `[]`. Empty paths match no files. Empty exemptions disable inherited exemptions. The existing first matching repository entry supplies the overrides.

Without a global sensitive-path policy or a repository override, that policy remains disabled. A repository override enables it and uses empty lists for components with no configured value. Preserve the file-count limit, renamed-path checks, signature and trust checks, and the condition that the PR author and every commit have the same effective identity for an exemption.

Automatic approval, command approval, `/recheck`, standalone policy-check, and merge reevaluation share these effective settings. A sensitive-path exemption does not grant permission to request a Bot merge. The independent `repositories[].merge.allow_bot_requests` setting controls that permission under the existing global Bot trust list.

## Failure reports and recovery

The runtime implements the lifecycle from [issue #71](https://github.com/civitaspo/csm-ci-actions/issues/71). Live verification of comment rendering, minimization, and installed Server App capabilities remains required before deployment. The existing check name, head-bound `external_id`, summary, policy decisions, and approval requirements stay unchanged.

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

The standalone policy-check token requests pull-requests write access for comments and minimization through the full publication path. Verify those capabilities with the existing Server App installation. This specification does not authorize App permission or credential changes. If existing capabilities are insufficient, report the exact failure and require the operator to handle any App permission change.

## Verification requirements for the implementation

Table-driven tests must cover every configured policy's actual reasons, mixed passing and failing results, relevant commit and file details, applicable guidance, escaped and truncated content, and normal-size text outside the HTML footer. Verify the unchanged check summary, producer identity, and head-bound `external_id`.

Cover every lifecycle row above, multiple pages of comments, and recovery of already outdated reports. Verify `OUTDATED` for superseded failures and `RESOLVED` for recovery. Exercise standalone policy-check, automatic approval, the final `/approve` refresh, and `/recheck`. Prove that prospective preflight and merge readiness cannot resolve reports.

Test forged markers, wrong PRs, wrong author IDs or types, missing or inconsistent node identity, moved heads, changed PR state, out-of-order evaluations, and REST or GraphQL failures. Assert the rejection messages and mutation results. Mutation-check every new or changed rejection rule individually in bounded isolated copies.

Run the affected policy-check and approve suites, then smoke, at the signed pushed implementation SHA. In the testing repositories, inspect a real first failure, identical retry, changed failure, and passing recovery. Verify rendered `<sub>` metadata, escaped content, minimization classifiers, and recovery of outdated reports with the existing Server App permissions. Record exact run URLs and any skipped or unverified cases in the PR. Complete CI-only identity cases after an authorized merge, using the runner checkout on `main`.

## Effective repository policy resolution

The first matching `repositories[]` entry supplies the complete override; later entries contribute nothing. Optional `sensitive_paths.paths` and `sensitive_paths.exempt` inherit their corresponding global values independently. Explicit lists replace global lists, including `[]`. The parser preserves omission rather than inserting defaults into these fields.

Every global sensitive-path policy receives those component replacements. Without a global sensitive-path policy, an absent override leaves it disabled; a supplied `sensitive_paths` object enables one with empty lists for missing components. Signature and trusted-committer checks always run. Exemptions still require the PR author and every effective commit identity to match, and sensitivity still checks renamed paths and rejects the 3,000-file listing limit.

Automatic approval, `/approve`, `/recheck`, standalone policy-check, and merge readiness call this same resolver. No repository is treated specially by name. The server and actions repositories are protected by explicit `sensitive_paths: { paths: ["**"], exempt: [] }` entries in the Server configuration.
