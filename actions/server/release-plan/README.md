# csm-ci release plan

Validate a merged release pull request against the server's release configuration and produce a server-verified plan. The plan pins the source commit, version, tag, build type, and fixed build matrix for later trusted workflow jobs.

This action must run after intake identifies a release request and before any release build or write token is created. The coordinating workflow is [server.yml](../../../.github/workflows/server.yml). See [release publishing](../../../docs/release.md).

## Inputs

| Input | Required | Value |
|---|---:|---|
| `github-token` | Yes | Server App token with `contents:read` and `pull_requests:read` on the client repository. |
| `repository` | Yes | Client repository as `owner/repo`. |
| `pull-number` | Yes | Merged release pull request number. |
| `server-bot-id` | Yes | Server App bot user ID from validated server configuration. |
| `release-config` | Yes | Validated release build configuration emitted by intake. |

## Outputs

| Output | Value |
|---|---|
| `plan` | Server-validated release facts encoded as JSON. |
| `repository-owner` | Client repository owner. |
| `repository-name` | Client repository name. |
| `merge-sha` | Release pull request merge commit SHA. |
| `tag` | Release tag. |
| `version` | Release version without the `v` prefix. |
| `build-type` | Validated release build type. |
| `tag-exists` | Whether the expected annotated Server App tag already exists. |
| `matrix` | JSON array of `{target, runner}` rows for the isolated release build job. Non-Cargo builds use `[{"target":"","runner":"ubuntu-24.04"}]`. |

## Plan JSON

`plan` is serialized JSON with the following fields. Pass the emitted string unchanged to `release-tag` and `release-publish`; this example describes the format, not a plan to construct from user input:

```json
{
  "repository": "owner/repository",
  "pullNumber": 123,
  "mergeSha": "0123456789012345678901234567890123456789",
  "tag": "v1.2.3",
  "version": "1.2.3",
  "serverBotId": 12345,
  "serverBotLogin": "csm-ci-server[bot]",
  "tagExists": false,
  "privateRepository": false,
  "release": { "build_type": "none" },
  "prerelease": false
}
```

`release` preserves the validated build configuration. Cargo adds `targets` to `build_type`; the other build types have no additional fields. `prerelease` follows the semantic version. `tagExists` means the existing annotated tag already passed the plan's identity and commit checks.

## Use in the release workflow

The server workflow extracts the release pull number from intake and passes the validated config. It mints write access only if the expected tag is missing and must be created:

```yaml
- id: plan
  uses: civitaspo/csm-ci-actions/actions/server/release-plan@<reviewed-commit-sha>
  with:
    github-token: ${{ steps.read-token.outputs.token }}
    repository: ${{ needs.intake.outputs.owner }}/${{ needs.intake.outputs.name }}
    pull-number: ${{ fromJSON(needs.intake.outputs.args).pull_number }}
    server-bot-id: ${{ needs.intake.outputs.server-bot-id }}
    release-config: ${{ needs.intake.outputs.release }}
```

Keep this stage in the trusted release jobs in [server.yml](../../../.github/workflows/server.yml). The emitted `matrix` must be used as provided; do not accept target triples from client event data.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
