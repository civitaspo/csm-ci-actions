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
  managed_files:
    .github/PULL_REQUEST_TEMPLATE.md: |
      ## Why

      ## Verification
```

Omitted repository settings remain unchanged. The merge-method settings accept only the values shown above. Managed files map literal relative paths to UTF-8 text. Paths cannot contain traversal, Git metadata, glob syntax, or conflicting parent and child file names. Files use the securefix size limits. Removing a path from configuration stops managing it; it does not delete the file. If `csm-ci/repo-settings` still holds a commit that changed the removed path, later runs reject the branch as changing an unmanaged path. Close its pull request and delete the branch, and the next run starts it again from the default branch.

Configuration comes from the triggering server commit, `GITHUB_SHA`. Discovery intersects the repositories of the Server App installation on the server's owner with `owners` and the first matching `repositories` entry. Repositories under another owner are not discovered. The actions repository is excluded. An explicit repository selector limits the run to that repository. When the selected set includes the server, its job runs after the client jobs succeed.

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

- The default branch contains an unconditional merge caller for newly created issue comments. The server also needs its label caller.
- The configured approver App can obtain a repository-scoped contents-write token, and its bot identity matches configuration.
- No open pull request has auto-merge queued.
- An existing `controlled-merges` ruleset has only the Server App's `pull_request` bypass.

The checks run only when a dispatch would activate the ruleset. A dispatch for a repository whose `controlled-merges` is already active repairs drift without them. A failed preflight fails the run before administrative changes. App permission proof uses the official token action. The collaborator-permission endpoint does not reliably describe whether an App's approval counts.

## Managed-file pull requests

Managed files use `csm-ci/repo-settings` on both clients and the server. The server verifies every commit after the merge-base before reusing this branch. Each commit must be a GitHub-signed Server App commit and change only managed paths. Symlinks, submodules, unsafe trees, and ambiguous pull requests are rejected.

For changed content, the server resets the verified managed branch to the observed default-branch head with a Git lease, then writes through `createCommitOnBranch` with the expected head. Concurrent changes fail instead of being overwritten. An exact repeated request keeps the existing commit and pull request. When default already contains the desired files, no update is needed.

Managed files reach default only through the pull request. A trusted merger requests `/merge` after review. New executable files are unsupported because `createCommitOnBranch` cannot set their executable bit.

## Credentials

The `csm-ci` environment holds App credentials. The official `actions/create-github-app-token` action issues all tokens; application code receives tokens only.

Discovery uses metadata read access. The activation preflight and managed-file inspection use a repository-scoped token with contents and pull-requests read access. Settings, rulesets and immutable releases are read and changed with a token scoped to one target with only `administration: write`. The apply stage reruns the activation preflight before its first write. GitHub returns a ruleset's `bypass_actors` only to callers with write access to that ruleset, so a read-only token cannot tell whether the fixed bypass is present; a ruleset response without that field fails the run. Managed-file writes use a different token with contents and pull-requests write access. It adds workflows write access for workflow changes and for the reset of an existing branch, because the reset may move the branch across workflow changes on the default branch. Approver capability tokens are used only for preflight and make no writes.

The approver App must be installed on every target where manual dispatch enables controlled merges, including the server. The operation does not install Apps, distribute secrets, or create repositories. See [setup](setup.md) for the caller workflow.
