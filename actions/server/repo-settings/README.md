# csm-ci repository settings

Validate configuration and reconcile settings, rulesets, and managed files in configured repositories. The action has several modes because the trusted server workflows separate discovery, validation, inspection, preflight, and writes. Use it through [server-repo-settings.yml](../../../.github/workflows/server-repo-settings.yml) and [server-repo-settings-target.yml](../../../.github/workflows/server-repo-settings-target.yml).

See [repository settings](../../../docs/repo-settings.md) for targets, activation checks, managed files, and repository permissions. Do not expose write modes through an untrusted workflow or call `apply` without the preceding inspect and, when required, preflight stages.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `mode` | Yes | None | `validate-targets`, `validate-target`, `discover`, `preflight`, `inspect`, `apply`, `managed-inspect`, or `managed-apply`. |
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` for the pinned config. |
| `discovery-token` | No | None | Required for `discover`. Server App token used to list repositories in its installation. |
| `read-token` | No | None | Required for `preflight`, `apply`, `managed-inspect`, and `managed-apply`. Target-scoped contents and pull requests read token. |
| `admin-token` | No | None | Required for `inspect` and `apply`. Target-scoped administration write token; reading ruleset bypass actors also needs this permission. |
| `contents-token` | No | None | Required for `managed-apply`. Target-scoped contents and pull requests write token; add workflows write when inspection requires it. |
| `config-path` | No | `csm-ci.yaml` | Config path in the server repository. |
| `repository` | No | None | Required except for `validate-targets` and `discover`. Target as `owner/repo`. |
| `requested-repository` | No | None | Optional repository selector for discovery. |
| `event-mode` | No | None | `schedule` or `dispatch`, derived by the trusted caller. Required for `inspect` and `apply`. |
| `targets` | No | `all` | Comma-separated `settings`, `rulesets`, `releases`, `managed-files`, or `all`. Empty, empty-entry, and unknown values fail. |
| `actions-repository` | Yes | None | Repository distributing the reusable caller workflows, as `owner/repo`. |
| `approver-app-slug` | No | None | Required when `apply` would activate controlled merges. Approver App slug returned by its capability-token step. |

`actions-repository` is declared required by the action metadata. `validate-targets` returns before reading configuration or credentials. Every other stage reads the pinned configuration, verifies the server default ref, and validates the selected target when present.

| Stage (`mode`) | Additional requirements | Outputs set |
| --- | --- | --- |
| `validate-targets` | Valid targets and allowed event. | `targets`, `selects-administration`, `selects-rulesets`, `selects-managed-files` |
| `discover` | `discovery-token`; optional `requested-repository`. | `clients`, `client-count`, `has-clients`, `server`, `has-server` |
| `validate-target` | `repository`. | `target-owner`, `target-name`, `is-server` |
| `inspect` | `repository`, `admin-token`, `event-mode`. | `changes`, `activation-required`, `has-changes` |
| `preflight` | `repository`, `read-token`; a distributed caller and empty auto-merge queue. | `caller-distributed`, `auto-merge-queue-count` |
| `apply` | `repository`, `read-token`, `admin-token`, `event-mode`; Approver App capability when activation is required. | `result` |
| `managed-inspect` | `repository`, `read-token`. | `result`, `has-changes`, `changed-paths`, `requires-workflows-write` |
| `managed-apply` | `repository`, `read-token`, `contents-token`. | `result` |

Every successful stage sets `targets`, `selects-administration`, `selects-rulesets`, and `selects-managed-files`. `inspect` and `apply` require `settings`, `rulesets`, or `releases`; `preflight` requires `rulesets`; `managed-inspect` and `managed-apply` require `managed-files`. Outputs from stages that did not run are unset.

## Outputs

| Output | Value |
|---|---|
| `targets` | Validated targets as a canonical comma-separated list in processing order. |
| `selects-administration` | `true` when `settings`, `rulesets`, or `releases` is selected. |
| `selects-rulesets` | `true` when `rulesets` is selected. |
| `selects-managed-files` | `true` when `managed-files` is selected. |
| `clients` | JSON array of `{name: "owner/repo", isServer: false}` targets. |
| `client-count` | Number of selected client targets. |
| `has-clients` | `true` when at least one client target was selected. |
| `has-server` | `true` when the selected target set includes the server repository. |
| `server` | JSON `{name: "owner/repo", isServer: true}`, or `null` when not selected. The workflow processes it after clients. |
| `caller-distributed` | Whether a valid reusable caller is on the default branch. |
| `auto-merge-queue-count` | Number of open pull requests with auto-merge enabled. |
| `changes` | JSON `{settings: string[], immutableReleases: boolean, rulesets: string[]}` naming drift found by `inspect`. |
| `activation-required` | `true` when a dispatch would create or activate `controlled-merges`, requiring preflight. |
| `has-changes` | Whether a target needs settings or managed-file changes. |
| `requires-workflows-write` | `true` when managed paths include workflow files or the managed branch reset requires `workflows:write`. |
| `changed-paths` | JSON list of managed file paths that differ. |
| `target-owner` | Validated target owner. |
| `target-name` | Validated target repository name. |
| `is-server` | `true` when the target is the server repository. |
| `result` | For `managed-inspect`, plain `ready` or `already-applied`. For `apply` and `managed-apply`, serialized JSON as described below. |

The `apply` result is a JSON object with numeric counts: `settingsUpdated`, `immutableReleasesEnabled`, `rulesetsUpdated`, and `rulesetsCreated`. The `managed-apply` result is `{status, commit, pullRequest?}`, where `status` is `applied` or `already-applied`, `commit` is a SHA, and `pullRequest` is a number when a PR exists. Boolean outputs are strings `true` or `false`; numeric outputs are decimal strings. Parse JSON outputs with `fromJSON` in workflow expressions.

## Use through the reusable workflow

Add a scheduled reconciliation and a manual dispatch to the server repository. The reusable workflow controls event mode, concurrency, token scope, preflight, and the order in which it processes clients and the server:

```yaml
on:
  schedule:
    - cron: '23 3 * * *'
  workflow_dispatch:
    inputs:
      repository:
        description: Optional configured owner/repo target.
        type: string
        required: false
permissions: {}
jobs:
  settings:
    permissions:
      contents: read
    uses: civitaspo/csm-ci-actions/.github/workflows/server-repo-settings.yml@<reviewed-commit-sha>
    with:
      repository: ${{ inputs.repository || '' }}
    secrets: inherit
```

The server environment must hold the Server and Approver App credentials. Follow [setup](../../../docs/setup.md) and review the activation constraints in [repository settings](../../../docs/repo-settings.md) before dispatching a change that enables controlled merges.

Inside the trusted target workflow, `validate-target` checks that the selected repository and event mode are allowed before token creation:

```yaml
- id: target
  uses: civitaspo/csm-ci-actions/actions/server/repo-settings@<reviewed-commit-sha>
  with:
    mode: validate-target
    targets: all
    event-mode: ${{ github.event_name == 'schedule' && 'schedule' || 'dispatch' }}
    github-token: ${{ github.token }}
    config-path: csm-ci.yaml
    repository: ${{ inputs.repository }}
    actions-repository: ${{ job.workflow_repository }}
```

This excerpt depends on the trusted target workflow's `inputs.repository`, server config read at `github.sha`, App credentials, and permission gates. Do not add the action to an arbitrary dispatch workflow.

Replace `<reviewed-commit-sha>` with the full SHA of the csm-ci-actions revision you reviewed.
