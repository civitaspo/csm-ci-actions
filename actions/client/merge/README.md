# csm-ci merge client request

Ask the server to squash-merge a pull request after it passes current trust, approval, policy, and required-check rules. The action filters for an exact `/merge` comment from a repository collaborator and creates a request label in the server repository.

Use the reusable [client-merge workflow](../../../.github/workflows/client-merge.yml), which listens to newly created issue comments. The server checks the comment again and accepts only users in `trust.mergers`, or configured bot mergers under the rules in [merge behavior](../../../docs/merge.md). See also [setup](../../../docs/setup.md).

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
  issue_comment:
    types: [created]
permissions: {}
jobs:
  request:
    if: >-
      github.event_name == 'issue_comment' && github.event.action == 'created' && github.event.issue.pull_request &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
      github.event.comment.body == '/merge'
    runs-on: ubuntu-24.04
    steps:
      - uses: civitaspo/csm-ci-actions/actions/client/merge@<reviewed-commit-sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

The reusable workflow already applies these event filters. Prefer calling it from the [client-merge workflow](../../../.github/workflows/client-merge.yml). The Client App needs `issues: write` on the server repository. It does not need write permission in the client repository. Add the intended human IDs to `trust.mergers` in `csm-ci.yaml`.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
