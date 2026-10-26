# Setup

This guide sets up one server repository and its client repositories. The names of Apps, environments, variables and secrets are fixed. They are listed in [first-release-plan.md](first-release-plan.md) under "Naming list". For a test setup, prefix the App names with `testing-`.

## 1. Create the repositories

Create the server repository, for example `csm-ci-server`. The client repositories already exist. Give write access to the server repository only to the people who run it.

## 2. Register and install the GitHub Apps

Run the wizard. It opens each page with the permissions filled in, installs the Apps on the right repositories, and stores their credentials.

```sh
scripts/setup-wizard.sh
```

The wizard does these steps:

1. Creates the environment `csm-ci` in the server repository. Only `main` can deploy to it.
2. Registers `csm-ci-server` and installs it on the server and every client repository.
3. Registers `csm-ci-client` and installs it on the server repository only.
4. Registers `csm-ci-approver` and installs it on every client repository.
5. Stores the client IDs as variables and the private keys as secrets:
   - In the server repository, environment `csm-ci`: `CSM_CI_SERVER_APP_CLIENT_ID`, `CSM_CI_SERVER_APP_PRIVATE_KEY`, `CSM_CI_APPROVER_APP_CLIENT_ID` and `CSM_CI_APPROVER_APP_PRIVATE_KEY`.
   - In each client repository: `CSM_CI_CLIENT_APP_CLIENT_ID`, `CSM_CI_CLIENT_APP_PRIVATE_KEY` and `CSM_CI_SERVER_REPOSITORY`.
6. Prints the bot user IDs for `csm-ci.yaml`.

Delete the downloaded `.pem` files after the wizard finishes.

## 3. Write csm-ci.yaml

Put `csm-ci.yaml` at the root of the server repository. Use immutable user IDs, which `gh api users/<login> --jq .id` prints.

```yaml
owners: [your-account]
server_repository: your-account/csm-ci-server
apps:
  client_bot_id: 0 # csm-ci-client[bot]
  server_app_id: 0 # csm-ci-server
  server_bot_id: 0 # csm-ci-server[bot]
trust:
  committers:
    - { id: 0, login: your-account }
  approvers:
    - { id: 0, login: your-account }
  mergers:
    - { id: 0, login: your-account }
  bot_mergers: []
merge:
  required_checks:
    - { name: status-check, app_id: 15368 }
  deadline_minutes: 60
policies:
  - { type: signed-commits }
  - { type: trusted-committers }
  - type: sensitive-paths
    paths:
      - "**/Cargo.toml"
      - "**/Cargo.lock"
      - "**/package.json"
      - "**/package-lock.json"
      - "**/npm-shrinkwrap.json"
      - "**/bun.lock*"
      - "**/yarn.lock"
      - "**/pnpm-lock.yaml"
      - "**/go.mod"
      - "**/go.sum"
      - "**/pyproject.toml"
      - "**/requirements*.txt"
      - "**/Pipfile*"
      - "**/poetry.lock"
      - "**/uv.lock"
      - "**/Gemfile*"
      - "**/composer.*"
      - "**/Package.swift"
      - "**/Package.resolved"
      - Makefile
      - "**/Dockerfile*"
      - "**/.goreleaser.*"
      - scripts/**
      - "**/build.rs"
      - .cargo/**
      - .github/**
    exempt: []
repositories:
  - { name: your-account/*, ops: [approve, merge, policy-check] }
```

The schema rejects unknown keys and puts the server bot in no trust list.

## Explicit secret contract migration

