# Repository CI

Repository CI has one entry workflow per event. `pull_request.yml` handles pull requests, and `push.yml` handles pushes to `main`. Both call `workflow_call_ci.yml` at the same revision. The aggregator calls the reusable checks below.

| Workflow | Checks |
|---|---|
| `wc-english.yml` | Reject CJK characters in every tracked file. |
| `wc-runtime.yml` | Frozen dependency installation, typecheck, tests, build, and clean committed `dist/`. |
| `wc-workflows.yml` | Online jactionlint and shared-client action-lock verification. |

The entry workflows always run. The aggregator compares the event's base commit with the checkout and skips only the workflow checks when every changed path is documentation or `LICENSE`. English and runtime checks still run for those changes. An absent or unavailable base runs every check. The path comparison uses Git rather than the pull request files API, so it has no API file-count limit. Renames are compared as deletion and addition so a non-documentation source path still requires workflow checks.

Each entry owns the exact outer job name `status-check`. This job depends only on `checks`, the reusable aggregator call. It runs with `always()` and requires `needs.checks.result` to equal `success`. GitHub computes the reusable workflow's overall result from its jobs, including nested check calls. A failed or cancelled required check therefore cannot produce a passing outer check. An intentional workflow-check skip does not fail the aggregator. A cancellation can cancel the outer job itself, which also prevents a passing result.

Keep the outer dependency on the aggregator when adding checks. Listing individual checks on the outer job can lose an unrelated failure when a contributor retries selected jobs. Retain the required check's existing GitHub Actions producer binding, App ID `15368`, in repository protection.

The workflows default to no token permissions. Checkout and check jobs receive only `contents: read`, checkouts disable credential persistence, and external actions retain immutable pins. No reusable CI call passes secrets. The generated shared-client action lock keeps its existing scope.

Managed `csm-ci-*` callers remain independent. Public client and server reusable workflows retain their own contracts. `e2e.yml` remains an explicit manual workflow with its existing environment, credentials, and concurrency boundaries.

## Verify aggregate behavior on GitHub

Local lint cannot prove GitHub's reusable-workflow result or retry behavior. Use a temporary branch and pull request in `testing-csm-ci-client` while holding the shared testing lease. Preserve the fixture configuration and restore only resources owned by the experiment. Do not change rulesets or required-check bindings.

Copy the candidate entry, aggregator, and check workflows at the signed full head SHA. For a bounded experiment, replace the individual check bodies with deterministic jobs while retaining the call graph, path condition, and outer `status-check`. Record the source SHA, test commit, pull request, run ID, attempt, and every job's result for each case below.

1. Run all nested checks successfully. Confirm that the outer `status-check` succeeds.
2. Fail two independent nested checks. Confirm that the outer check fails. Retry only one failed job after making that job succeed through an owned test control. Confirm that the unrelated failure remains and the outer check cannot pass. Then retry the remaining failed job and confirm success only after every applicable check succeeds.
3. Keep one nested job running with a bounded timeout. Cancel that job or the run and confirm that the aggregate and outer check cannot pass.
4. Make a documentation-only change. Confirm that workflow checks skip intentionally, runtime and English checks execute, and the outer check succeeds.
5. Repeat the successful case through the push entry on an isolated branch in the testing copy. Do not broaden the candidate's production `main` trigger.

Also verify the actual candidate's normal checks in its own pull request. Synthetic check bodies prove the orchestration contract, not the typecheck, test, lint, or build results. Keep run URLs and any skipped or unverified cases in the review evidence.
