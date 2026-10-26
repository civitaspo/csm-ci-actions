# approve

approve gives a pull request the approval that the repository's ruleset requires. The approval comes from the approver App, never from a person's token. The server decides from facts it reads itself, so the client only says which pull request or comment to look at.

## Triggers

| Event in the client repository | Request | Server path |
|---|---|---|
| `pull_request_target` opened, synchronize, reopened or ready_for_review | `csm-ci-approve-*`, `owner/repo/<pr>` | automatic |
| A comment `/approve` | `csm-ci-approve-*`, `owner/repo/<pr>/<comment id>` | approver command |
| A comment `/recheck` | `csm-ci-approve-*`, `owner/repo/<pr>/<comment id>` | automatic again |

The client workflow sends a comment request only when the commenter's association is OWNER, MEMBER or COLLABORATOR and the body is exactly a command. The server reads the comment body again and decides the command from it. The client filter is not a security check. The event payload can already carry an edited body, so a comment posted as plain text and edited into `/approve` within a second can still start a request. The server checks both REST timestamps and GraphQL `IssueComment.lastEditedAt`. REST timestamps have one-second precision, so equal timestamps alone cannot prove that a comment was never edited.

## Automatic path

1. The pull request is open, not a draft, from the same repository, and based on the default branch.
2. The server pins the head. It evaluates `signed-commits` and `trusted-committers`, which always apply, and every other policy in `csm-ci.yaml`.
3. If any policy fails, the result is `declined` and nothing is approved.
4. Otherwise the approver App approves with `commit_id` set to the pinned head. If it already approved that head, nothing changes.
5. The server reads the head again. If it moved, the approval is dismissed.

## /approve

`/approve` takes no argument. An approver uses it to approve a pull request whose commits all pass the trust rules, for example when a policy needs an approver's decision. It never approves untrusted commits. A person approves a contributor's pull request in the GitHub UI instead. The server:

1. Checks the comment. It must belong to the pull request, the body must be exactly `/approve`, and it must be unedited and at most 60 minutes old.
2. Rejects a comment it already answered (one with a receipt by the server bot), and a commenter whose user id is not in `trust.approvers`. Neither gets a rocket or a receipt, so a label cannot make the server post again and again.
3. Reacts with a rocket.
4. Runs the same policies as the automatic path. They must all pass.
5. Rejects a head that may have been pushed after the comment: a force-push after the comment, or a head commit dated after it. Only a trusted committer could fake the date, and their commits pass the trust rules anyway.
6. Reads the comment again, so editing or deleting it stops the request.
7. Approves with the marker `<!-- csm-ci:approve:command:<comment id> -->` in the review body, then checks the head again as in the automatic path.
8. Posts a receipt `<!-- csm-ci:approve:<comment id> -->` with the result, whether it succeeded or failed.

`/recheck` takes the automatic path. It skips the edited and 60-minute checks, because it only re-evaluates the current state.

## Rejections

| Rule | Where | Rocket and receipt |
|---|---|---|
| Comment not on this pull request | `validateComment` | no |
| Body is not exactly `/approve` or `/recheck` | `validateComment` | no |
| `/approve` edited, older than 60 minutes, or dated in the future | `validateComment` | no |
| Comment already answered by the server bot | `runApprove` | no |
| Commenter is not an approver (by id, type User) | `runApprove` | no |
| Pull request closed, draft, from a fork, or not based on the default branch | `checkPullState` | yes for `/approve` |
| A commit that is unsigned or not by a trusted committer, or another failing policy | `commandApprove` | yes |
| A force-push or a head commit after the comment | `checkHeadPredatesComment` | yes |
| Comment edited or deleted before approving | `commandApprove` | yes |
| The approver authored the pull request | `approveHead` | yes for `/approve` |
| The approver token belongs to another account; the review is dismissed | `approveHead` | yes for `/approve` |

The approver's identity is checked after the review exists. An installation token cannot call `GET /user`, so the review's author is the first place the identity shows.

## Policy refresh

Automatic approval, `/recheck`, and the final `/approve` refresh update `csm-ci/policy` through the shared full evaluation path. The [policy failure report lifecycle](policy-check.md#failure-reports-and-recovery) applies to those full refreshes when implemented. Prospective `/approve` preflight cannot resolve policy failure reports. Automatic approval and `/recheck` still produce no command receipt.

## Not done here

- `/merge` (Phase 2).
- Forcing an approval of untrusted commits. See the approve section of docs/first-release-plan.md for why.

## Permissions

The op job mints two tokens for the one client repository. The Server App token has `contents: read` and `pull_requests: write` to read the pull request, react and post receipts. The approver App token has `pull_requests: write` only. The approver App itself needs `contents: write`, because GitHub counts an App's approval toward required approvals only when the App has it.

## e2e

`bun e2e/run.ts --ref <sha> --feature approve` covers these cases:

- automatic approval and decline
- `/approve` with its marker, rocket and receipt
- a replayed label
- an unsigned commit
- an edited comment
- `/recheck`

The scenarios below need a second identity, so they run only in the `e2e` workflow, which has the untrusted committer App token:

- An App commit through the REST API that names the owner as author.
- A signed commit by an untrusted App, which `/approve` does not approve.
- A label for an `/approve` by a non-approver.
- Commands from a commenter who is not an owner, member or collaborator.

The 60-minute limit and a push that lands while approving are covered by unit tests, because e2e cannot produce them on demand.
