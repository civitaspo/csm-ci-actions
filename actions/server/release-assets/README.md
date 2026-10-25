# csm-ci release assets

Validate files produced by the isolated release build, calculate SHA-256 digests, and create the `SHA256SUMS` file used for attestation and publication. This action does not run client code. The trusted release publishing job in [server.yml](../../../.github/workflows/server.yml) calls it after downloading build artifacts.

See [release publishing](../../../docs/release.md) for asset validation and publication rules.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `directory` | No | `assets` | Directory containing the build outputs. |
| `release-config` | No | Empty | Release configuration as JSON. Pass the validated plan's configuration to enforce `cargo-raw` filenames and generate individual checksum sidecars. |

## Outputs

| Output | Value |
|---|---|
| `subject-path` | Glob selecting validated asset files for `actions/attest`. |
| `assets` | JSON array of `{ "name": "file.tar.gz", "sha256": "<64 lowercase hex digits>" }` objects. Includes the digest of `SHA256SUMS` itself. |

## Use in the release publishing job

The directory must contain outputs from the matching release-build job. The workflow creates `release-predicate.json` from its validated repository, merge SHA, and tag before the attestation step. The publisher passes these outputs to attestation and the release-publish action:

```yaml
- id: assets
  uses: civitaspo/csm-ci-actions/actions/server/release-assets@<reviewed-commit-sha>
  with:
    directory: assets
    release-config: ${{ toJSON(fromJSON(needs.release-plan.outputs.plan).release) }}
- uses: actions/attest@f057fd524d485ac48d9b534c235aad15b5bb303f # v3.0.0
  with:
    subject-path: ${{ steps.assets.outputs.subject-path }}
    predicate-type: https://github.com/civitaspo/csm-ci-actions/attestation/release/v1
    predicate-path: ${{ runner.temp }}/release-predicate.json
```

Use the full release-publish job in [server.yml](../../../.github/workflows/server.yml) for the required permissions and artifact handoff. Do not run this action against untrusted files in a general-purpose workflow.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
