# csm-ci policy check

Evaluate the configured policies against a client pull request and create or update the `csm-ci/policy` check run. The action is called by the policy-check operation stage in [server.yml](../../../.github/workflows/server.yml).

Read [policy-check behavior](../../../docs/policy-check.md) for default trust rules, sensitive-path handling, and the check result.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` to read `csm-ci.yaml`. |
| `config-path` | No | `csm-ci.yaml` | Config path in the server repository. |
| `server-token` | Yes | None | Target-scoped Server App token with `contents:read`, `pull_requests:read`, and `checks:write`. |
| `repository` | Yes | None | Client repository as `owner/repo`. |
| `pull-number` | Yes | None | Pull request number to evaluate. |

## Output

| Output | Value |
|---|---|
| `result` | `success`, `failure`, or `skipped` when the pull request closed or its head changed. |

## Use in the server workflow

The pull request number comes from the validated `args` output from intake. Keep the operation behind the trusted server label workflow and mint a target-scoped Server App token with `checks:write`:

```yaml
- id: policy-check
  uses: civitaspo/csm-ci-actions/actions/server/policy-check@<reviewed-commit-sha>
  with:
    github-token: ${{ github.token }}
    config-path: csm-ci.yaml
    server-token: ${{ steps.server-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    pull-number: ${{ fromJSON(needs.intake.outputs.args).pull_number }}
```

Use the actual policy-check job from [server.yml](../../../.github/workflows/server.yml) to preserve request validation and permissions.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
