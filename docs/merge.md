# Merge

Reusable client callers declare and map only `CSM_CI_CLIENT_APP_PRIVATE_KEY`. See the [secret contract and staged migration](setup.md#explicit-secret-contract-migration) for server feature credentials and compatible caller pins.

`/merge` reserves an open pull request for a csm-ci squash merge. The reservation applies to the pull request, not one head SHA. csm-ci merges when the current head has the required approval, policy result, and checks. The reservation expires seven days after acceptance. A trusted merger can cancel it with `/merge cancel`.

The client forwards a newly created pull request comment whose body is exactly `/merge` or `/merge cancel`. The commenter must have OWNER, MEMBER, or COLLABORATOR association, or be a Bot whose immutable ID matches the pull request author. The Bot exception only forwards the request. The server still requires the Bot's immutable ID in `trust.bot_mergers`, `repositories[].merge.allow_bot_requests` to permit Bot requests, and ownership of the pull request and every effective commit. Human requests require an ID in `trust.mergers`. The Server App performs every accepted merge.

The server accepts `/merge` only from an account in `trust.mergers`, or from a Bot in `trust.bot_mergers` when that Bot owns the pull request and every effective commit. Acceptance also requires an enabled merge operation, an unedited command comment no more than 60 minutes old, a head that predates the comment, and no receipt or active reservation for the pull request. The server loads configuration from its default branch and reads the command and pull request from GitHub. A Server Bot receipt prevents replay. If the receipt marker is deleted, repeating the same command can create at most one reservation because the server also searches for the command comment ID.

## Reservation state

The server repository's `csm-ci-automerge` environment holds one deployment for each accepted command. Its `csm-ci:automerge` task identifies the deployment. The deployment payload stores the client repository ID, pull request number and node ID, base branch, merger identity and mode, command comment ID, accepted head, and acceptance and expiry times. The payload does not store approval, policy, check, trust, or pull request state. The server reads those facts again for every evaluation.

Only deployments created by the configured Server Bot and carrying a valid version 1 payload are reservations. Only statuses created by that Bot affect reservation state. `queued` and `error` statuses leave a reservation active. The earliest `success`, `failure`, or `inactive` status ends it; ties use the smaller status ID. Terminal status descriptions use `csm-ci:automerge:reason=<code>| <text>` to distinguish the reason from display text. A queued status is added only when its reason differs from the latest queued reason.

Every deployment status write sets `auto_inactive: false`.

The `csm-ci/automerge` pull request label is for display. csm-ci restores it while a reservation is active, leaves it after success, and removes it after cancellation, expiry, invalidation, or rejection. A label does not create or prove a reservation.

## Evaluation

The server evaluates reservations after `/merge`, `/approve`, and policy-check operations, even when the operation job fails. It also evaluates active reservations on a schedule or through `workflow_dispatch` by calling the `server-automerge.yml` reusable workflow. The server repository's caller sets the schedule interval. Evaluation does not hold the approve or policy-check concurrency group while waiting; it does not wait for readiness.

For each reservation selected for evaluation, csm-ci applies these rules in order:

1. Complete any missing result comment for a terminal reservation. A closed pull request and a pull request merged outside csm-ci do not receive a result comment.
2. Mark an expired reservation `inactive` before reading the client repository. When the client repository cannot be reached, the server cannot post a comment or update its label.
3. Mark an already merged pull request `success`, or a closed pull request `inactive`. Mark a reservation `inactive` if the repository or pull request identity no longer matches. If the target identity cannot be verified, do not write a client comment or label.
4. Mark the reservation `inactive` if its merger is no longer trusted, merge is disabled, Bot requests are no longer allowed for a Bot reservation, or the base branch changed.
5. Reject a Bot reservation with `failure` if a commit is not authored by that Bot.
6. Keep a draft pull request queued.
7. Keep a pull request queued until the latest review from the configured Approver App approves its current head, every effective commit satisfies current policy, and each configured required check has a `success` or `skipped` conclusion from the configured GitHub App. The server checks each required check by name and App ID. It does not use GitHub's `reviewDecision` or the `csm-ci/policy` check result as a substitute for current configuration evaluation.
8. Merge the current head when all conditions pass.

A head change does not cancel the reservation. The stale approval no longer satisfies readiness, so an approval and current checks for the new head are required. Editing or deleting the original `/merge` comment does not cancel a reservation. Use `/merge cancel`.

Before merging, csm-ci reloads the reservation, configuration, pull request, approval, policy, and required checks. It then disables any existing GitHub auto-merge request, regardless of who enabled it. If disabling reports an error, csm-ci reads the request again and continues only if the request is gone. If it remains, csm-ci writes an `error` status so a later evaluation can retry. csm-ci then squash-merges with the current head SHA. It revalidates before retrying HTTP 405, 422, or 503 responses. On HTTP 409, the server re-reads the pull request. If its head changed, the reservation stays active and waits for a later evaluation of the new head. Otherwise, the reservation ends with `failure`. A successful merge records the merge SHA in a `success` status and a result comment. csm-ci uses the pull request title plus ` (#<number>)` as the squash commit title and the pull request body as the commit message. It removes duplicate `Co-authored-by` lines from the body. If writing that status fails after the merge, the next evaluation records success from GitHub's merged state.

`/merge cancel` requires a fresh, unedited command comment on the same pull request. The commenter must be a trusted merger or the User who created the reservation; Bots cannot cancel reservations. An unauthorized cancellation receives no receipt. If no active reservation exists, csm-ci writes a receipt that says so, or reports that the pull request has already merged. Otherwise it marks the reservation `inactive`, removes the label, and posts a cancellation result. A repeated cancellation command does not create a contradictory receipt.

Acceptance and cancellation share a per-pull-request concurrency group. Evaluation uses a separate per-pull-request group so a scheduled evaluation cannot replace a pending command. The evaluator observes a cancellation recorded before it reloads the reservation for final validation. A cancellation can race with a merge after that reload because GitHub does not provide an atomic cancel-and-merge operation. If the merge completes first, the cancellation handler reports that the pull request has already merged. GitHub keeps only one pending job per group, so a newer pending command can replace an older pending command.

Disabling GitHub auto-merge immediately before the csm-ci merge does not guarantee that an earlier auto-merge request cannot merge first. The server checks the pull request state again during final validation and handles an already merged pull request as complete.

## Results and retries

Each reservation result has a marker of the form `<!-- csm-ci:automerge:<deployment_id>:<event> -->`. Events are `accepted`, `merged`, `expired`, `cancelled`, `invalidated`, and `rejected`. Command receipts also use the command comment ID. Before posting a result, the server checks for an existing Server Bot comment with the same marker. A later event-triggered evaluation fills in a missing terminal result comment; scheduled sweeps select active reservations only and cannot repair a missing terminal comment. Acceptance, merge, expiry, cancellation, trust or configuration invalidation, and readiness rejection are reported when the client repository is accessible. Pull request closure and external merges are not commented on.

Deployment creation is recovered by looking for a reservation with the same command comment ID if the response is lost. Status creation is recovered by reading existing statuses. These operations can be retried safely. GitHub API calls use the shared bounded retry rules in [GitHub API](github-api.md).

The scheduled workflow lists reservations from the previous 14 days and caps one sweep at 256 active reservations. This cap can starve later reservations if more than 256 remain active, because each sweep selects the oldest deployments. Deployment listing volume and pagination remain a capacity limit to resolve before production use above that bound.

## Required permissions and caller

The Server App needs Deployments read and write access on the server repository to list and create reservations and statuses. The scheduled listing token uses Deployments write to expire reservations whose repositories are unavailable to its discovery token. Scheduled evaluations resolve the repository's immutable ID with an owner-scoped metadata token before issuing client tokens. If a repository moves to another owner and cannot be found in the original owner's installation, scheduled evaluation waits until expiry. When event evaluation can reach the repository lookup but receives HTTP 404 for the repository or pull request, it ends the reservation as `inactive` without writing to the client. The Server App needs its existing client-repository permissions to read pull requests, reviews, checks, and policies, post comments and labels, and merge. Read, notification, and final write tokens remain separate. The final token receives `contents`, `pull-requests`, and `workflows` write access only after readiness succeeds.

The server repository calls `server-automerge.yml` from a scheduled caller. Map `CSM_CI_SERVER_APP_PRIVATE_KEY` by name because that secret is stored in the `csm-ci` environment. The reusable workflow declares that environment. `secrets: inherit` does not pass an environment-only secret.

```yaml
name: csm-ci automerge
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:
permissions: {}
jobs:
  sweep:
    uses: civitaspo/csm-ci-actions/.github/workflows/server-automerge.yml@<sha> # <version>
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
```

GitHub schedule events have a five-minute minimum interval and can start later during periods of high load. The caller's cron controls the requested interval.
