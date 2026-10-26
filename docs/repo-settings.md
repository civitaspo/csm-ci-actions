# Repository settings

The server reconciles repository settings, four fixed rulesets, immutable releases, and managed-file pull requests. Configuration is global. Repository entries select targets and retain only their existing operation and release settings.

## Configuration

The optional `repo_settings` block belongs in the server's `csm-ci.yaml`:

```yaml
repo_settings:
  settings:
    delete_branch_on_merge: true
    allow_auto_merge: false
    allow_squash_merge: true
    allow_merge_commit: false
    allow_rebase_merge: false
    has_wiki: false
    has_projects: false
    allow_update_branch: true
  managed_files:
    .github/PULL_REQUEST_TEMPLATE.md: |
      ## Why

      ## Verification
```

Omitted repository settings remain unchanged. The merge-method settings accept only the values shown above.

`has_wiki`, `has_projects`, and `allow_update_branch` are optional booleans. Each accepts `true` or `false`. The example disables Wiki and Projects and enables GitHub's suggestion to update pull request branches. `allow_update_branch` does not update branches or require branches to be up to date before merging. Existing merge, approval, required-check, and ruleset behavior remains unchanged.

Inspection reports drift for each configured field and fails if a configured field is missing from the API response. Sync repairs differing values without changing omitted fields or unrelated repository settings. A second sync with no settings drift makes no settings write. Read and update API errors fail the run, including errors for unsupported settings.

When `allow_squash_merge` is explicitly `true`, reconciliation also enforces `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`. These fixed values use the pull request title and description for both single-commit and multi-commit squash merges. Do not add these fields to `csm-ci.yaml`; they are implied by `allow_squash_merge: true`. Inspection reports drift in each field and fails if either field is missing. Sync repairs either field even when squash merging is already enabled. A repeat with no further settings drift makes no settings write. If `allow_squash_merge` or the entire `settings` block is omitted, both fields remain unchanged, even when the repository already allows squash merges. The fixed rulesets still apply.

Managed files map literal relative paths to UTF-8 text. Paths cannot contain traversal, Git metadata, glob syntax, or conflicting parent and child file names. Files use the securefix size limits. Removing a path from configuration stops managing it; it does not delete the file. If `csm-ci/repo-settings` still holds a commit that changed the removed path, later runs reject the branch as changing an unmanaged path. Close its pull request and delete the branch, and the next run starts it again from the default branch.

Configuration comes from the triggering server commit, `GITHUB_SHA`. Discovery intersects the repositories of the Server App installation on the server's owner with `owners` and the first matching `repositories` entry. Repositories under another owner are not discovered. The actions repository is eligible when installed and configured, including when explicitly selected. It remains subject to its fixed all-paths-sensitive policy. An explicit repository selector limits the run to that repository. When the selected set includes the server, its job runs after the client jobs finish, even when one of them failed, so one broken repository cannot stall the server's own repair. Within a repository, settings, rulesets and immutable releases are applied before managed files, so a rejected `csm-ci/repo-settings` branch does not block them.

## Sponsorships

This section specifies the planned contract for issue #67. A separate runtime implementation and deployment are required before use. Do not add `sponsorships` to Server configuration pinned to a revision without that implementation; its configuration schema rejects the key.

The optional global `repo_settings.sponsorships` block configures the Sponsor button separately from its funding content:

```yaml
repo_settings:
  sponsorships:
    enabled: true
    github: [your-sponsors-login]
```

`enabled` is required and accepts `true` or `false`. Omission of the block leaves the button setting unmanaged. The optional `github` list contains one to four explicit recipient logins. No account is inferred from the repository owner. Each login has 1 to 39 ASCII alphanumeric characters or single hyphens between alphanumeric characters. Empty values, whitespace, URLs, leading `@`, invalid characters, leading or trailing hyphens, consecutive hyphens, and case-insensitive duplicates are rejected. Logins are normalized to lowercase in their configured order. Four total recipients is the supported subset here, not GitHub's platform limit. Syntax validation does not prove that an account exists or accepts sponsorships.

When `github` is present, the server generates the entire `.github/FUNDING.yml` with a quoted YAML list and a trailing newline:

```yaml
github: ["your-sponsors-login"]
```

Generation also runs with `enabled: false`, which allows a funding PR before button activation. Omitting `github` leaves funding content unmanaged by the generator, even when the button is enabled. A literal managed funding file can be distributed in that case. This also applies to a Server-source additional file when that feature is available. Configuring a managed file at `.github/FUNDING.yml` while `github` is present fails validation; neither producer overrides the other. The combined desired file set uses the existing path, file-count, and byte limits.