These examples require a reviewed reusable workflow revision that implements the [explicit secret contract](first-release-plan.md#explicit-secret-contract-and-staged-migration). Upgrade each caller's pin and secret mapping together. Existing production callers on older pins still use inheritance until their staged rollout. Changing only their mapping can fail GitHub workflow validation.

| Caller | Required mapping | Feature-specific mappings |
|---|---|---|
| All five client workflows | `CSM_CI_CLIENT_APP_PRIVATE_KEY` | None |
| Server label workflow | `CSM_CI_SERVER_APP_PRIVATE_KEY` | `CSM_CI_APPROVER_APP_PRIVATE_KEY` for approval; `CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY` and `CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE` for Terraform provider publication |
| Repo-settings workflow and both nested targets | `CSM_CI_SERVER_APP_PRIVATE_KEY` | `CSM_CI_APPROVER_APP_PRIVATE_KEY` for manual activation |
| Server check workflow | None | None |

Map every name to the identical `secrets.NAME` expression. Each client repository stores only the Client App key at repository level. Strong credentials remain in the server's `csm-ci` environment with its default-branch-only deployment restriction. The calling job can evaluate an environment-only name to an empty string; the called job's environment supplies it. GitHub checks that required mappings exist before jobs start. It does not check whether their values are nonempty.

Approval and manual activation fail at the pinned App-token action if the approver key is empty. Terraform provider publication requires both signing inputs before signing. Other release types need neither signing input. Managed-files-only runs and repairs without activation need no approver capability. Repo-settings never forwards provider signing credentials, and production callers never forward `csm-ci-e2e` credentials.

Verify the named contract, both nested repo-settings edges, and bootstrap activation in testing before rolling out compatible pins and callers to production one repository at a time. No credential placement or App permission change is needed.

## 4. Add the server workflows

Pin both calls to a full commit SHA of csm-ci-actions.

`.github/workflows/csm-ci.yml` runs the server:

```yaml
name: csm-ci
# Label events must never cancel each other; the op job serializes per pull request instead.
# jactionlint ignore=concurrency-limits
on:
  label:
    types: [created]
permissions: {}
jobs:
  server:
    uses: civitaspo/csm-ci-actions/.github/workflows/server.yml@<sha>
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
      CSM_CI_APPROVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}
    permissions:
      contents: read
      issues: write
      id-token: write
      attestations: write
```

The example enables approval. If Terraform provider publication is enabled, add these same-name mappings to the server job as well:

```yaml
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
      CSM_CI_APPROVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}
      CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY: ${{ secrets.CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY }}
      CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE: ${{ secrets.CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE }}
```

Omit feature-specific names when their features are disabled. Keep the Server App key mapping in every label caller. The [isolated probe](handoff.md#explicit-secret-contract-probe) verified environment availability and required mapping validation. Full runtime verification remains a separate rollout gate.

`.github/workflows/csm-ci-check.yml` validates `csm-ci.yaml` and lints the workflows on every change:

```yaml
name: csm-ci-check
on:
  push:
    branches: [main]
  pull_request:
permissions: {}
concurrency:
  group: ${{ github.workflow }}-caller-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  check:
    uses: civitaspo/csm-ci-actions/.github/workflows/server-check.yml@<sha>
    permissions:
      contents: read
```

## 5. Add the client workflows

Each operation has a reusable client workflow. Pin it to a full commit SHA of csm-ci-actions.

securefix is the exception: the caller generates the changes itself, so it runs the `actions/client/securefix` action as one step in that job. Configure its server-side routes and add the step as described in [securefix.md](securefix.md).

`.github/workflows/csm-ci-approve.yml` asks for approvals ([approve.md](approve.md)):

```yaml
name: csm-ci-approve
# Each event is its own request, so none may cancel another.
# The pull request is never checked out; the only secret is the Client App key, which can only
# create labels in the server repository.
# jactionlint ignore=concurrency-limits,dangerous-triggers
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  approve:
    uses: civitaspo/csm-ci-actions/.github/workflows/client-approve.yml@<sha>
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

`.github/workflows/csm-ci-policy-check.yml` evaluates pull request policies:

```yaml
name: csm-ci-policy-check
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited]
permissions: {}
jobs:
  policy-check:
    uses: civitaspo/csm-ci-actions/.github/workflows/client-policy-check.yml@<sha>
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

Add the approver to `csm-ci.yaml`:

```yaml
approver: { id: 0, login: "csm-ci-approver[bot]" }
trust:
  approvers:
    - { id: 0, login: your-account }
```

`.github/workflows/csm-ci-merge.yml` lets a trusted merger request a squash merge:

```yaml
name: csm-ci-merge
on:
  issue_comment:
    types: [created]
permissions: {}
jobs:
  merge:
    uses: civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@<sha>
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

The command is exactly `/merge`. The server waits for the latest approver review, current policies, and configured checks. After readiness succeeds, the workflow mints fresh read and notification tokens plus a contents and pull-requests write token, then revalidates and merges. If an accepted wait fails, the workflow mints a fresh notification token for the failure receipt.

For releases, enable the `release` op and choose its build type in `csm-ci.yaml`. Add a caller that requests a release when a `release/next` pull request is merged:

```yaml
name: csm-ci-release
on:
  pull_request:
    types: [closed]
permissions: {}
jobs:
  release:
    # The reusable workflow needs the Client App key from the client repository.
    uses: civitaspo/csm-ci-actions/.github/workflows/client-release-publish.yml@<sha>
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

The server verifies the merged pull request before it creates a tag or release. Its build job runs without credentials, secrets or an environment. The `release-tags` ruleset must restrict `v*` tags to the Server App.

To prepare release PRs, configure the [release-pr securefix route](release-pr.md) and add `.github/workflows/csm-ci-release-pr.yml`. Replace `main` with the repository's default branch:

```yaml
name: csm-ci-release-pr
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
    uses: civitaspo/csm-ci-actions/.github/workflows/client-release-prepare.yml@<sha>
    with:
      version: ${{ inputs.version || '' }}
    secrets:
      CSM_CI_CLIENT_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
```

Pushes infer the version through git-cliff. Manual dispatches may supply an exact version. Generation packages the changelog and root version edits; the server applies them to `release/next` through securefix and maintains its PR. The generation job receives the Client App key through the release-prepare action; its token has only issues write access on the server repository.

## 6. Add repository settings reconciliation

Install the approver App on the server as well as the clients before enabling controlled merges there. Add the client approval, policy-check, and merge callers to the server too, using the same Client App variables and key as other clients. Its label caller handles incoming requests, while its client callers submit requests for its own pull requests. Add the global [`repo_settings` configuration](repo-settings.md) and ensure the server is included in `repositories`.

Use `additional_managed_files` to map literal target paths to UTF-8 files committed in this Server repository, for example `.github/PULL_REQUEST_TEMPLATE.md: managed-files/pull-request-template.md`. Sources are relative to the repository root even with a nested `config-path`, and are read at the same immutable Server commit as configuration. No templating occurs. The combined delivered set allows 512 files, 8 MiB per file and 10 MiB total. Removing an entry preserves the target file. Existing inline deployments must follow the [staged migration](repo-settings.md#migrate-deployed-inline-content) before upgrading all parser pins; `managed_files` is rejected.

Add `.github/workflows/csm-ci-repo-settings.yml` to the server's default branch:

```yaml
name: csm-ci-repo-settings
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
    uses: civitaspo/csm-ci-actions/.github/workflows/server-repo-settings.yml@<sha>
    with:
      repository: ${{ inputs.repository || '' }}
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
      CSM_CI_APPROVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}
```

Pin `<sha>` to the reviewed actions commit. The schedule repairs drift without creating or re-enabling `controlled-merges`. To activate it, first distribute the merge caller and clear the auto-merge queue, then dispatch for that repository. The server verifies these prerequisites before it changes anything, whenever a dispatch would activate the ruleset.

Review managed-file pull requests from `csm-ci/repo-settings` and request `/merge` through the normal approval process. To stop controlled merging, set the ruleset's enforcement to `disabled`; the schedule preserves that state.


## Generated caller rollout gate

The standard caller generator runtime requires the [reviewed adoption procedure](repo-settings.md#standard-client-workflows-planned). Upgrade every Server parser pin before adding `release_prepare` or `workflow_adoption`. Remove selected caller destinations from `additional_managed_files` in the same reviewed configuration change that adds their exact observed adoption digests. Keep `release_prepare.update_root_version: false` for repositories that preserve root manifest versions. After the generated PR merges, verify its original signed head and default bytes before removing adoption entries.

Discovery resolves and validates one published stable release for all targets and both managed-file stages. The current stable `v0.1.0` lacks the required interfaces, so deployment is blocked until an intended compatible release is separately authorized and published. Do not select an older release, use a mutable ref, or publish a temporary version. Full-SHA local tests do not establish this published-stable gate. Run repo-settings, release-pr, affected client suites, then smoke at the signed pushed candidate after that prerequisite. Preserve the normal protected review and merge process and the owned-branch recovery procedure for incompatible pending managed PRs.
