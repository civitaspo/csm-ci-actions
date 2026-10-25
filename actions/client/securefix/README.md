# Securefix client

Package file changes made earlier in the same job and ask the server to apply them. For a same-repository pull request, the server writes to the PR branch. For a default-branch push or manual run, a configured route selects the destination branch and PR.

The server checks the run, artifact, allowed paths, and current head before writing. See [securefix behavior](../../../docs/securefix.md) for route configuration, size limits, and retries.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `client-id` | Yes | None | Client ID of the Client App, normally `vars.CSM_CI_CLIENT_APP_CLIENT_ID`. |
| `private-key` | Yes | None | Client App private key, normally `secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY`. |
| `server-repository` | Yes | None | Server `owner/repo`, normally `vars.CSM_CI_SERVER_REPOSITORY`. |
| `workspace` | No | `github.workspace` | Directory containing the checked-out client repository and generated changes. |
| `message` | No | `Apply securefix changes from workflow run <run-id>` | Commit message. It cannot contain `csm-ci-`. |

## Outputs

| Output | Meaning |
| --- | --- |
| `has-changes` | String `true` when changes were packaged; `false` for no changes or a skipped fork PR. A successful action with `true` has also uploaded the artifact and submitted its request. |
| `label` | Created request label. Empty when no request was sent. |

## Events and prerequisites

| Event | Checkout and server behavior |
| --- | --- |
| Same-repository `pull_request` | Check out `github.event.pull_request.head.sha`. The server requires one open, ready PR to default and an unchanged head. No route is required for PR mode. |
| Fork `pull_request` | Skipped with a notice. No artifact or request is created. |
| `push` or `workflow_dispatch` | Check out `github.sha`. Configure a route for the exact workflow path, default source branch, destination branch, and allowed files. |
| Other events, including `pull_request_target` | Rejected. |

Enable `securefix` for the repository in the server configuration. The Client App needs issues write access on the server repository. The job needs contents read access to check out the client. Your tools run in a job that receives the Client App key, so that key remains exposed to those tools.

## Example: apply formatting to a pull request

This example assumes the repository defines `npm run format`. Pin the csm-ci action to a reviewed full commit SHA:

```yaml
name: Format pull request
on:
  pull_request:
permissions: {}
jobs:
  format:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - run: npm ci --ignore-scripts
      - run: npm run format
      - id: fix
        uses: civitaspo/csm-ci-actions/actions/client/securefix@<reviewed-commit-sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
          workspace: ${{ github.workspace }}
          message: 'style: format files'
```

Keep tool output inside `workspace`. Do not check out unrelated repositories inside that directory because their files may become part of the change set. For a checkout at `client/`, set `workspace: ${{ github.workspace }}/client` and run your tools in that directory.
