# csm-ci approve

Evaluate a client pull request and, when it passes, approve the pinned head with the Approver App. The action handles one normalized `approve` request from `intake`. It is a low-level stage in the trusted server workflow; do not call it directly from an untrusted event workflow.

The coordinating workflow is [server.yml](../../../.github/workflows/server.yml). The request and approval rules are in [approve.md](../../../docs/approve.md).

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` to read `csm-ci.yaml`. |
| `config-path` | No | `csm-ci.yaml` | Config file path in the server repository. |
| `server-token` | Yes | None | Target-scoped Server App token to read and comment on the PR. The coordinating workflow grants `contents:read`, `pull_requests:write`, and `checks:write`. |
| `approver-token` | Yes | None | Target-scoped Approver App token with `pull_requests:write`. The App installation also needs contents write for its approval to count toward required reviews. |
| `repository` | Yes | None | Client repository as `owner/repo`, from intake outputs. |
| `args` | Yes | None | JSON request data from intake, including `pull_number` and optional `comment_id`. |

## Output

| Output | Value |
|---|---|
| `result` | `approved`, `already-approved`, `declined`, or `dismissed`. |

## Use in the server workflow

The following stage shape is illustrative. `intake`, token-minting conditions, per-pull-request concurrency, and cleanup must come from the trusted [server workflow](../../../.github/workflows/server.yml):

```yaml
- id: approve
  uses: civitaspo/csm-ci-actions/actions/server/approve@<reviewed-commit-sha>
  with:
    github-token: ${{ github.token }}
    config-path: csm-ci.yaml
    server-token: ${{ steps.server-token.outputs.token }}
    approver-token: ${{ steps.approver-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    args: ${{ needs.intake.outputs.args }}
```

`server-token` must be scoped to the target client repository. Mint `approver-token` only after intake validates a request. Never pass private keys to this action. The server environment and caller permissions are described in [setup](../../../docs/setup.md).

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
