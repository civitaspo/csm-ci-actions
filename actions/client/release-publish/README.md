# csm-ci release-publish client request

Ask the server to publish a release after a `release/next` pull request merges into the client's default branch. This action sends a request locator. The server verifies the merged pull request and version before creating its tag. It then builds and publishes through separate jobs, checking the tag and release state again.

Use the reusable [client-release-publish workflow](../../../.github/workflows/client-release-publish.yml), which filters for merged pull requests from the same repository's `release/next` branch. See [release publishing](../../../docs/release.md) and [setup](../../../docs/setup.md).

## Inputs

| Input | Required | Value |
|---|---:|---|
| `client-id` | Yes | Client ID of the Client App. The recommended workflow reads `vars.CSM_CI_CLIENT_APP_CLIENT_ID`. |
| `private-key` | Yes | Client App private key. The recommended workflow reads `secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY`. |
| `server-repository` | Yes | Server repository as `owner/repo`. The recommended workflow reads `vars.CSM_CI_SERVER_REPOSITORY`. |

## Output

| Output | Value |
|---|---|
| `label` | Name of the request label created in the server repository. It is empty when the event does not qualify for a request. |

## Use

```yaml
on:
  pull_request:
    types: [closed]
permissions: {}
jobs:
  request:
    if: >-
      github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged &&
      github.event.pull_request.head.ref == 'release/next' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.base.repo.full_name == github.repository &&
      github.event.pull_request.base.ref == github.event.repository.default_branch
    runs-on: ubuntu-24.04
    steps:
      - uses: civitaspo/csm-ci-actions/actions/client/release-publish@<reviewed-commit-sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

The reusable workflow is the recommended caller. The Client App needs `issues: write` on the server repository. The server requires the repository's `release` operation and a valid release build configuration. Read [release configuration and build types](../../../docs/release.md) before enabling the caller.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
