# csm-ci release assets

Validate files produced by the isolated release build, calculate SHA-256 digests, and create the `SHA256SUMS` file used for attestation and publication. This action does not run client code. The trusted release publishing job in [server.yml](../../../.github/workflows/server.yml) calls it after downloading build artifacts.

See [release publishing](../../../docs/release.md) for asset validation and publication rules.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `directory` | No | `assets` | Directory containing the build outputs. |
| `plan` | Yes | None | Validated release plan as JSON, including configuration and version. |
| `source-date-epoch` | For Terraform | Empty | Merge commit timestamp for deterministic RSA signatures. |
| `gpg-fingerprint` | For Terraform | Empty | Full uppercase primary RSA fingerprint. |
| `gpg-private-key` | For Terraform | Empty | Armored private key from the server environment. |
| `gpg-passphrase` | For Terraform | Empty | Passphrase from the server environment. |

## Outputs

| Output | Value |
|---|---|
| `gpg-public-key` | Exported public key for final Terraform signature revalidation; empty for other build types. |
| `subject-path` | Glob selecting validated asset files for `actions/attest`. |
| `assets` | JSON array of `{ "name": "file.tar.gz", "sha256": "<64 lowercase hex digits>" }` objects. Includes the digest of `SHA256SUMS` itself. |

## Use in the release publishing job

The directory must contain outputs from the matching release-build job. The workflow creates `release-predicate.json` from its validated repository, merge SHA, and tag before the attestation step. The publisher passes these outputs to attestation and the release-publish action:

```yaml
- id: assets
  uses: civitaspo/csm-ci-actions/actions/server/release-assets@<reviewed-commit-sha>
  with:
    directory: assets
    plan: ${{ needs.release-plan.outputs.plan }}
- uses: actions/attest@f057fd524d485ac48d9b534c235aad15b5bb303f # v3.0.0
  with:
    subject-path: ${{ steps.assets.outputs.subject-path }}
    predicate-type: https://github.com/civitaspo/csm-ci-actions/attestation/release/v1
    predicate-path: ${{ runner.temp }}/release-predicate.json
```

For Terraform providers, use the server workflow's conditional credential inputs and pass the public key, fingerprint and source timestamp to final publication. Keep the private credentials in this trusted preparation step only.

Use the full release-publish job in [server.yml](../../../.github/workflows/server.yml) for the required permissions and artifact handoff. Do not run this action against untrusted files in a general-purpose workflow.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
