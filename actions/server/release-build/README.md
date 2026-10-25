# csm-ci release build

Build release assets from an isolated source snapshot. This composite action supports `none`, `js-action`, `goreleaser`, `cargo`, and `cargo-raw`. It does not publish a release or create attestations. The trusted release build job in [server.yml](../../../.github/workflows/server.yml) runs it with no token permissions, secrets, environment, or cache.

See [release publishing](../../../docs/release.md) for build behavior, Cargo target restrictions, and the build isolation boundary.

## Inputs

| Input | Required | Value |
|---|---:|---|
| `build-type` | Yes | `none`, `js-action`, `goreleaser`, `cargo`, or `cargo-raw`. |
| `client-path` | Yes | Path to the isolated source snapshot. |
| `repository` | No | Client `owner/repo`; required for `cargo` asset naming. |
| `version` | No | Planned semantic version; required for `cargo` and `cargo-raw`. |
| `target` | No | Allowed Cargo target triple; required for `cargo` and `cargo-raw`. |
| `binary` | No | Safe Cargo binary name; required for `cargo-raw`. |

## Outputs

This action defines no outputs. It writes assets under `assets/` in the current working directory. The caller uploads the directory as a workflow artifact.

## Use in the release build job

This is the action step from the build job, after source preparation. Before it runs, the trusted workflow downloads `release-source`, extracts `release-source.tar`, initializes a local Git repository from that snapshot, commits with the validated source timestamp, and creates the validated release tag. `client-path` points to that prepared directory. Use the source-preparation steps in [server.yml](../../../.github/workflows/server.yml) with this excerpt. Cargo inputs come from the validated release plan and a fixed target matrix:

```yaml
- uses: civitaspo/csm-ci-actions/actions/server/release-build@<reviewed-commit-sha>
  with:
    build-type: ${{ needs.release-plan.outputs.build-type }}
    client-path: client
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    version: ${{ needs.release-plan.outputs.version }}
    target: ${{ matrix.target }}
    binary: ${{ fromJSON(needs.release-plan.outputs.plan).release.binary || '' }}
```

The example belongs inside the isolated job from [server.yml](../../../.github/workflows/server.yml). Do not grant that job repository permissions or secrets. The action rejects unsupported build types and only packages outputs according to the selected build type.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
