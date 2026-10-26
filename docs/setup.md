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

The [approved explicit secret contract](first-release-plan.md#explicit-secret-contract-and-staged-migration) replaces inherited secrets after its runtime implementation and deployment. The examples below describe the current runtime. Keep inheritance until the selected reusable pin and repo-settings activation preflight support named mappings.

The target contract requires only `CSM_CI_CLIENT_APP_PRIVATE_KEY` in each client caller. Server callers name the Server App key and enabled feature credentials. Repo-settings forwards only the server and approver names at both nested target calls. Strong credentials remain in the server's `csm-ci` environment with the same deployment restriction. Follow the plan's table for required and feature-specific names. Upgrade callers, fixtures, templates, and action locks together, and verify bootstrap activation before production rollout. No new credential placement or App permission is needed.

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
    # This caller uses inherit under the current runtime contract.
    # jactionlint ignore=secrets-inherit
    uses: civitaspo/csm-ci-actions/.github/workflows/server.yml@<sha>
    secrets: inherit
    permissions:
      contents: read
      issues: write
      id-token: write
      attestations: write
```

`secrets: inherit` is required by the current runtime contract. Named mappings with environment secrets passed the [isolated probe](handoff.md#explicit-secret-contract-probe), but require the implementation described above.

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
    # This caller uses inherit under the current runtime contract.
    # jactionlint ignore=secrets-inherit
    uses: civitaspo/csm-ci-actions/.github/workflows/client-approve.yml@<sha>
    secrets: inherit
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
    secrets: inherit
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
    # This caller uses inherit under the current runtime contract.
    # jactionlint ignore=secrets-inherit
    uses: civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@<sha>
    secrets: inherit
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
    # jactionlint ignore=secrets-inherit
    uses: civitaspo/csm-ci-actions/.github/workflows/client-release-publish.yml@<sha>
    secrets: inherit
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
    # This caller uses inherit under the current runtime contract.
    # jactionlint ignore=secrets-inherit
    secrets: inherit
```

Pin `<sha>` to the reviewed actions commit. The schedule repairs drift without creating or re-enabling `controlled-merges`. To activate it, first distribute the merge caller and clear the auto-merge queue, then dispatch for that repository. The server verifies these prerequisites before it changes anything, whenever a dispatch would activate the ruleset.

Review managed-file pull requests from `csm-ci/repo-settings` and request `/merge` through the normal approval process. To stop controlled merging, set the ruleset's enforcement to `disabled`; the schedule preserves that state.
