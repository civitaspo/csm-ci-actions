# csm-ci intake

Validate a request label in the server repository, read the pinned server configuration, and emit normalized request data for later stages. The action also derives a concurrency key and release settings when applicable. It is the first processing stage in [server.yml](../../../.github/workflows/server.yml).

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` and `issues:read`. |
| `config-path` | No | `csm-ci.yaml` | Config path in the server repository. |

## Outputs

| Output | Value |
|---|---|
| `kind` | Normalized request operation. |
| `owner` | Lowercase client repository owner. |
| `name` | Lowercase client repository name. |
| `args` | JSON object containing validated request numbers. |
| `concurrency-key` | Key used to serialize work for the same pull request or run. |
| `release` | Serialized release build configuration when release is enabled, for example `{"build_type":"none"}`. Empty otherwise. |
| `server-bot-id` | Server App bot user ID from the validated config. |

The `args` JSON fields depend on `kind`. Every number is a positive safe integer:

| `kind` | `args` example |
| --- | --- |
| `approve` | `{"pull_number":123}` or `{"pull_number":123,"comment_id":456}` |
| `policy-check` | `{"pull_number":123}` or `{"pull_number":123,"comment_id":456}` |
| `merge` | `{"pull_number":123,"comment_id":456}` |
| `securefix` | `{"run_id":789}` |
| `release` | `{"pull_number":123}` |

The `release` JSON is `{"build_type":"none"}`, `{"build_type":"js-action"}`, `{"build_type":"goreleaser"}`, or `{"build_type":"cargo","targets":["x86_64-unknown-linux-gnu"]}`. Cargo targets must come from the supported set in [release configuration](../../../docs/release.md). `concurrency-key` is `owner/repo#<pull_number>` or `owner/repo#<run_id>`.

## Use in the server workflow

Use the stage in the trusted server workflow after a request label event. The event and concurrency policy are part of the caller contract:

```yaml
- id: intake
  uses: civitaspo/csm-ci-actions/actions/server/intake@<reviewed-commit-sha>
  with:
    github-token: ${{ github.token }}
    config-path: csm-ci.yaml
```

The caller must use the server repository's default-branch workflow with `contents: read` and `issues: read` permissions. This intake job does not use the privileged `csm-ci` environment. Pass these outputs to the selected operation stage; do not reconstruct or accept request values from an external dispatch input. See [server.yml](../../../.github/workflows/server.yml) and [setup](../../../docs/setup.md).

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
