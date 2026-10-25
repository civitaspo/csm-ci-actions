# csm-ci release tag

Create the annotated release tag from a server-validated release plan when the tag is missing. If the tag already exists, the action validates it against the planned commit. It runs in the trusted release workflow before the isolated build and publish jobs.

See [release publishing](../../../docs/release.md) for tag identity rules and the required `release-tags` ruleset. The coordinating stages are in [server.yml](../../../.github/workflows/server.yml).

## Inputs

| Input | Required | Value |
|---|---:|---|
| `github-token` | Yes | Server App token with `contents:write` on the client repository. |
| `plan` | Yes | JSON [plan emitted by release-plan](../release-plan/README.md#plan-json). |

## Outputs

This action defines no outputs. It fails if the tag does not match the planned commit or cannot be created and verified.

## Use in the release workflow

The caller uses the plan output and a client-scoped token. Mint that token only when `tag-exists` is not `true`:

```yaml
- uses: civitaspo/csm-ci-actions/actions/server/release-tag@<reviewed-commit-sha>
  if: steps.plan.outputs.tag-exists != 'true'
  with:
    github-token: ${{ steps.tag-token.outputs.token }}
    plan: ${{ steps.plan.outputs.plan }}
```

Keep the tag stage and its conditional token creation from [server.yml](../../../.github/workflows/server.yml). The Server App must be the permitted bypass actor for protected `v*` tags.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
