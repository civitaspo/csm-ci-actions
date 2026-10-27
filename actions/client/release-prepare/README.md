# csm-ci release PR preparation

Generate release changes for a client repository, package them as a securefix request, and ask the server to update the `release/next` branch and pull request. The action generates `.release-version` and `CHANGELOG.md`, then updates the root versions of the selected version files.

Supported files are `package.json`, `Cargo.toml`, its root `Cargo.lock` entry, `pyproject.toml`, the root version in `dbt_project.yml`, and the root version in `herdr-plugin.toml`. Files are validated before writes; their unrelated content is preserved. Include every generated file in the server's version-only release route.

Call it through the reusable [client-release-prepare workflow](../../../.github/workflows/client-release-prepare.yml), which runs on pushes and manual dispatches from the default branch. Its `version` workflow input is optional. See [release PR behavior](../../../docs/release-pr.md), [securefix behavior](../../../docs/securefix.md), and [setup](../../../docs/setup.md).

## Inputs

| Input | Required | Value |
|---|---:|---|
| `client-id` | Yes | Client ID of the Client App, normally `vars.CSM_CI_CLIENT_APP_CLIENT_ID`. |
| `private-key` | Yes | Client App private key, normally `secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY`. |
| `server-repository` | Yes | Server repository as `owner/repo`, normally `vars.CSM_CI_SERVER_REPOSITORY`. |
| `workspace` | Yes | Path to the checked-out client repository root. |
| `version` | No | Explicit semantic version without `v`. If empty, git-cliff selects the next version from Git history. |
| `version-files` | No | JSON array of root version files, such as `["Cargo.toml","Cargo.lock","herdr-plugin.toml"]`. Empty updates every existing supported file except `herdr-plugin.toml`. `[]` updates only `.release-version` and `CHANGELOG.md`. See [generated files](../../../docs/release-pr.md#generated-files). |

## Outputs

| Output | Value |
|---|---|
| `label` | Securefix request label created in the server repository. Empty when the generation has no changes. |
| `version` | Prepared semantic version without a `v` prefix. |

## Use

The reusable workflow supplies the workspace and App credentials. Its caller can pass a version on manual dispatch:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: Optional semantic version without a v prefix.
        type: string
        required: false
permissions: {}
jobs:
  release-pr:
    permissions:
      contents: read
    uses: civitaspo/csm-ci-actions/.github/workflows/client-release-prepare.yml@<reviewed-commit-sha>
    with:
      version: ${{ inputs.version || '' }}
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

To use the action directly, first check out the client at `github.sha` into `client`, with `fetch-depth: 0` and `persist-credentials: false`. Run it only on a default-branch push or manual dispatch, as the reusable workflow does. The action step takes that workspace and the same three App settings:

```yaml
- id: release
  uses: civitaspo/csm-ci-actions/actions/client/release-prepare@<reviewed-commit-sha>
  with:
    workspace: ${{ github.workspace }}/client
    version: ${{ inputs.version || '' }}
    client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
    private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
    server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

The action installs a pinned git-cliff release asset and verifies its SHA-256 before extracting or running it. It supports Linux and macOS runners on X64 or ARM64; Windows is unsupported. See [git-cliff installation](../../../docs/release-pr.md#git-cliff-installation) for the trust anchor and the update procedure.

The server must enable securefix and configure a matching `release-pr` route for `.github/workflows/csm-ci-release-pr.yml`. The Client App needs issues write access on the server repository. Generation does not run package-manager lifecycle scripts or client build scripts. No request is sent when generated files match the checkout.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
