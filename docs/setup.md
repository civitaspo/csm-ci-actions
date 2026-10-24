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
policies:
  - { type: signed-commits }
  - { type: trusted-committers }
  - { type: sensitive-paths, paths: [".github/**", "Makefile"], exempt: [] }
repositories:
  - { name: your-account/*, ops: [approve, merge, policy-check] }
```

The schema rejects unknown keys and puts the server bot in no trust list.

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
    # Environment secrets reach the called job only through inherit.
    # jactionlint ignore=secrets-inherit
    uses: civitaspo/csm-ci-actions/.github/workflows/server.yml@<sha>
    secrets: inherit
    permissions:
      contents: read
      issues: write
```

`secrets: inherit` is required. Without it, the environment secrets are empty in the called job.

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
    # The client App key reaches the called job only through inherit.
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
