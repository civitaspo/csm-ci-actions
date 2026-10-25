# csm-ci-actions

This repository provides GitHub Actions for CI tasks such as approvals, checks, merges, fixes, and releases without granting broad permissions to client repositories. Client workflows submit requests to a separate server repository. The server holds the write credentials, checks each request against GitHub and its configuration, and applies the permitted change.

This project is **strongly inspired by the [Client-Server Model](https://github.com/csm-actions/docs) and [securefix-action](https://github.com/csm-actions/securefix-action)**. They address the same problem: allowing CI to make useful repository changes without placing powerful write credentials in the workflows that run client code. Their separation of client requests from server-side validation is the foundation of this project's design.

csm-ci-actions extends that approach with approval and policy checks, controlled squash merges, release preparation and publishing, and repository settings reconciliation. Securefix applies generated file changes only after validating their source, paths, content, and current branch head.

## Choose an entry point

- **Client repository operators:** enable the operations in the server configuration, then add the [client callers](#client-actions).
- **Server operators:** provision the Apps and credentials in the [setup guide](docs/setup.md), then install the [server callers](#server-workflows-and-actions).
- **Contributors:** use the [local checks and live tests](#development).

Pin every action and reusable workflow to a reviewed full commit SHA. Replace `<sha>` in the examples before using them. Keep callers on the repository's default branch.

## Trust and credentials

A client action creates a `csm-ci-<op>-<random>` label in the server repository. Its description identifies the repository and a pull request or workflow run. The server checks the sender, live label, enabled operation, and first run attempt. It then reads the relevant GitHub facts itself. The cleanup job deletes the request label.

| App | Installed on | Credentials |
| --- | --- | --- |
| `csm-ci-client` | Server repository only | Each client stores `CSM_CI_CLIENT_APP_CLIENT_ID`, `CSM_CI_CLIENT_APP_PRIVATE_KEY`, and `CSM_CI_SERVER_REPOSITORY`. The token has issues write access on the server. |
| `csm-ci-server` | Server and managed client repositories | `CSM_CI_SERVER_APP_CLIENT_ID` and `CSM_CI_SERVER_APP_PRIVATE_KEY` stay in the server's `csm-ci` environment. Jobs mint tokens scoped to their target and required permissions. Discovery lists the installation with metadata read. |
| `csm-ci-approver` | Each target where controlled merges are activated, including the server | `CSM_CI_APPROVER_APP_CLIENT_ID` and `CSM_CI_APPROVER_APP_PRIVATE_KEY` stay in the server's `csm-ci` environment. The App needs pull requests write and contents write for counted approvals. |

The server also needs the client variables, key, and callers when it submits requests for its own pull requests. These variable and secret names are fixed. Testing App names use the `testing-` prefix.

The Server App key is shared by privileged jobs. Narrow tokens limit ordinary use, but do not prevent a compromised job from minting a broader token. Securefix and release preparation expose the Client App key to the job that runs client tools. That key can affect issues and labels in the server repository, so it is not a read-only credential. The server validates requests independently of client tools. Protect write access to the server repository and its `csm-ci` environment.

## Client actions

Each action lives under `actions/client/<name>`. Except for securefix, the usual entry point is its thin reusable workflow under `.github/workflows/client-<name>.yml`. Each action creates its own scoped Client App token. All take `client-id`, `private-key`, and `server-repository`; the reusable workflows read the names listed above. Each action reference below lists every input and output, defaults, prerequisites, and a usage example.

| Action | Purpose and caller event | Usage details |
| --- | --- | --- |
| [`approve`](actions/client/approve/README.md) | Request an approval on `pull_request_target` activity or a `/recheck` or `/approve` issue comment. The request job does not check out PR code. | [`client-approve.yml`](.github/workflows/client-approve.yml), [approval rules and force approval](docs/approve.md) |
| [`policy-check`](actions/client/policy-check/README.md) | Request the `csm-ci/policy` check on PR changes, including base edits. | [`client-policy-check.yml`](.github/workflows/client-policy-check.yml), [policies](docs/policy-check.md) |
| [`merge`](actions/client/merge/README.md) | Request a squash merge from an exact `/merge` issue comment. The server checks the requester, approval, policies, and required checks. | [`client-merge.yml`](.github/workflows/client-merge.yml), [merge behavior](docs/merge.md) |
| [`securefix`](actions/client/securefix/README.md) | Package changes made by earlier steps in the same job. Supports same-repository `pull_request`, `push`, and `workflow_dispatch`; fork PRs are skipped. | Direct action step shown below; [workspace, routes, limits, and retries](docs/securefix.md) |
| [`release-prepare`](actions/client/release-prepare/README.md) | Generate a changelog and version edits on a default-branch push or manual dispatch, then request a `release/next` PR through securefix. An optional `version` omits the `v` prefix. | [`client-release-prepare.yml`](.github/workflows/client-release-prepare.yml), [release route and caller example](docs/release-pr.md) |
| [`release-publish`](actions/client/release-publish/README.md) | Request a release when a same-repository `release/next` PR is merged into default. The server validates the merge and release version. | [`client-release-publish.yml`](.github/workflows/client-release-publish.yml), [build types and publishing](docs/release.md) |

A minimal merge caller is `.github/workflows/csm-ci-merge.yml`:

```yaml
name: csm-ci-merge
on:
  issue_comment:
    types: [created]
permissions: {}
jobs:
  merge:
    uses: civitaspo/csm-ci-actions/.github/workflows/client-merge.yml@<sha>
    secrets: inherit
```

Approval and policy-check need their own callers and event filters. Copy them from [setup](docs/setup.md#5-add-the-client-workflows). Release preparation also needs a configured securefix route; enabling the `release` operation alone does not configure it.

Securefix runs after your tools in the same job. This example assumes the repository defines `npm run format`:

```yaml
name: securefix
on:
  pull_request:
permissions: {}
jobs:
  fix:
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
      - uses: civitaspo/csm-ci-actions/actions/client/securefix@<sha>
        with:
          client-id: ${{ vars.CSM_CI_CLIENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}
          server-repository: ${{ vars.CSM_CI_SERVER_REPOSITORY }}
```

Use the PR head SHA, not GitHub's synthetic merge commit. For another checkout directory, pass `workspace`. If no files changed, securefix sends no request. Do not use `pull_request_target` for this tool job. The [securefix guide](docs/securefix.md) describes the server-side checks and permitted paths.

## Server workflows and actions

Keep `csm-ci.yaml` on the server's default branch. The reusable workflows coordinate validation, token issuance, job isolation, and cleanup. Use these workflows as the server entry points; individual server actions are stages within them.

| Reusable workflow | Caller and purpose |
| --- | --- |
| [`server.yml`](.github/workflows/server.yml) | `label: created`. Validate and handle approve, policy-check, merge, securefix, and release requests. |
| [`server-check.yml`](.github/workflows/server-check.yml) | `push` and `pull_request`. Validate configuration with the pinned actions version and lint the server workflows. |
| [`server-repo-settings.yml`](.github/workflows/server-repo-settings.yml) | `schedule` and `workflow_dispatch`. Reconcile configured targets or distribute managed files in manual bootstrap mode. Optional inputs are `config-path`, `repository`, and `mode`. |

A minimal request receiver is `.github/workflows/csm-ci.yml`:

```yaml
name: csm-ci
on:
  label:
    types: [created]
permissions: {}
jobs:
  server:
    uses: civitaspo/csm-ci-actions/.github/workflows/server.yml@<sha>
    secrets: inherit
    permissions:
      contents: read
      issues: write
      id-token: write
      attestations: write
```

Do not add caller-level concurrency that cancels unrelated labels. The reusable workflow owns request serialization. `secrets: inherit` is required for the called jobs' environment credentials. The [setup guide](docs/setup.md#4-add-the-server-workflows) includes the configuration-check caller.

The server actions live under `actions/server/<name>`:

| Action | Stage and use |
| --- | --- |
| [`intake`](actions/server/intake/README.md) | Validate the live label and emit the normalized request for `server.yml`. |
| [`approve`](actions/server/approve/README.md) | Check commit trust and policies, then approve through the Approver App. [Approval details](docs/approve.md). |
| [`policy-check`](actions/server/policy-check/README.md) | Publish the server-owned `csm-ci/policy` check. [Policy details](docs/policy-check.md). |
| [`merge`](actions/server/merge/README.md) | Wait for readiness, revalidate with fresh tokens, squash merge, and report the result. [Merge details](docs/merge.md). |
| [`securefix`](actions/server/securefix/README.md) | Validate the source run and artifact, then apply bounded changes with expected-head checks. [Securefix details](docs/securefix.md). |
| [`release-plan`](actions/server/release-plan/README.md) | Verify the merged release PR and emit the release plan. |
| [`release-build`](actions/server/release-build/README.md) | Build with `build-type: none`, `js-action`, `goreleaser`, or `cargo` in the workflow's isolated job without secrets or an environment. |
| [`release-assets`](actions/server/release-assets/README.md) | Validate build outputs and create `SHA256SUMS` without executing client code. |
| [`release-tag`](actions/server/release-tag/README.md) | Create the planned annotated tag when absent. |
| [`release-publish`](actions/server/release-publish/README.md) | Create or complete the draft, publish, and verify the immutable release's assets and tag. |
| [`repo-settings`](actions/server/repo-settings/README.md) | Validate context, discover targets, inspect and apply settings, and reconcile managed-file PRs. The reusable workflow selects the stages and tokens. [Repository settings details](docs/repo-settings.md). |
| [`check-config`](actions/server/check-config/README.md) | Validate a local `csm-ci.yaml` against this revision's schema. Used by `server-check.yml`. |

The [release guide](docs/release.md) describes the five release stages, build configuration, and replay behavior. [Release attestations](docs/release-attestation.md) describe provenance. Each linked action reference includes all inputs and outputs and a usage example. Server examples identify the earlier workflow stage that produces each required value; use the coordinating reusable workflow to preserve these boundaries.

### Bootstrap managed files before enabling protections

After provisioning Apps and credentials, use `managed-files-only` to open the configured `csm-ci/repo-settings` PR. This manual mode does not mint administration or approver tokens or change repository settings, rulesets, or immutable releases. It still enforces target, path, history, and head checks.

Add the following caller to the server's default branch. Manual dispatch defaults to bootstrap; the daily schedule reconciles settings:

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
      mode:
        type: choice
        default: managed-files-only
        options: [managed-files-only, reconcile]
permissions: {}
jobs:
  settings:
    uses: civitaspo/csm-ci-actions/.github/workflows/server-repo-settings.yml@<sha>
    permissions:
      contents: read
    with:
      repository: ${{ inputs.repository || '' }}
      mode: ${{ inputs.mode || 'reconcile' }}
    secrets: inherit
```

Review and merge the generated PR through the repository's current process. Verify the required callers and checks on default before dispatching `reconcile`. Reconciliation activates `controlled-merges` only after its preflight succeeds. The global managed-files map contains literal text; it does not template each repository or provision credentials.

Scheduled runs use `reconcile`. They preserve a disabled `controlled-merges` emergency stop. A later manual reconciliation can activate it again. See [repository settings](docs/repo-settings.md) for prerequisites, drift repair, pending-run replacement, and managed-branch recovery. For migration from an existing installation, use the [cutover guide](docs/cutover.md).

## Development

Follow [AGENTS.md](AGENTS.md) when contributing. The [specification](docs/first-release-plan.md) defines the supported behavior. Source entry points are `src/<side>-<name>/main.ts`; committed bundles are `dist/<side>-<name>.js`.

Install [mise](https://mise.jdx.dev/) and use the tool versions in [mise.toml](mise.toml). Run the required checks:

```sh
mise install
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
bun run build
test -z "$(git status --porcelain dist/)"
mise exec -- jactionlint
```

When a source change updates bundles, review and commit the regenerated `dist/` files. The clean-dist check must pass before opening the PR. Keep rejection cases table-driven, assert their error messages, and mutation-check each new or changed rule. Give each mutant a timeout and restore from copies taken before the first mutation. Obtain an independent review against the specification.

### Run live e2e in the testing repositories

The harness uses only `civitaspo/testing-csm-ci-client` and `civitaspo/testing-csm-ci-server` as targets. It moves the `e2e` branch in `civitaspo/csm-ci-actions` to the supplied revision and synchronizes test fixture workflows. These are live writes, not a local simulation.

Prerequisites are a signed, pushed full commit SHA; the testing Apps, configuration, variables, and secrets from [setup](docs/setup.md); and an authenticated `gh` session with the required access to all three repositories. `GH_TOKEN` acts as the testing owner. `CSM_CI_ACTIONS_TOKEN`, when set, handles the actions repository's branch and lock; otherwise the harness uses `GH_TOKEN` for both. Credential provisioning is an operator task.

Run one feature suite at a time, then smoke:

```sh
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full-sha> --feature repo-settings
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full-sha> --feature smoke
```

Available features are `approve`, `merge`, `policy-check`, `securefix`, `release`, `release-pr`, `repo-settings`, and `smoke`. The feature name remains `release-pr` even though its client action is named `release-prepare`. Record run URLs and any skips in the PR.

The local runner skips scenarios that need `CSM_CI_UNTRUSTED_COMMITTER_TOKEN`. The [CI e2e workflow](.github/workflows/e2e.yml) supplies that second identity from its preconfigured `csm-ci-e2e` environment. After merge, dispatch the affected suites and smoke sequentially from `main`, testing the merged SHA:

```sh
gh workflow run e2e.yml --repo civitaspo/csm-ci-actions --ref main \
  -f ref=<merged-full-sha> -f feature=repo-settings
```

Wait for completion before dispatching the next suite. The harness lock and workflow concurrency protect shared state, but a newer queued GitHub run can replace an older pending run.

Scenarios restore temporary configuration and administrative state in cleanup paths and verify restoration where applicable. A failed API call or killed process can leave state behind. If a run is interrupted, first ensure it and its dispatched workflows have stopped. Inspect restoration diagnostics, verify ownership of leftover test objects, close owned `e2e-*` PRs, and remove the stale `e2e-lock` label before restarting. Do not delete a ruleset by name alone or reset an unverified managed branch. Changed-content resets of existing managed branches are excluded from the live verification procedure. Keep that limitation explicit when reporting results.

## License

[MIT](LICENSE)
