# Policy check

The `policy-check` operation evaluates the global policies in `csm-ci.yaml` against the pull request's current head. It creates or updates the `csm-ci/policy` check run with the Server App and pins `external_id` to that head. The check summary contains one row per policy.

The `signed-commits` and `trusted-committers` policies always run, even when omitted from configuration. `sensitive-paths` checks changed and renamed paths against the configured patterns. Include the default dependency, build, and workflow paths in the policy configuration when you want that coverage. It fails closed at 3,000 changed files. Exemptions apply only when the pull request author and every commit have the same user identity.

Sensitive changes require a current approval by the configured approver App, pinned to the head, with an `approve:command` marker. The marker points to the source `/approve` comment, which must still exist, remain unedited, and have been written by a configured trusted approver. Ordinary GitHub UI approvals do not authorize sensitive paths. The server repository and `civitaspo/csm-ci-actions` treat every path as sensitive and ignore exemptions.

The `/approve` command first validates all trust and configured policies other than `sensitive-paths`, then writes its marked approval, and finally refreshes `csm-ci/policy`. This provides the approval evidence required by `sensitive-paths` without creating an approval cycle. Automatic approval and `/recheck` refresh the same check after their evaluation.

The client workflow runs on pull request open, synchronize, reopen, ready-for-review and edited events. It never checks out pull request code. `/recheck` also causes a fresh evaluation through the approve request path.