Generated content replaces existing recipients and all unconfigured funding providers through the normal managed-file PR. The server does not merge existing provider entries or write directly to default. Removing `github` or the entire block preserves the existing file. An outstanding managed PR that changed the removed path follows the same recovery procedure as other removed managed files in [Configuration](#configuration).

In `reconcile`, the existing target-scoped administration token reads the repository node ID and `hasSponsorshipsEnabled` through GraphQL. The server reports drift and repairs it through `updateRepository`, using `repositoryId` and `hasSponsorshipsEnabled`. Missing or invalid fields and API errors fail the run. A repeat with no drift makes no sponsorship mutation. Existing final revalidation still applies. A lost mutation response requires a state read before another write. `managed-files-only` proposes the same funding content without reading or changing the setting or minting an administration token.

The setting result and funding-file PR result are separate. An enabled setting with a pending PR is not completed funding setup. The generated file reaches default only after normal review, CI, approval, and protected merging. An exact repeat reuses the PR and head; matching default-branch content needs no PR. GraphQL `fundingLinks` exposes resolved funding links, not a recipient-write API or proof that a pending PR has merged. See [GitHub's sponsor-button documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository) and [GraphQL repository reference](https://docs.github.com/en/graphql/reference/repos#updaterepositoryinput).

Implementation must verify setting changes with the existing Server App and record testing-repository run URLs, generated PRs, repeat behavior, and merged default-branch content in `docs/handoff.md`. Permission failures remain errors. Only the operator changes App permissions or credentials. Production recipients must come from explicit reviewed Server configuration.

## Rulesets and emergency stop

The rulesets have fixed meanings from the [security specification](first-release-plan.md#s6-placement-of-secrets-and-permissions):

| Name | Target | Rules |
|---|---|---|
| `integrity` | Default branch | No deletion or force-push; linear history and signed commits; no bypass |
| `review-and-checks` | Default branch | One approval, dismiss stale approvals, required policy and configured checks, squash merges |
| `controlled-merges` | Default branch | Updates require a pull request through the Server App |
| `release-tags` | `refs/tags/v*` | Only the Server App can create, update, or delete matching tags |

The server matches rulesets by name and `source_type: Repository`. Duplicate names fail the run. It replaces the complete managed ruleset, leaving unrelated rulesets alone. Immutable releases are enabled and never disabled.

A scheduled run does not create `controlled-merges` or activate a disabled ruleset. Every repair that does not activate it, scheduled or dispatched, omits its enforcement, so a stop set during the run is kept. Set its enforcement to `disabled` for an emergency stop. Manual dispatch activates it, creating it when absent, only after these checks pass:

- The default branch contains a merge caller for newly created issue comments, with `secrets: inherit` and no job-level `if:`. The server also needs its label caller under the same rules.
- The configured approver App can obtain a repository-scoped contents-write token, and its bot identity matches configuration.
- No open pull request has auto-merge queued.
- An existing `controlled-merges` ruleset has only the Server App's `pull_request` bypass.

The checks run only when a dispatch would activate the ruleset. A dispatch for a repository whose `controlled-merges` is already active repairs drift without them. A failed preflight fails the run before administrative changes. App permission proof uses the official token action. The collaborator-permission endpoint does not reliably describe whether an App's approval counts.

## Bootstrap mode

The reusable workflow accepts `mode: reconcile | managed-files-only`. It defaults to `reconcile`. Scheduled runs always reconcile and reject `managed-files-only`.

Use `managed-files-only` to distribute the configured files before a target has the merge caller, policy checks, or the approver App needed for activation. This mode skips settings and ruleset inspection, activation preflight, approver capability, and administrative apply. It still validates the server and target context, inspects the managed branch, and opens or updates the managed-file pull request.

After Apps and credentials are provisioned, dispatch `managed-files-only`, review and merge the generated pull request through the repository's current process, verify the caller workflows and required checks on the default branch, then dispatch `reconcile`. The [first-release plan](first-release-plan.md#phase-6-repo-settings) defines the complete bootstrap order.

## Managed-file pull requests

Managed files use `csm-ci/repo-settings` on both clients and the server. The server verifies every commit after the merge-base before reusing this branch. Each commit must be a GitHub-signed Server App commit and change only managed paths. Symlinks, submodules, unsafe trees, and ambiguous pull requests are rejected.

For changed content, the server resets the verified managed branch to the observed default-branch head with a Git lease, then writes through `createCommitOnBranch` with the expected head. A verified managed branch that is an ancestor of default is also rebuilt, even when its files match, so the pull request can target the current default branch. Concurrent changes fail instead of being overwritten. An exact repeated request keeps the existing commit and pull request. When default already contains the desired files, no update is needed.

The target workflow serializes runs per repository and does not cancel a running attempt. GitHub can replace an older pending run when a newer run enters the same concurrency group. Check the final run result and dispatch again if the requested run was replaced.

Managed files reach default only through the pull request. A trusted merger requests `/merge` after review. New executable files are unsupported because `createCommitOnBranch` cannot set their executable bit.

## Credentials

The `csm-ci` environment holds App credentials. The official `actions/create-github-app-token` action issues all tokens; application code receives tokens only.

Discovery uses metadata read access. The activation preflight and managed-file inspection use a repository-scoped token with contents and pull-requests read access. Settings, rulesets and immutable releases are read and changed with a token scoped to one target with only `administration: write`. The apply stage reruns the activation preflight before its first write. GitHub returns a ruleset's `bypass_actors` only to callers with write access to that ruleset, so a read-only token cannot tell whether the fixed bypass is present; a ruleset response without that field fails the run. Managed-file writes use a different token with contents and pull-requests write access. It adds workflows write access for workflow changes and for the reset of an existing branch, because the reset may move the branch across workflow changes on the default branch. Approver capability tokens are used only for preflight and make no writes.

The approver App must be installed on every target where manual dispatch enables controlled merges, including the server. The operation does not install Apps, distribute secrets, or create repositories. See [setup](setup.md) for the caller workflow.
