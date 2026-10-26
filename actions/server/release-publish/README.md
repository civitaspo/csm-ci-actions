# csm-ci release publish

Create or resume the draft release for a validated plan, verify the asset set and tag, then publish the release. This action writes to the client repository with the Server App token. It belongs in the final trusted publish job in [server.yml](../../../.github/workflows/server.yml).

See [release publishing](../../../docs/release.md) for required attestations, immutable asset checks, retry behavior, and token permissions.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `github-token` | Yes | None | Server App token with `contents:write` on the client repository. |
| `plan` | Yes | None | JSON [plan emitted by release-plan](../release-plan/README.md#plan-json). |
| `assets` | Yes | None | JSON array of `{name, sha256}` objects emitted by [release-assets](../release-assets/README.md), including `SHA256SUMS`. |
| `directory` | No | `assets` | Directory containing attested build outputs and `SHA256SUMS`. |
| `gpg-public-key` | For Terraform | Empty | Public key emitted by trusted asset preparation. |
| `gpg-fingerprint` | For Terraform | Empty | Full uppercase primary RSA fingerprint. |
| `source-date-epoch` | For Terraform | Empty | Merge commit timestamp used in the detached signature. |

## Outputs

This action defines no outputs. It fails unless the remote release, tag, and assets match the validated plan and supplied digests.

## Use in the publish job

Call this only after the release plan, isolated build, asset validation, and attestation steps succeed:

```yaml
- uses: civitaspo/csm-ci-actions/actions/server/release-publish@<reviewed-commit-sha>
  with:
    github-token: ${{ steps.server-token.outputs.token }}
    plan: ${{ needs.release-plan.outputs.plan }}
    assets: ${{ steps.assets.outputs.assets }}
    directory: assets
    gpg-public-key: ${{ steps.assets.outputs.gpg-public-key }}
    gpg-fingerprint: ${{ vars.CSM_CI_TERRAFORM_PROVIDER_GPG_FINGERPRINT }}
    source-date-epoch: ${{ needs.release-plan.outputs.source-date-epoch }}
```

Use the final publish job from [server.yml](../../../.github/workflows/server.yml), which grants OIDC and attestation permissions and creates the target-scoped Server App token only for publication. Do not pass unvalidated event fields as `plan` or `assets`.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
