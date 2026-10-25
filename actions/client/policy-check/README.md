# csm-ci policy-check client request

Ask the server to evaluate the current pull request against `csm-ci.yaml` policies and publish the `csm-ci/policy` check. The client action filters the event and creates a request label. The server fetches the pull request and policy configuration itself.

Use the reusable [client-policy-check workflow](../../../.github/workflows/client-policy-check.yml). It handles pull request open, synchronize, reopen, ready-for-review, and edited events. See [policy-check behavior](../../../docs/policy-check.md) and [setup](../../../docs/setup.md).

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
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited]
permissions: {}
jobs:
  request:
    if: github.event_name == 'pull_request_target' && contains(fromJSON('["opened", "synchronize", "reopened", "ready_for_review", "edited"]'), github.event.action)
    runs-on: ubuntu-24.04
    steps:
      - uses: civitaspo/csm-ci-actions/actions/client/policy-check@<reviewed-commit-sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

The reusable workflow is the recommended caller. The Client App needs `issues: write` on the server repository. It does not check out pull request code. The Server App needs `checks:write` on client repositories to publish the check.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
