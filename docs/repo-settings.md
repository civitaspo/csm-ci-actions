# Repository settings

The server reconciles repository settings, four fixed rulesets, immutable releases, and managed-file pull requests. Configuration is global. Repository entries select targets and supply their operation and release settings. The standard caller generator also uses preparation settings.

## Configuration

The optional `repo_settings` block belongs in the server's `csm-ci.yaml`:

```yaml
repo_settings:
  settings:
    delete_branch_on_merge: true
    allow_auto_merge: true
    allow_squash_merge: true
    allow_merge_commit: false
    allow_rebase_merge: false
    has_wiki: false
    has_projects: false
    allow_update_branch: true
  additional_managed_files:
    .github/PULL_REQUEST_TEMPLATE.md: managed-files/pull-request-template.md
```

Omitted repository settings remain unchanged. The merge-method settings accept only the values shown above. `allow_auto_merge` accepts either value; with `false`, GitHub rejects enabling and `/merge` uses its [self-merge fallback](merge.md#self-merge-fallback).

`has_wiki`, `has_projects`, and `allow_update_branch` are optional booleans. Each accepts `true` or `false`. The example disables Wiki and Projects and enables GitHub's suggestion to update pull request branches. `allow_update_branch` does not update branches or require branches to be up to date before merging. Existing merge, approval, required-check, and ruleset behavior remains unchanged.

The three feature fields use the repository REST API with the existing target-scoped administration token. Upgrade all server configuration parser pins to a compatible runtime before adding these fields to deployed configuration.

Inspection reports drift for each configured field and fails if a configured field is missing from the API response. Sync repairs differing values without changing omitted fields or unrelated repository settings. A second sync with no settings drift makes no settings write. Read and update API errors fail the run, including errors for unsupported settings.

When `allow_squash_merge` is explicitly `true`, reconciliation also enforces `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`. These fixed values use the pull request title and description for both single-commit and multi-commit squash merges. Do not add these fields to `csm-ci.yaml`; they are implied by `allow_squash_merge: true`. Inspection reports drift in each field and fails if either field is missing. Sync repairs either field even when squash merging is already enabled. A repeat with no further settings drift makes no settings write. If `allow_squash_merge` or the entire `settings` block is omitted, both fields remain unchanged, even when the repository already allows squash merges. The fixed rulesets still apply.

`additional_managed_files` maps literal destinations to committed Server source files. See [Additional managed files](#additional-managed-files) for exact-commit loading, limits and migration. Removing a destination stops managing it and never deletes it. A pending managed branch that changed a removed path fails its existing history check when reuse is needed. Verify ownership before closing its pull request and deleting the owned branch; the next run starts from default. An empty desired set or matching default content needs no branch reuse and does not establish ownership of an existing branch.

Configuration comes from the triggering server commit, `GITHUB_SHA`. Discovery intersects the repositories of the Server App installation on the server's owner with `owners` and the first matching `repositories` entry. Repositories under another owner are not discovered. The actions repository is eligible when installed and configured, including when explicitly selected. Its sensitive-path protection comes from its explicit repository entry. An explicit repository selector limits the run to that repository. When the selected set includes the server, its job runs after the client jobs finish, even when one of them failed, so one broken repository cannot stall the server's own repair. Within a repository, settings, rulesets and immutable releases are applied before managed files, so a rejected `csm-ci/repo-settings` branch does not block them.

## Standard client workflows, planned

This runtime implements the contract for [issue #77](https://github.com/civitaspo/csm-ci-actions/issues/77). Deployment and an intended compatible stable release are still required. Do not add its new fields to configurations using older strict parser pins. It depends on the [explicit Secret contract](setup.md#explicit-secret-contract-migration), not the separate additional-files implementation.

### Caller selection

Generation runs whenever the `managed-files` target is selected and `repo_settings` is configured. Use the first matching `repositories` entry and the target's observed default branch. All destinations are under `.github/workflows/`. All reusable workflows are under `civitaspo/csm-ci-actions/.github/workflows/` and use the same resolved full commit SHA, followed by a ` # <version>` comment. The comment matches pinact-style client autofix, so autofix leaves generated bytes unchanged.

| Selection | Destination | Reusable workflow | Events | Job inputs and permissions |
|---|---|---|---|---|
| `approve` | `csm-ci-approve.yml` | `client-approve.yml` | `pull_request_target`: opened, synchronize, reopened, ready_for_review; `issue_comment`: created | No inputs or job condition; empty permissions |
| `policy-check` | `csm-ci-policy-check.yml` | `client-policy-check.yml` | `pull_request_target`: opened, synchronize, reopened, ready_for_review, edited | No inputs or job condition; empty permissions |
| `merge` | `csm-ci-merge.yml` | `client-merge.yml` | `issue_comment`: created | No inputs or job condition; empty permissions |
| `release` | `csm-ci-release.yml` | `client-release-publish.yml` | `pull_request`: closed | No inputs or job condition; empty permissions |
| `securefix` and canonical `release-pr` route | `csm-ci-release-pr.yml` | `client-release-prepare.yml` | Push to the actual default branch; manual dispatch | `version`, optional `version-files`; `contents: read` |

Workflow names are `csm-ci-approve`, `csm-ci-policy-check`, `csm-ci-merge`, `csm-ci-release`, and `csm-ci-release-pr`. Job names are `approve`, `policy-check`, `merge`, `release`, and `release-pr`. Every caller sets top-level `permissions: {}` and maps only `CSM_CI_CLIENT_APP_PRIVATE_KEY` to `${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}` under the same name. No generated caller uses inheritance. Existing Naming-list variables remain unchanged. Do not add request-cancelling concurrency or duplicate the reusable workflows' client prefilters.

A canonical preparation route has name `release-pr`, `from: default`, `to: release/next`, and workflow `.github/workflows/csm-ci-release-pr.yml`. No route means no generated preparation caller. A named route with conflicting values fails configuration validation for a repository selecting `securefix`. Keep `.release-version: semver`, `CHANGELOG.md: any`, and the configured supported root version edits under securefix's existing authorization. Generation never broadens the route's path permissions.

Preparation and publication remain independent:

| Effective configuration | Generated release callers |
|---|---|
| `release`, without authorized preparation | Publish only |
| `securefix` with canonical route, without `release` | Prepare only |
| Both selections | Prepare and publish |
| Neither selection | Neither |

The optional strict repository object `release_prepare` has one optional list, `version_files`, of literal root-relative paths that [release preparation](release-pr.md#generated-files) rewrites. Omission keeps the default file set. An empty list updates only `.release-version` and `CHANGELOG.md`. Validation rejects unknown keys, an explicit object without selected preparation, a path outside `package.json`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `dbt_project.yml` and `herdr-plugin.toml`, a duplicate path, and `Cargo.lock` without `Cargo.toml`. It also rejects a listed path whose first matching rule in the canonical `release-pr` route is not `version-only`, so generation never requests an edit securefix would refuse. The setting is independent of `release` build settings, so a prepare-only repository needs no publication configuration.

```yaml
repositories:
  - name: owner/herdr-plugin
    ops: [securefix]
    release_prepare:
      version_files: [Cargo.toml, Cargo.lock, herdr-plugin.toml]
```

The prepare caller declares an optional string dispatch input `version`, default `""`, described as an optional semantic version without a `v` prefix. It passes `${{ inputs.version || '' }}` to `version`. When `version_files` is configured, it also passes the list as a compact JSON string to `version-files`, for example `'["Cargo.toml","Cargo.lock"]'`; otherwise it omits that input. Version inference and generation remain in the reusable workflow. Do not persist a fixed version in Server configuration.

The prepare job runs on manual dispatch or on pushes whose head commit message starts with neither `chore(release): v` nor `release-pr: chore(release): v`. This standardizes the existing release-commit push suppression and prevents the generator from removing it during takeover. Its job condition is:

```yaml
if: >-
  github.event_name == 'workflow_dispatch' ||
  (!startsWith(github.event.head_commit.message, 'chore(release): v') &&
   !startsWith(github.event.head_commit.message, 'release-pr: chore(release): v'))
```

Repository-specific securefix CI remains operator-owned. This feature generates no server label or settings caller, general CI aggregation, arbitrary template, custom destination, or per-repository pin override.

### Resolve one released revision

Discovery resolves the latest published stable release of fixed `civitaspo/csm-ci-actions` once per distribution run. Exclude drafts and prereleases. Validate release metadata, resolve its tag reference, and dereference annotated tags with a finite bound and cycle rejection until a full commit SHA is obtained. Reject missing or malformed metadata, missing tags, non-commit targets, excessive tag depth, and API failures. Do not use `target_commitish` alone as the resolved commit proof.

Validate every reusable workflow required by the union of selected repositories at that commit before workflow-file writes. Parse their `workflow_call` contracts, not just file existence. Require the selected input names and types, compatible defaults and required inputs, the exact required Client App Secret declaration without additional required credentials, compatible workflow permissions, and the defining action-lock support required by their local composite calls. The prepare contract must accept the optional strings `version` and `version-files`, both defaulting to `""`. An incompatible release fails the run. There is no fallback to main, a tag pin, an older release, or the currently installed caller SHA.

Pass the validated version and full SHA through trusted discovery outputs to every target and both managed inspection and apply. Those stages consume the same result without independently resolving latest. Revalidate mutable target state before writes while retaining that resolved revision. A release published midway through a run affects only the next run. Include the version and full SHA in every proposed managed PR body and the deterministic generated header line in each caller.

Compose one desired set from selected callers, configured additional files, and generated funding content. Apply the existing combined path, parent/child, count, and byte limits before file writes. Reject any duplicate producer destination, even with identical bytes. Generated writes and generated deletions cannot be supplied by additional files. Unselected paths without the generated header remain available to operator-controlled files. Keep sponsorship's existing conditional funding reservation. Administrative results and file-stage errors remain separate.

### Write callers and delete generated leftovers

The first line `# Generated by csm-ci from <version> (<sha>).` is the only ownership signal. Every generated caller starts with it. No ownership record is written to commit messages or recovered from merged PRs, and no per-repository adoption setting exists.

For each repository, the Server computes the desired change set from the observed default head:

1. List `.github/workflows/` non-recursively. Every regular file ending in `.yml` or `.yaml` whose first line starts with `# Generated by csm-ci from ` is a deletion candidate.
2. Write each selected standard caller with its generated content. A selected path overrides deletion, so a header file at a selected path is replaced, and a differing custom file at a selected path is overwritten.
3. The change set is the generated writes plus the deletions of header candidates outside the desired set. If it equals the default branch, no commit or PR is proposed.

Files without the header on their first line are never written or deleted unless they are a selected standard destination. A header on a later line does not count. Removing an operation deletes its caller only if the default file still starts with the header.

Every change goes through the reviewed managed-file PR. Its normal review, CI, approval, and protected merge are the safety net for overwriting a customized selected caller. Keep written and deleted paths in the managed allowlist for full S4 commit-chain, signature, changed-path, and expected-head validation of any pending managed branch, including an entirely empty desired content map. Never add all standard paths permanently to that allowlist. Recompute the deletions and revalidate the default head, pending branch, and PR binding immediately before privileged writes. Preserve leases, signed commits, least-privilege workflow tokens, server-last ordering, and the normal review and protected merge path.

### Adopt existing callers

Inventory existing caller bytes, default heads, explicit release inputs, parser pins, and outstanding managed branches before rollout. Drain old configuration-writing runs. Upgrade all Server parser pins to a compatible verified runtime before adding new strict fields. Verify workflow merges are supported by the deployed merger; any bootstrap recovery follows its separate authorization.

In one reviewed Server configuration PR, select the operations and remove literal or additional entries that collide with selected callers. Configure `version_files` where a repository needs a file set other than the default. The next run proposes generated replacements for every selected caller whose bytes differ. Review that PR like any other workflow change before merging it.

An outstanding branch whose full signed history still changes an unmanaged literal path is rejected. Verify the exact owned PR, branch, and stopped writers before closing that PR and deleting only its owned branch under the existing recovery procedure. Then regenerate from current default. Do not reset an unverified branch, allow every reserved path, or require unrelated managed PRs to merge.

### Verify the implementation and release gate

Implement table-driven cases for every selection combination, prepare-only and publish-only boundaries, route conflicts, true/false/default root-version inputs, non-main defaults, and release-commit suppression. Cover missing, malformed, incompatible, and annotated releases, tag cycles and depth bounds, read failures, one resolution across all targets and both stages, and a newer release appearing midway through a run.

Cover producer collisions with writes and deletions, replacement of differing and header callers, equal-byte no-ops, header deletion at standard and non-standard paths, preservation of files without the first-line header, last-caller deletion, rejected pending histories, recovery, and an unchanged second sync. Assert rejection messages and mutation-check every changed rule. Update fixtures, generated bundles, repo-settings, release, setup, and cutover instructions together.

Run all required local gates and independent specification review. Run affected repo-settings and release-pr feature suites, affected client suites, and smoke at the signed pushed implementation SHA. After an authorized merge, run affected CI suites and smoke through the runner checkout on `main`. Record exact runtime and Server configuration SHAs, generated PRs, run URLs, skips, and restoration in the PR.

The latest stable release observed on 2026-10-27 is `v0.1.0`, whose prepare interface lacks the required root-version input and explicit Secret contracts. An intended compatible stable release is a deployment gate. Review its exact release PR and candidate under the normal checks and obtain publication authorization. Do not publish a throwaway release or choose an arbitrary version for this generator. The release need not contain the generator if the deployed runtime does, but its client interfaces must support every emitted caller and preserve deployed client behavior. Full-SHA tests cannot satisfy the published-stable acceptance case. Report that gap until an authorized intended release exists. The runtime does not authorize publication, credential, App permission, or production configuration changes. Live e2e remains required after the compatible stable release gate.

## Additional managed files

The runtime implements [issue #78](https://github.com/civitaspo/csm-ci-actions/issues/78). Upgrade every strict parser pin through the migration below before deploying this schema. Older deployed readers may still require the removed inline format.

The optional global map associates each target destination with a source file committed in the Server repository:

```yaml
repo_settings:
  additional_managed_files:
    .github/PULL_REQUEST_TEMPLATE.md: managed-files/pull-request-template.md
    .github/FUNDING.yml: managed-files/FUNDING.yml
    LICENSE: managed-files/LICENSE
```

Omitting the map means no additional files. The same map applies to every selected target in both modes. `managed-files/` is an example directory, not a required prefix. Sources are relative to the Server repository root, including with a nested `config-path`. There is no external URL, separate repository, templating, or per-repository override.

The server reads source Git objects at the exact `GITHUB_SHA` that supplied `csm-ci.yaml`. It does not use the latest branch tip, the actions checkout revision, or files on the runner. The existing Server configuration reader supplies contents-read access. Source resolution runs only during repo-settings file inspection and apply; other operations retain schema validation without source loading.

Both path roles must be normalized relative literal paths. Absolute paths, drive paths, backslashes, control characters, empty or dot segments, parent traversal, glob characters, and any case variant of a `.git` segment are rejected. Every source ancestor must be an actual Git tree and its leaf a regular blob. Missing objects, symlinks, submodules, non-directory ancestors, missing SHAs, truncated trees, malformed or unsupported blob encoding, invalid UTF-8, and API failures fail the file stage. No source failure is interpreted as an empty file or skipped entry.

Valid source bytes are copied without changes, including BOMs and line endings. Executable source mode is not copied. New executable target files retain the existing limitation. Reusing one source at several destinations is allowed. Every delivered copy counts toward the inclusive limits of 512 files, 8 MiB per file, and 10 MiB total UTF-8 content. The server loads and validates the complete desired set before any managed-file write, including generated content, actual sizes, and destination parent/child conflicts. Administrative synchronization retains its existing order and separate result.

An additional file cannot override a destination reserved by an active generator, even with identical content. Sponsorship generation reserves `.github/FUNDING.yml` when `sponsorships.github` is present, including with `enabled: false`. Otherwise a source file may supply it. Standard caller generation and its reserved paths require the separate [issue #77](https://github.com/civitaspo/csm-ci-actions/issues/77) deployment. This feature does not require that generator. Existing workflow callers can first move unchanged to source files, then transfer to generated ownership in #77's reviewed transition. No additional entry may bypass that generator's removal or reservation rules once deployed.

Source-only changes propose the same signed Server-owned PR updates as inline content changes. Identical retries keep the existing PR and head, and matching default content needs no update. Removing an entry stops managing the target file and never deletes it. Outstanding branches follow the same history checks and owned-branch recovery as the inline format. All signatures, leases, expected-head checks, final revalidation, token restrictions, and normal review and protected merge requirements remain.

### Migrate deployed inline content

Perform this procedure only after the runtime has passed the required local checks, independent review, repo-settings live tests, and smoke. This specification does not authorize credential or App permission changes.

1. Inventory the inline destinations, exact bytes and caller pins, existing managed branches and open PRs, and current parser workflow revisions. Confirm ownership before any later branch recovery. Drain old configuration-writing runs and recheck queued runs so an older writer cannot race migration.
2. In a reviewed Server PR, add ordinary source files with those exact inline bytes and omit `managed_files` while retaining repository settings. Keep source copies outside runnable Server workflows. This temporarily pauses additional-file management without changing target files, existing managed branches, or their PRs. An empty desired set makes no file write and does not inspect existing branch ownership. Unrelated managed PRs do not need merging.
3. Upgrade every Server parser pin through the normal protected PR process. Include configuration checks, label/intake, approve, policy-check, merge and its current-config reload, securefix, and release paths. Verify their deployed revisions accept the new schema. Before changing workflows, verify the deployed merger supports workflow-file merges. Any required bootstrap recovery needs the separate authorization described in [merge](merge.md).
4. Add `additional_managed_files` in a reviewed Server PR with the same destination set and bytes. Keep existing literal caller pins unchanged during this format migration. Normal history proof and expected-head checks resume when a branch needs reuse. If state changed or proof fails, inspect it and use the existing owned-branch recovery instead of overwriting it.
5. Verify the live result one repository at a time. Record the runtime and configuration SHAs, run URLs, proposed PRs or no-op results, and unchanged target content. Keep compatible parser pins for rollback, or restore a mutually accepted configuration before reverting them.

The final runtime rejects the removed `repo_settings.managed_files` key, including an empty map or both keys together. Its error directs the operator to commit the inline contents as Server files and replace the key with `repo_settings.additional_managed_files`. The migration does not retain two runtime formats.

Implementation must update fixtures and harness configuration rewrites, generated bundles, and setup examples together. Table-driven and mutation tests cover changed rejection rules, exact-commit resolution, preserved bytes, source-only updates, identical retries, removal, and safe existing-PR reuse. Record live evidence and any existing verification gaps in the PR; this specification has no live execution evidence of its own.

## Sponsorships

This runtime accepts the sponsorship contract from issue #67. Deployment and live acceptance checks remain pending. Upgrade every Server configuration parser pin to a verified compatible revision before adding `sponsorships`; older revisions reject the key.

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

Generation also runs with `enabled: false`, which allows a funding PR before button activation. Omitting `github` leaves funding content unmanaged by the generator, even when the button is enabled. A literal managed funding file can be distributed in that case. This also applies to a Server-source additional file after the separate additional-files runtime rollout. Configuring a managed file at `.github/FUNDING.yml` while `github` is present fails validation; neither producer overrides the other. The combined desired file set uses the existing path, file-count, and byte limits.

Generated content replaces existing recipients and all unconfigured funding providers through the normal managed-file PR. The server does not merge existing provider entries or write directly to default. Removing `github` or the entire block preserves the existing file. An outstanding managed PR that changed the removed path follows the same recovery procedure as other removed managed files in [Configuration](#configuration).

When the `settings` target is selected, the existing target-scoped administration token reads the repository node ID and `hasSponsorshipsEnabled` through GraphQL. The server reports drift and repairs it through `updateRepository`, using `repositoryId` and `hasSponsorshipsEnabled`. Missing or invalid fields and API errors fail the run. A repeat with no drift makes no sponsorship mutation. Existing final revalidation still applies. A lost mutation response requires a state read before another write. `targets: managed-files` proposes the same funding content without reading or changing the setting or minting an administration token.

The inspection reports `changes.sponsorships`, and administration apply reports `sponsorshipsUpdated` separately from `settingsUpdated`. Managed-file inspection and apply retain their separate result and PR number. The setting result and funding-file PR result are separate. An enabled setting with a pending PR is not completed funding setup. The generated file reaches default only after normal review, CI, approval, and protected merging. An exact repeat reuses the PR and head; matching default-branch content needs no PR. GraphQL `fundingLinks` exposes resolved funding links, not a recipient-write API or proof that a pending PR has merged. See [GitHub's sponsor-button documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository) and [GraphQL repository reference](https://docs.github.com/en/graphql/reference/repos#updaterepositoryinput).

Implementation must verify setting changes with the existing Server App and record testing-repository run URLs, generated PRs, repeat behavior, and merged default-branch content in the PR. Permission failures remain errors. Only the operator changes App permissions or credentials. Production recipients must come from explicit reviewed Server configuration.

## Rulesets and emergency stop

The rulesets have fixed meanings from the [security design](design.md#s6-placement-of-secrets-and-permissions):

| Name | Target | Rules |
|---|---|---|
| `integrity` | Default branch | No deletion or force-push; linear history and signed commits; no bypass |
| `review-and-checks` | Default branch | One approval, dismiss stale approvals, required policy and configured checks, squash merges |
| `controlled-merges` | Default branch | Updates require a pull request through the Server App |
| `release-tags` | `refs/tags/v*` | Only the Server App can create, update, or delete matching tags |

The server matches rulesets by name and `source_type: Repository`. Duplicate names fail the run. It replaces the complete managed ruleset, leaving unrelated rulesets alone. Immutable releases are enabled and never disabled.

A scheduled run does not create `controlled-merges` or activate a disabled ruleset. Every repair that does not activate it, scheduled or dispatched, omits its enforcement, so a stop set during the run is kept. Set its enforcement to `disabled` for an emergency stop. Manual dispatch activates it, creating it when absent, only after these checks pass:

- The default branch contains a merge caller for newly created issue comments, with an explicit same-name `CSM_CI_CLIENT_APP_PRIVATE_KEY` mapping and no job-level `if:`. The server also needs its label caller with a same-name `CSM_CI_SERVER_APP_PRIVATE_KEY` mapping. Any present approval or provider signing names must also map to their identical secret expressions. Optional feature presence is checked when that feature runs. Preflight rejects inheritance, missing required names, renamed names, literals, wrong secret references, and undeclared extra names. Whitespace inside the expression is allowed. See the [explicit secret contract](setup.md#explicit-secret-contract-migration). Caller triggers, unconditional jobs, referenced repository checks, and activation rejection messages are unchanged, including `caller workflow has not been distributed` and `caller workflow is not distributed on <repository>`. Upgrade old caller pins and mappings together before selecting this preflight revision.
- The configured approver App can obtain a repository-scoped contents-write token, and its bot identity matches configuration.
- No open pull request has auto-merge queued by an actor other than the Server bot. The query reads `autoMergeRequest.enabledBy` and compares its immutable ID and type `Bot` with the Server bot. A Server-queued request came from an accepted `/merge` and merges through the Server App's `pull_request` bypass.
- An existing `controlled-merges` ruleset has only the Server App's `pull_request` bypass.

The checks run only when a dispatch would activate the ruleset. A dispatch for a repository whose `controlled-merges` is already active repairs drift without them. A failed preflight fails the run before administrative changes. App permission proof uses the official token action. The collaborator-permission endpoint does not reliably describe whether an App's approval counts.

A reconcile takes over any existing ruleset that has one of these four names. Before enrolling a repository that already has protection, rename such rulesets (for example to `legacy-<name>`) and remove them once the csm-ci rulesets are active and a protected merge has passed.

To change one field of a ruleset, send the full body, because only omitting `enforcement` is verified to keep the current value:

```bash
gh api repos/<owner>/<repo>/rulesets/<id> | jq '{name, target, enforcement, conditions, rules, bypass_actors} + {enforcement: "disabled"}' | gh api -X PUT repos/<owner>/<repo>/rulesets/<id> --input -
```

### Break glass

Use this when csm-ci itself cannot merge, for example when the server's label workflow fails for every request so no `/approve` or `/merge` can run. Each bypass needs the repository owner's explicit authorization and covers one merge. The same procedure applies to the server repository itself.

1. Confirm that the fix PR's own checks pass and that it is the smallest change that restores csm-ci.
2. Stop repo-settings from touching the repository, because a scheduled run re-activates `integrity`, `review-and-checks` and `release-tags`. Disable the workflow with `gh workflow disable csm-ci-repo-settings -R <owner>/<server-repo>`, or uninstall the Server App from the repository.
3. Save every ruleset you will touch with `gh api repos/<owner>/<repo>/rulesets/<id>`.
4. Disable only the rulesets that block the merge, usually `controlled-merges` and `review-and-checks`, with the command above. Keep `integrity` and `release-tags` active.
5. Merge with `gh pr merge <number> --squash --match-head-commit <reviewed-head-sha>`. Restore `enforcement: active` right after, even if the merge fails.
6. Compare each restored ruleset with its saved copy field by field, and confirm that the merge commit is signed and its tree equals the reviewed head.
7. Re-enable the repo-settings workflow, then prove recovery with a real request such as `/approve` on an open PR.

## Targets

The reusable workflow accepts `targets`, a comma-separated list that names what the run changes. It defaults to `all`.

| Target | Changes | Tokens |
|---|---|---|
| `settings` | Repository settings, repository features, and the Sponsor button setting | Administration |
| `rulesets` | `integrity`, `review-and-checks`, `controlled-merges`, and `release-tags`, including the `controlled-merges` activation preflight | Administration; approver only when a dispatch activates `controlled-merges` |
| `releases` | Immutable releases | Administration |
| `managed-files` | The managed-file pull request: additional files, generated standard callers, and generated funding content | Contents and pull requests; workflows only when a managed path is a workflow or an existing branch is rebuilt |
| `all` | Every target above | As above |

Unselected targets are neither read nor written, and their tokens are not minted. Every run still mints the target-scoped contents and pull-requests read token. Selected targets run in the fixed order settings, rulesets, releases, then managed files, and the server repository is processed last. Entries may contain surrounding spaces and duplicates. An empty list, an empty entry, or an unknown target fails before discovery. Scheduled runs always use `all`: the reusable workflow ignores the caller's value on a schedule, and the runtime rejects any other selection on a schedule or on an event other than `workflow_dispatch`.

Use `targets: managed-files` to distribute the configured files before a target has the merge caller, policy checks, or the approver App needed for activation. This selection skips settings and ruleset inspection, activation preflight, approver capability, and administrative apply. It still validates the server and target context, inspects the managed branch, and opens or updates the managed-file pull request. Use the same selection to distribute generated callers without touching rulesets.

After Apps and credentials are provisioned, dispatch `targets: managed-files`, review and merge the generated pull request through the repository's current process, verify the caller workflows and required checks on the default branch, then dispatch `targets: all`.

## Managed-file pull requests

Managed files use `csm-ci/repo-settings` on both clients and the server. The server verifies every commit after the merge-base before reusing this branch. Each commit must be a GitHub-signed Server App commit and change only managed paths. Symlinks, submodules, unsafe trees, and ambiguous pull requests are rejected.

For changed content on an existing branch, the server creates a temporary `csm-ci/tmp/managed-<random>` branch at the observed default-branch head, writes through `createCommitOnBranch` with that expected head, moves the verified managed branch to the new commit in one Git update leased on its observed head, and deletes the temporary branch, also on failure. The managed branch never equals default, so GitHub does not close its open pull request, which keeps its number. A missing branch is created at the default head before the commit. A verified managed branch that is an ancestor of default is also rebuilt, even when its files match, so the pull request can target the current default branch. Concurrent changes fail instead of being overwritten. An exact repeated request keeps the existing commit and pull request. When default already contains the desired files, no update is needed.

The target workflow serializes runs per repository and does not cancel a running attempt. GitHub can replace an older pending run when a newer run enters the same concurrency group. Check the final run result and dispatch again if the requested run was replaced.

The managed commit headline and pull request title use the Conventional Commit subject `chore(repo-settings): sync managed files`, so a squash merge with `PR_TITLE` keeps it on default. A run that finds an open managed pull request with any other title or body, including the legacy `Sync managed files` title, restores the generated values. When the files already match, it keeps the existing commit. Manual title edits do not persist.

Managed files reach default only through the pull request. A trusted merger requests `/merge` after review. New executable files are unsupported because `createCommitOnBranch` cannot set their executable bit.

## Credentials

The `csm-ci` environment holds App credentials. The official `actions/create-github-app-token` action issues all tokens; application code receives tokens only.

Discovery uses metadata read access. The activation preflight and managed-file inspection use a repository-scoped token with contents and pull-requests read access. Settings, rulesets and immutable releases are read and changed with a token scoped to one target with only `administration: write`. The apply stage reruns the activation preflight before its first write. GitHub returns a ruleset's `bypass_actors` only to callers with write access to that ruleset, so a read-only token cannot tell whether the fixed bypass is present; a ruleset response without that field fails the run. Managed-file writes use a different token with contents and pull-requests write access. It adds workflows write access for workflow changes and for the rebuild of an existing branch, because the final ref move may carry the branch across workflow changes on the default branch. Approver capability tokens are used only for preflight and make no writes.

The approver App must be installed on every target where manual dispatch enables controlled merges, including the server. The operation does not install Apps, distribute secrets, or create repositories. See [setup](setup.md) for the caller workflow.
