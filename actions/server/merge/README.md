# csm-ci merge

Check merge readiness, squash-merge a ready pull request, or post a failure receipt for a previously accepted wait. The workflow uses multiple calls with different `mode` values. Keep them in the stage order and token-minting boundaries in [server.yml](../../../.github/workflows/server.yml).

See [merge behavior](../../../docs/merge.md) for the trust, policy, approval, required-check, retry, and receipt rules. This action is a low-level trusted workflow component, not a standalone event handler.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `mode` | Yes | None | `wait`, `merge`, or `failure-receipt`. |
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` for `csm-ci.yaml`. |
| `config-path` | No | `csm-ci.yaml` | Config path in the server repository. |
| `server-token` | Yes | None | Target-scoped Server App token with contents, pull requests, checks, and issues read access. |
| `notification-token` | Yes | None | Target-scoped Server App token with `issues:write` and `pull_requests:write` for reactions and receipts. |
| `write-token` | No | None | Client-scoped token with `contents:write` and `pull_requests:write`; required in `merge` mode. |
| `repository` | Yes | None | Client repository as `owner/repo`. |
| `args` | Yes | None | JSON intake request numbers, such as `{"pull_number":123,"comment_id":456}`. Both are required. |
| `head` | No | None | Head SHA returned by `wait`; required in `merge` mode. |
| `failure-message` | No | None | Required in `failure-receipt` mode. Original wait failure text from `error`. |

## Outputs

| Output | Value |
|---|---|
| `ready` | `true` when the request is ready to merge. |
| `accepted` | `true` when the Server App accepted the command and reacted with a rocket. |
| `error` | Wait failure message for use in the fresh-token failure receipt stage. |
| `head` | Pull request head SHA pinned by the readiness stage. |
| `result` | `merged` when the pull request was merged. |
| `merge-commit` | Squash merge commit SHA. |

The `wait` mode sets `accepted` when the command is accepted, then `ready` and `head` on success or `error` on failure. The `merge` mode sets `result` and `merge-commit`. The `failure-receipt` mode has no outputs. Unset flags are empty strings, not the string `false`.

## Use in the server workflow

The server calls `wait`, then conditionally calls `merge` with the pinned `head`. If an accepted wait fails after its notification token expires, it calls `failure-receipt` with the saved error and a fresh notification token. Use the matching jobs and `if` conditions in [server.yml](../../../.github/workflows/server.yml); this partial shape does not provide the required trust boundary by itself:

```yaml
- id: merge-ready
  continue-on-error: true
  uses: civitaspo/csm-ci-actions/actions/server/merge@<reviewed-commit-sha>
  with:
    mode: wait
    server-token: ${{ steps.merge-read-token.outputs.token }}
    notification-token: ${{ steps.merge-notify-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    args: ${{ needs.intake.outputs.args }}
- id: merge
  if: steps.merge-ready.outputs.ready == 'true'
  uses: civitaspo/csm-ci-actions/actions/server/merge@<reviewed-commit-sha>
  with:
    mode: merge
    server-token: ${{ steps.merge-final-read-token.outputs.token }}
    notification-token: ${{ steps.merge-final-notify-token.outputs.token }}
    write-token: ${{ steps.merge-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    args: ${{ needs.intake.outputs.args }}
    head: ${{ steps.merge-ready.outputs.head }}
```

Between these calls, the workflow mints `merge-final-read-token`, `merge-final-notify-token`, and `merge-token` only when readiness succeeds. Its failure path mints `merge-failure-notify-token` and posts the saved error:

```yaml
- if: steps.merge-ready.outcome == 'failure' && steps.merge-ready.outputs.accepted == 'true'
  continue-on-error: true
  uses: civitaspo/csm-ci-actions/actions/server/merge@<reviewed-commit-sha>
  with:
    mode: failure-receipt
    server-token: ${{ steps.merge-read-token.outputs.token }}
    notification-token: ${{ steps.merge-failure-notify-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    args: ${{ needs.intake.outputs.args }}
    failure-message: ${{ steps.merge-ready.outputs.error }}
```

Keep the workflow's explicit failure step after this receipt so a failed wait still fails the job. The examples assume intake selected the `merge` operation.

The example omits `github-token` and `config-path` because their defaults apply. The actual workflow mints target-scoped tokens only at the required stages and serializes requests per pull request.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
