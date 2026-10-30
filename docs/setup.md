# Setup

This guide sets up one server repository and its client repositories. The names of Apps, environments, variables and secrets are fixed. They are listed in the [Naming list](design.md#naming-list). For a test setup, prefix the App names with `testing-`.

## 1. Create the repositories

Create the server repository, for example `csm-ci-server`. The client repositories already exist. Give write access to the server repository only to the people who run it.

## 2. Register and install the GitHub Apps

Follow the [`csm-ci-setup` skill](../.agents/skills/csm-ci-setup/SKILL.md). It lists the Apps, their permissions and installation targets, and the credentials to store. These steps happen:

1. Create the environment `csm-ci` in the server repository. Only `main` can deploy to it.
2. Register `csm-ci-server` and install it on the server and every client repository. Grant Contents write and Deployments read/write on the server repository for automerge display commits and reservations. Grant Deployments write on each client repository only if enabling the optional display projection. The projection's scoped token must not be available to client code. Verify installed permission metadata before rollout; only the operator changes App permissions.
3. Register `csm-ci-client` and install it on the server repository only.
4. Register `csm-ci-approver` and install it on every client repository.
5. Store the client IDs as variables and the private keys as secrets:
   - In the server repository, environment `csm-ci`: `CSM_CI_SERVER_APP_CLIENT_ID`, `CSM_CI_SERVER_APP_PRIVATE_KEY`, `CSM_CI_APPROVER_APP_CLIENT_ID` and `CSM_CI_APPROVER_APP_PRIVATE_KEY`.
   - In each client repository: `CSM_CI_CLIENT_APP_CLIENT_ID`, `CSM_CI_CLIENT_APP_PRIVATE_KEY` and `CSM_CI_SERVER_REPOSITORY`.
6. Look up the bot user IDs for `csm-ci.yaml`.

Create the `csm-ci-automerge` environment in the server repository without secrets or protection rules. Create `csm-ci-automerge-display` in each client repository where the optional projection is enabled, also without secrets or protection rules. The repo-settings operation manages the `automerge-display` ruleset for the exact server ref `refs/heads/csm-ci/automerge`; verify the branch does not already belong to an unrelated workflow before enabling it. The Server App is its sole bypass actor because it writes directly. Do not reset an existing branch. If the display commit cannot be created, automerge reservation acceptance falls back to the server default branch.

Delete the downloaded `.pem` files afterwards.

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

Prefer an explicit list of repositories in production. A wildcard enrolls every repository the Server App is later installed on, and the next reconcile then requires `csm-ci/policy` on a repository without callers. The first matching entry wins, so keep the server's entry first when you use globs.

The schema rejects unknown keys and rejects the Server or Approver bot in any trust list. Every operation reads `csm-ci.yaml` from the triggering server commit, `GITHUB_SHA`; merge readiness reloads it from the current default branch.

## Explicit secret contract migration

Each reusable workflow declares the secrets it consumes by name, and callers map each one explicitly; supported callers do not use `secrets: inherit`. Older reusable workflow revisions relied on inheritance, so upgrade a caller's pin and secret mapping together. Changing only the mapping can fail GitHub workflow validation.

| Caller | Required mapping | Feature-specific mappings |
|---|---|---|
| All five client workflows | `CSM_CI_CLIENT_APP_PRIVATE_KEY` | None |
| Server label workflow | `CSM_CI_SERVER_APP_PRIVATE_KEY` | `CSM_CI_APPROVER_APP_PRIVATE_KEY` for approval; `CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY` and `CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE` for Terraform provider publication |
| Repo-settings workflow and both nested targets | `CSM_CI_SERVER_APP_PRIVATE_KEY` | `CSM_CI_APPROVER_APP_PRIVATE_KEY` for manual activation |
| Server check workflow | None | None |

Map every name to the identical `secrets.NAME` expression. Each client repository stores only the Client App key at repository level. Strong credentials remain in the server's `csm-ci` environment with its default-branch-only deployment restriction. The calling job can evaluate an environment-only name to an empty string; the called job's environment supplies it. GitHub checks that required mappings exist before jobs start. It does not check whether their values are nonempty.

Never pass credentials through workflow inputs, outputs, artifacts, logs or command arguments, and never add a PAT fallback.

Approval and manual activation fail at the pinned App-token action if the approver key is empty, with `The 'private-key' input must be set to a non-empty string. If using a secret or variable, ensure it is available in this workflow context.` Terraform provider publication requires both signing inputs before signing and fails with `Input required and not supplied: gpg-private-key` or `Input required and not supplied: gpg-passphrase`. Other release types need neither signing input. Managed-files-only runs and repairs without activation need no approver capability. Repo-settings never forwards provider signing credentials, and production callers never forward `csm-ci-e2e` credentials.

Verify the named contract, both nested repo-settings edges, and bootstrap activation in testing before rolling out compatible pins and callers to production one repository at a time. No credential placement or App permission change is needed.

## 4. Add the server workflows

Pin both calls to a full commit SHA of csm-ci-actions.

`.github/workflows/csm-ci.yml` runs the server:

```yaml
name: csm-ci
# The run title is the request label (csm-ci-<op>-<rand>) and its description (<repository>/<numbers>); run-name is set before intake runs.
run-name: ${{ github.event.label.name }} ${{ github.event.label.description }}
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

Omit feature-specific names when their features are disabled. Keep the Server App key mapping in every label caller. The [isolated probe](testing.md#github-behavior-relied-on) verified environment availability and required mapping validation. Full runtime verification remains a separate rollout gate.

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

The following automerge caller is planned. Add it only after a compatible runtime and reusable workflow have been released and installed. The cron expression sets the requested sweep interval. GitHub accepts schedules no more frequent than every five minutes and can delay runs during high load.

```yaml
name: csm-ci-automerge
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:
permissions: {}
jobs:
  sweep:
    uses: civitaspo/csm-ci-actions/.github/workflows/server-automerge.yml@<sha> # <version>
    permissions:
      contents: read
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
```

Map the environment-only secret explicitly. Do not use `secrets: inherit`.

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

The client forwards exactly `/merge` and `/merge cancel`. `/merge` creates a reservation that csm-ci evaluates immediately and on scheduled sweeps. The reservation remains active for up to seven days and survives head changes. csm-ci merges only after approval, policy, and required checks pass for the current head. A trusted merger cancels it with `/merge cancel`; editing or deleting the original comment does not cancel it. See [Merge](merge.md).

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
      targets:
        description: Comma-separated settings, rulesets, releases, managed-files, or all.
        type: string
        default: all
permissions: {}
jobs:
  settings:
    permissions:
      contents: read
    uses: civitaspo/csm-ci-actions/.github/workflows/server-repo-settings.yml@<sha>
    with:
      repository: ${{ inputs.repository || '' }}
      targets: ${{ inputs.targets || 'all' }}
    secrets:
      CSM_CI_SERVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}
      CSM_CI_APPROVER_APP_PRIVATE_KEY: ${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}
```

Pin `<sha>` to the reviewed actions commit. `targets` selects what a dispatch changes; see [targets](repo-settings.md#targets). A schedule has no inputs and always uses `all`. The schedule repairs drift without creating or re-enabling `controlled-merges`. To activate it, first distribute the merge caller and clear the auto-merge queue, then dispatch for that repository. The server verifies these prerequisites before it changes anything, whenever a dispatch would activate the ruleset.

Review managed-file pull requests from `csm-ci/repo-settings` and request `/merge` through the normal approval process. To stop controlled merging, set the ruleset's enforcement to `disabled`; the schedule preserves that state.


## Generated caller rollout gate

The standard caller generator runtime requires the [reviewed adoption procedure](repo-settings.md#adopt-existing-callers). Upgrade every Server parser pin before adding `release_prepare`. Remove selected caller destinations from `additional_managed_files` in the same reviewed configuration change that selects them. Configure `release_prepare.version_files` for repositories whose release version files differ from the default set. Review each generated PR that replaces or deletes a caller before merging it.

Discovery resolves and validates one published stable release for all targets and both managed-file stages. The current stable `v0.1.0` lacks the required interfaces, so deployment is blocked until an intended compatible release is separately authorized and published. Do not select an older release, use a mutable ref, or publish a temporary version. Full-SHA local tests do not establish this published-stable gate. Run repo-settings, release-pr, affected client suites, then smoke at the signed pushed candidate after that prerequisite. Preserve the normal protected review and merge process and the owned-branch recovery procedure for incompatible pending managed PRs.
