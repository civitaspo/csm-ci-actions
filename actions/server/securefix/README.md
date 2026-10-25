# Securefix server

Validate a securefix workflow run and apply its bounded artifact. Use [server.yml](../../../.github/workflows/server.yml) to preserve the artifact extraction limits, delayed write-token issuance, and expected-head checks. The action is called once per stage, with different credentials.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | Yes | None | `locate`, `prepare`, or `apply`. |
| `github-token` | No | `${{ github.token }}` | Contents read access to the server repository's pinned configuration. |
| `config-path` | No | `csm-ci.yaml` | Configuration path in the server repository at `github.sha`. |
| `repository` | Yes | None | Client `owner/repo` from intake. |
| `run-id` | Yes | None | Positive safe integer workflow run ID from intake's `args.run_id`. |
| `server-token` | For `locate` and `prepare` | None | Target-scoped token with actions read, contents read, and pull requests read. |
| `write-token` | For `apply` | None | Target-scoped token with actions read, contents write, and pull requests write. Add workflows write only when preparation requires it. |
| `artifact-path` | For `prepare` and `apply` | None | Directory containing the downloaded artifact. |

## Outputs by mode

All outputs are strings. Outputs from other modes are unset.

| Output | Mode | Meaning |
| --- | --- | --- |
| `artifact-name` | `locate` | Verified artifact name, `securefix`. |
| `artifact-id` | `locate` | Verified GitHub artifact ID. |
| `route-mode` | `locate`, `prepare` | `true` for a configured route, otherwise `false`. |
| `result` | `prepare`, `apply` | Preparation returns `ready` or `already-applied`. Apply returns `applied` or `already-applied`. |
| `requires-workflows-write` | `prepare` | `true` when the verified operation needs workflow write permission, otherwise `false`. |
| `commit` | `apply` | Created or already-applied commit SHA. |
| `pull-request` | `apply` | Route PR number when applicable. Unset in PR mode. |

## Example: locate and prepare

This excerpt runs in the trusted `op` job after intake. `needs.intake.outputs` contains the validated target and run. `steps.securefix-read-token.outputs.token` comes from the repository-scoped token step in [server.yml](../../../.github/workflows/server.yml).

The workflow mounts `${{ runner.temp }}/csm-ci-securefix` as a 12 MiB temporary filesystem with a 1,024-inode limit before downloading, and unmounts it in cleanup. Keep that preparation and cleanup around these stages:

```yaml
- id: securefix-locate
  uses: civitaspo/csm-ci-actions/actions/server/securefix@<reviewed-commit-sha>
  with:
    mode: locate
    server-token: ${{ steps.securefix-read-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    run-id: ${{ fromJSON(needs.intake.outputs.args).run_id }}
- uses: actions/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3 # v8.0.0
  timeout-minutes: 2
  with:
    artifact-ids: ${{ steps.securefix-locate.outputs.artifact-id }}
    github-token: ${{ steps.securefix-read-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    run-id: ${{ fromJSON(needs.intake.outputs.args).run_id }}
    path: ${{ runner.temp }}/csm-ci-securefix
    digest-mismatch: error
- id: securefix-prepare
  uses: civitaspo/csm-ci-actions/actions/server/securefix@<reviewed-commit-sha>
  with:
    mode: prepare
    server-token: ${{ steps.securefix-read-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    run-id: ${{ fromJSON(needs.intake.outputs.args).run_id }}
    artifact-path: ${{ runner.temp }}/csm-ci-securefix
```

## Example: apply with the selected token

After preparation, the workflow creates either `securefix-write-token` or `securefix-workflow-token` according to `requires-workflows-write`. Route mode can still need a call to repair PR metadata when the content is already applied:

```yaml
- if: >-
    steps.securefix-prepare.outputs.result == 'ready' ||
    steps.securefix-prepare.outputs.route-mode == 'true'
  uses: civitaspo/csm-ci-actions/actions/server/securefix@<reviewed-commit-sha>
  with:
    mode: apply
    write-token: ${{ steps.securefix-workflow-token.outputs.token || steps.securefix-write-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    run-id: ${{ fromJSON(needs.intake.outputs.args).run_id }}
    artifact-path: ${{ runner.temp }}/csm-ci-securefix
```

These excerpts assume the job has selected a securefix request. The full workflow also gates every stage on intake's request kind. Replace `<reviewed-commit-sha>` with a reviewed full SHA, and pass `config-path` to every stage if it differs from the default. See [securefix behavior](../../../docs/securefix.md) for the validation and retry rules.
