# csm-ci check-config

Validate the server repository's `csm-ci.yaml` against the schema bundled with this csm-ci-actions version. The action runs in the reusable [server-check workflow](../../../.github/workflows/server-check.yml), which also lints the server workflows.

## Input

| Input | Required | Default | Value |
|---|---:|---|---|
| `path` | No | `csm-ci.yaml` | Path of the config file in the checked-out server repository. |

## Outputs

This action defines no outputs. It fails the workflow when the file cannot be read or does not match the schema.

## Use

Call the reusable check workflow on pushes and pull requests that change server config or workflows:

```yaml
jobs:
  check:
    permissions:
      contents: read
    uses: civitaspo/csm-ci-actions/.github/workflows/server-check.yml@<reviewed-commit-sha>
    with:
      config-path: csm-ci.yaml
```

Inside a trusted workflow that has checked out the server repository, the action step is:

```yaml
- uses: civitaspo/csm-ci-actions/actions/server/check-config@<reviewed-commit-sha>
  with:
    path: csm-ci.yaml
```

The workflow checks out both the server repository and the pinned csm-ci-actions revision. To call this action directly, check out the server repository first and set `path` to the config file relative to that checkout. See [setup](../../../docs/setup.md) for the full caller configuration.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
