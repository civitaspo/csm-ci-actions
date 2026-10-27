# Production recovery

Use this when csm-ci itself cannot complete a protected merge in production. The usual cause is that the csm-ci-server label workflow fails for every request, so no `/approve` or `/merge` can run. Ask the user for explicit authorization before bypassing protection; it covers one merge.

## Merge one fix with a temporary ruleset bypass

1. Confirm the fix PR's own checks pass (`validate`, `status-check`) and that it is the smallest change that restores the label workflow.
2. Snapshot every ruleset you will touch with `gh api repos/<repo>/rulesets/<id>`. Keep the full JSON (`name`, `target`, `enforcement`, `conditions`, `rules`, `bypass_actors`) for comparison.
3. Set `enforcement` to `disabled` only for the rulesets that block the merge, usually `controlled-merges` and `review-and-checks`. Leave `integrity` and `release-tags` active.
4. Squash-merge with `gh pr merge --squash --match-head-commit <reviewed head>`. Then restore `enforcement: active` in the same command sequence, even if the merge fails.
5. Compare each restored ruleset with its snapshot field by field. Confirm the merge commit is signed and its tree equals the reviewed head.
6. Prove recovery with a real request, such as `/approve` on an open PR, and record the run.

## Incidents that shaped the rules

Each row links the incident to the rule in [AGENTS.md](../../AGENTS.md) that prevents it.

| Incident | Cause | Rule |
|---|---|---|
| Every label request failed at startup for about 45 minutes (csm-ci-server#24, recovered by #25) | The pin bump brought required named secrets while the server callers still used `secrets: inherit` | Diff `on.workflow_call` before moving pins |
| `/merge` and `/approve` deadlocked until the merge deadline (csm-ci-actions#157) | One per-PR concurrency group was shared by every operation kind | Concurrency is per kind, except that `approve` and `policy-check` share one per-PR group to serialize policy publication; new waiting operations must not block others |
| Release and managed-file PRs closed or were marked merged with no content (csm-ci-actions#163) | The branch was reset to its base before the new commit | Rebuild through `src/lib/branch-rebuild.ts` |
| Generated callers became "customized" or failed lint (csm-ci-actions#142, #144) | Client autofix added pin comments; self-linting repositories rejected the triggers | Generate files that client tooling leaves unchanged |
| Ten repo-settings dispatches failed with a rate limit | Parallel per-repository dispatches exhausted the Server App's hourly API quota | Reconcile many repositories in one serial run |
| A duplicate v0.3.0 release PR (csm-ci-actions#154) | The release merge push triggered a hand-written prepare caller that lacked the generated skip | Close it; generated callers skip release commits |
