# csm-ci approve client request

Ask the server to evaluate a pull request for approval. The client action filters the GitHub event and creates a short-lived request label in the configured server repository. The server re-reads the pull request and applies the configured trust and policy rules before the Approver App approves it.

For the complete operation, trigger the reusable [client-approve workflow](../../../.github/workflows/client-approve.yml). It accepts `pull_request_target` events for opened, synchronized, reopened, and ready-for-review pull requests. It also accepts newly created `/approve` and `/recheck` comments from repository collaborators. See [approval behavior](../../../docs/approve.md) and [setup](../../../docs/setup.md).

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

Prefer the reusable workflow. If you need to call the action directly, run it from a trusted workflow using the same event filters and keep the pull request code unchecked out:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  request:
    if: >-
      (github.event_name == 'pull_request_target' &&
       contains(fromJSON('["opened", "synchronize", "reopened", "ready_for_review"]'), github.event.action)) ||
      (github.event_name == 'issue_comment' && github.event.action == 'created' && github.event.issue.pull_request &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
       (github.event.comment.body == '/approve' || github.event.comment.body == '/recheck'))
    runs-on: ubuntu-24.04
    steps:
      - uses: civitaspo/csm-ci-actions/actions/client/approve@<reviewed-commit-sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

The Client App needs `issues: write` on the server repository. The composite passes its private key to the official `actions/create-github-app-token` step; csm-ci JavaScript receives the resulting token. Configure the server's `trust` and `policies` before enabling this caller.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
