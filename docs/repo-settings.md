# Repository settings

The server reconciles repository settings, four fixed rulesets, immutable releases, and managed-file pull requests. Configuration is global. Repository entries select targets and supply their operation and release settings. The planned standard caller generator also uses preparation and explicit adoption settings.

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
  additional_managed_files:
    .github/PULL_REQUEST_TEMPLATE.md: managed-files/pull-request-template.md
```

Omitted repository settings remain unchanged. The merge-method settings accept only the values shown above.

`has_wiki`, `has_projects`, and `allow_update_branch` are optional booleans. Each accepts `true` or `false`. The example disables Wiki and Projects and enables GitHub's suggestion to update pull request branches. `allow_update_branch` does not update branches or require branches to be up to date before merging. Existing merge, approval, required-check, and ruleset behavior remains unchanged.

The three feature fields use the repository REST API with the existing target-scoped administration token. Upgrade all server configuration parser pins to a compatible runtime before adding these fields to deployed configuration.

Inspection reports drift for each configured field and fails if a configured field is missing from the API response. Sync repairs differing values without changing omitted fields or unrelated repository settings. A second sync with no settings drift makes no settings write. Read and update API errors fail the run, including errors for unsupported settings.

When `allow_squash_merge` is explicitly `true`, reconciliation also enforces `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY`. These fixed values use the pull request title and description for both single-commit and multi-commit squash merges. Do not add these fields to `csm-ci.yaml`; they are implied by `allow_squash_merge: true`. Inspection reports drift in each field and fails if either field is missing. Sync repairs either field even when squash merging is already enabled. A repeat with no further settings drift makes no settings write. If `allow_squash_merge` or the entire `settings` block is omitted, both fields remain unchanged, even when the repository already allows squash merges. The fixed rulesets still apply.

`additional_managed_files` maps literal destinations to committed Server source files. See [Additional managed files](#additional-managed-files) for exact-commit loading, limits and migration. Removing a destination stops managing it and never deletes it. A pending managed branch that changed a removed path fails its existing history check when reuse is needed. Verify ownership before closing its pull request and deleting the owned branch; the next run starts from default. An empty desired set or matching default content needs no branch reuse and does not establish ownership of an existing branch.

Configuration comes from the triggering server commit, `GITHUB_SHA`. Discovery intersects the repositories of the Server App installation on the server's owner with `owners` and the first matching `repositories` entry. Repositories under another owner are not discovered. The actions repository is eligible when installed and configured, including when explicitly selected. It remains subject to its fixed all-paths-sensitive policy. An explicit repository selector limits the run to that repository. When the selected set includes the server, its job runs after the client jobs finish, even when one of them failed, so one broken repository cannot stall the server's own repair. Within a repository, settings, rulesets and immutable releases are applied before managed files, so a rejected `csm-ci/repo-settings` branch does not block them.

## Standard client workflows, planned

This is the planned contract for [issue #77](https://github.com/civitaspo/csm-ci-actions/issues/77). A separate runtime implementation and deployment are required. Do not add its new fields to configurations using older strict parser pins. It depends on the [explicit Secret contract](first-release-plan.md#explicit-secret-contract-and-staged-migration), not the separate additional-files implementation.

### Caller selection

Generation runs in both `reconcile` and `managed-files-only` whenever `repo_settings` is configured. Use the first matching `repositories` entry and the target's observed default branch. All destinations are under `.github/workflows/`. All reusable workflows are under `civitaspo/csm-ci-actions/.github/workflows/` and use the same resolved full commit SHA.

| Selection | Destination | Reusable workflow | Events | Job inputs and permissions |
|---|---|---|---|---|
| `approve` | `csm-ci-approve.yml` | `client-approve.yml` | `pull_request_target`: opened, synchronize, reopened, ready_for_review; `issue_comment`: created | No inputs or job condition; empty permissions |
| `policy-check` | `csm-ci-policy-check.yml` | `client-policy-check.yml` | `pull_request_target`: opened, synchronize, reopened, ready_for_review, edited | No inputs or job condition; empty permissions |
| `merge` | `csm-ci-merge.yml` | `client-merge.yml` | `issue_comment`: created | No inputs or job condition; empty permissions |
| `release` | `csm-ci-release.yml` | `client-release-publish.yml` | `pull_request`: closed | No inputs or job condition; empty permissions |
| `securefix` and canonical `release-pr` route | `csm-ci-release-pr.yml` | `client-release-prepare.yml` | Push to the actual default branch; manual dispatch | `version`, `update-root-version`; `contents: read` |

Workflow names are `csm-ci-approve`, `csm-ci-policy-check`, `csm-ci-merge`, `csm-ci-release`, and `csm-ci-release-pr`. Job names are `approve`, `policy-check`, `merge`, `release`, and `release-pr`. Every caller sets top-level `permissions: {}` and maps only `CSM_CI_CLIENT_APP_PRIVATE_KEY` to `${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}` under the same name. No generated caller uses inheritance. Existing Naming-list variables remain unchanged. Do not add request-cancelling concurrency or duplicate the reusable workflows' client prefilters.

A canonical preparation route has name `release-pr`, `from: default`, `to: release/next`, and workflow `.github/workflows/csm-ci-release-pr.yml`. No route means no generated preparation caller. A named route with conflicting values fails configuration validation for a repository selecting `securefix`. Keep `.release-version: semver`, `CHANGELOG.md: any`, and the configured supported root version edits under securefix's existing authorization. Generation never broadens the route's path permissions.

Preparation and publication remain independent:

| Effective configuration | Generated release callers |
|---|---|
| `release`, without authorized preparation | Publish only |
| `securefix` with canonical route, without `release` | Prepare only |
| Both selections | Prepare and publish |
| Neither selection | Neither |

The optional strict repository object `release_prepare` has one optional boolean, `update_root_version`, defaulting to `true`. Omission of the object has the same default. Unknown keys, non-booleans, or an explicit object without selected preparation fail validation. It is independent of `release` build settings, so a prepare-only repository needs no publication configuration.

```yaml
repositories:
  - name: owner/prepare-only
    ops: [securefix]
    release_prepare:
      update_root_version: false
```

The prepare caller declares an optional string dispatch input `version`, default `""`, described as an optional semantic version without a `v` prefix. It passes `${{ inputs.version || '' }}` and the effective boolean to `version` and `update-root-version`. Version inference and generation remain in the reusable workflow. Do not persist a fixed version in Server configuration.

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

Validate every reusable workflow required by the union of selected repositories at that commit before workflow-file writes. Parse their `workflow_call` contracts, not just file existence. Require the selected input names and types, compatible defaults and required inputs, the exact required Client App Secret declaration without additional required credentials, compatible workflow permissions, and the defining action-lock support required by their local composite calls. The prepare contract must accept the string `version` and boolean `update-root-version`. An incompatible release fails the run. There is no fallback to main, a tag pin, an older release, or the currently installed caller SHA.

Pass the validated version and full SHA through trusted discovery outputs to every target and both managed inspection and apply. Those stages consume the same result without independently resolving latest. Revalidate mutable target state before writes while retaining that resolved revision. A release published midway through a run affects only the next run. Include the version and full SHA in every proposed managed PR body and a deterministic generated comment in each caller. That comment makes first takeover visible but proves no ownership.

Compose one desired set from selected callers, configured additional files, and generated funding content. Apply the existing combined path, parent/child, count, and byte limits before file writes. Reject any duplicate producer destination, even with identical bytes. Selected caller destinations and proven pending deletion destinations cannot be supplied by additional files. Inactive unowned standard names remain available to operator-controlled files. Keep sponsorship's existing conditional funding reservation. Administrative results and file-stage errors remain separate.

### Authenticate ownership and preserve custom files

Generated ownership is recorded in the original managed commit's body under `csm-ci-generated-workflows-v1`. The strict versioned record contains the immutable target repository ID, the resolved release version and full SHA, and a sorted map of generated standard destinations to lowercase SHA256 digests of their exact UTF-8 bytes. It contains only generated callers, not additional or funding files. The Server writes it through `createCommitOnBranch` with the workflow content. An empty generated map records removal of the last caller. A matching repeat must retain the existing commit and PR head.

Recover prior ownership from the newest applicable merged managed PR, with complete API pagination. Require the configured Server bot's immutable creator ID, same target repository, head ref `csm-ci/repo-settings`, and a merge commit reachable from the observed default head. Order candidates by their merge commits' actual default ancestry. Do not order by PR number, update time, or mutable branch refs. Ambiguous ancestry, incomplete pages, and API errors fail with an actionable error.

Read that PR's original head SHA and immutable commit object. Require the existing Server commit proof: configured Server bot author ID, `web-flow` committer, REST verified signature, and valid GitHub signature through GraphQL. Require the strict reserved record and verify its repository ID, paths, digest formats, and byte-for-byte tree bindings at that original head. Never authenticate a record from a target file, PR body, title, current branch tip, or default/squash commit message. Those messages can contain user-edited PR text. Existing securefix rejection of `csm-ci-` in client-supplied commit messages prevents securefix from minting this original-head record. Keep that boundary; no release or merge behavior change is needed to carry ownership metadata.

The newest applicable candidate is authoritative. Missing or malformed records, unavailable original head objects, invalid signatures, or missing tree evidence must not cause fallback to an older valid record. Report the failed proof and preserve target files. Before first generator adoption, a candidate without a record establishes no ownership. It requires the explicit adoption procedure below rather than an older-record search. Deleted branch refs do not substitute for missing immutable head evidence. A force-moved ref never changes the recorded head SHA used for proof.

For an active caller already recorded as generated, replacement requires current default bytes to match its authenticated prior digest. For a disabled caller, deletion requires the same match. A missing disabled file needs no deletion. A missing active file is repaired through the reviewed PR. A changed regular file, symlink, submodule, or conflicting tree fails without overwriting custom content. Identical filenames, reusable references, or generated headers cannot bypass these checks. Re-adding an operation after a verified deletion creates an absent caller normally. A rollback or manual restoration of old bytes still needs current ownership proof or explicit adoption.

Only a prior merged record authorizes default-branch deletion. A pending PR record cannot grant itself deletion authority. Keep full S4 commit-chain, signature, changed-path, and expected-head validation for any pending managed branch before reuse. Historical ownership authentication does not apply today's additional-file allowlist to old merged PR history. This avoids making a removed additional file block legitimate caller removal. It also does not relax current pending-branch history validation.

Represent desired writes, proven deletions, and unmanaged paths separately. Retain proven deletion paths through pending-history validation and expected-head writes, including an entirely empty desired content map. Never add all five standard paths permanently to the history allowlist. Reject collisions with a pending deletion. Revalidate ownership evidence, default head, current bytes, pending branch, and PR binding immediately before privileged writes. Preserve leases, signed commits, least-privilege workflow tokens, server-last ordering, and the normal review and protected merge path.

### Adopt existing callers

An absent selected destination needs no adoption entry. An existing destination without authenticated generated ownership requires explicit reviewed Server authorization:

```yaml
repositories:
  - name: owner/client
    ops: [approve, merge, policy-check]
    workflow_adoption:
      .github/workflows/csm-ci-approve.yml: <64-lowercase-hex-sha256>
      .github/workflows/csm-ci-policy-check.yml: <64-lowercase-hex-sha256>
      .github/workflows/csm-ci-merge.yml: <64-lowercase-hex-sha256>
```

`workflow_adoption` is an optional strict map with at most five entries. Keys must be exact standard destinations selected for that repository. Values are lowercase 64-character hexadecimal SHA256 digests of the observed current bytes. Reject other paths, unselected callers, malformed values, absent files, and stale digests. Existing authenticated ownership takes precedence, so an adoption entry cannot bypass a later custom-content mismatch. Missing or invalid newer ownership evidence also cannot be bypassed by adoption. A legacy candidate without a record permits first adoption only when complete applicable history contains no earlier generated record for that path. A valid newest record omitting a path permits adoption after a prior verified removal. An entry permits first replacement only. It never permits deletion, changes to other files, or a reset of an unverified branch.

Inventory existing caller bytes, default heads, explicit release inputs, parser pins, and outstanding managed branches before rollout. Drain old configuration-writing runs. Upgrade all Server parser pins to a compatible verified runtime before adding new strict fields. Verify workflow merges are supported by the deployed merger; any bootstrap recovery follows its separate authorization.

In one reviewed Server configuration PR, remove literal or additional entries that collide with selected callers and add adoption digests for those exact deployed bytes. Preserve `update_root_version: false` where required. Do not change pins during a separate #78 format migration. Both inline and source-file distribution can precede this generator, but the final runtime retains only its deployed additional-file schema.

The generated PR replaces only the explicitly authorized bytes, includes its new ownership record and deterministic generated header, and follows normal review, CI, approval, and protected merge. Confirm the default content and merged original-head proof before removing adoption entries in a reviewed Server PR. A stale unused entry fails when no prior ownership exists and its target changed. It never grants permission to overwrite later custom changes.

An outstanding branch whose full signed history still changes an unmanaged literal path is rejected. Verify the exact owned PR, branch, and stopped writers before closing that PR and deleting only its owned branch under the existing recovery procedure. Then regenerate from current default. Do not reset an unverified branch, allow every reserved path, delete arbitrary custom callers, or require unrelated managed PRs to merge. Recovery must not destroy the historical merged PR head objects needed for ownership.

### Verify the implementation and release gate

Implement table-driven cases for every selection combination, prepare-only and publish-only boundaries, route conflicts, true/false/default root-version inputs, non-main defaults, and release-commit suppression. Cover missing, malformed, incompatible, and annotated releases, tag cycles and depth bounds, read failures, one resolution across all targets and both stages, and a newer release appearing midway through a run.

Cover producer collisions, exact-digest adoption and stale adoption, copied records and headers, wrong immutable IDs and signatures, unavailable original heads, pagination failures, ancestry ambiguity, newer invalid records without fallback, customized active and disabled files, rollback and re-add, last-caller deletion, pending-record self-authorization, old mixed merged PRs, rejected pending histories, recovery, and an unchanged second sync. Assert rejection messages and mutation-check every changed rule. Update fixtures, generated bundles, repo-settings, release, setup, and cutover instructions together.

Run all required local gates and independent specification review. Run affected repo-settings and release-pr feature suites, affected client suites, and smoke at the signed pushed implementation SHA. After an authorized merge, run affected CI suites and smoke through the runner checkout on `main`. Record exact runtime and Server configuration SHAs, generated PRs, immutable head evidence, run URLs, skips, and restoration in `docs/handoff.md`.

The latest stable release observed on 2026-10-26 is `v0.1.0`, whose prepare interface lacks the required root-version input and explicit Secret contracts. An intended compatible stable release is a deployment gate. Review its exact release PR and candidate under the normal checks and obtain publication authorization. Do not publish a throwaway release or choose an arbitrary version for this generator. The release need not contain the generator if the deployed runtime does, but its client interfaces must support every emitted caller and preserve deployed client behavior. Full-SHA tests cannot satisfy the published-stable acceptance case. Report that gap until an authorized intended release exists. This specification itself authorizes no publication, credential, App permission, or production configuration change and requires no live e2e.

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

Perform this procedure only after the runtime has passed the required local checks, independent review, repo-settings live tests, and smoke. Follow [cutover](cutover.md) for production PRs, protections, snapshots, and rollout. This specification does not authorize credential or App permission changes.

1. Inventory the inline destinations, exact bytes and caller pins, existing managed branches and open PRs, and current parser workflow revisions. Confirm ownership before any later branch recovery. Drain old configuration-writing runs and recheck queued runs so an older writer cannot race migration.
2. In a reviewed Server PR, add ordinary source files with those exact inline bytes and omit `managed_files` while retaining repository settings. Keep source copies outside runnable Server workflows. This temporarily pauses additional-file management without changing target files, existing managed branches, or their PRs. An empty desired set makes no file write and does not inspect existing branch ownership. Unrelated managed PRs do not need merging.
3. Upgrade every Server parser pin through the normal protected PR process. Include configuration checks, label/intake, approve, policy-check, merge and its current-config reload, securefix, and release paths. Verify their deployed revisions accept the new schema. Before changing workflows, verify the deployed merger supports workflow-file merges. Any required bootstrap recovery needs the separate authorization described in [merge](merge.md).
4. Add `additional_managed_files` in a reviewed Server PR with the same destination set and bytes. Keep existing literal caller pins unchanged during this format migration. Normal history proof and expected-head checks resume when a branch needs reuse. If state changed or proof fails, inspect it and use the existing owned-branch recovery instead of overwriting it.
5. Verify the live result one repository at a time. Record the runtime and configuration SHAs, run URLs, proposed PRs or no-op results, and unchanged target content. Keep compatible parser pins for rollback, or restore a mutually accepted configuration before reverting them.

The final runtime rejects the removed `repo_settings.managed_files` key, including an empty map or both keys together. Its error directs the operator to commit the inline contents as Server files and replace the key with `repo_settings.additional_managed_files`. The migration does not retain two runtime formats.

Implementation must update fixtures and harness configuration rewrites, generated bundles, setup examples, and cutover's empty-map instructions together. Table-driven and mutation tests cover changed rejection rules, exact-commit resolution, preserved bytes, source-only updates, identical retries, removal, and safe existing-PR reuse. Record live evidence and any existing verification gaps in `docs/handoff.md`; this specification has no live execution evidence of its own.

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

In `reconcile`, the existing target-scoped administration token reads the repository node ID and `hasSponsorshipsEnabled` through GraphQL. The server reports drift and repairs it through `updateRepository`, using `repositoryId` and `hasSponsorshipsEnabled`. Missing or invalid fields and API errors fail the run. A repeat with no drift makes no sponsorship mutation. Existing final revalidation still applies. A lost mutation response requires a state read before another write. `managed-files-only` proposes the same funding content without reading or changing the setting or minting an administration token.

The inspection reports `changes.sponsorships`, and administration apply reports `sponsorshipsUpdated` separately from `settingsUpdated`. Managed-file inspection and apply retain their separate result and PR number. The setting result and funding-file PR result are separate. An enabled setting with a pending PR is not completed funding setup. The generated file reaches default only after normal review, CI, approval, and protected merging. An exact repeat reuses the PR and head; matching default-branch content needs no PR. GraphQL `fundingLinks` exposes resolved funding links, not a recipient-write API or proof that a pending PR has merged. See [GitHub's sponsor-button documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository) and [GraphQL repository reference](https://docs.github.com/en/graphql/reference/repos#updaterepositoryinput).

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

- The default branch contains a merge caller for newly created issue comments, with `secrets: inherit` and no job-level `if:`. The server also needs its label caller under the same rules. This describes the current runtime. The [approved explicit secret contract](first-release-plan.md#explicit-secret-contract-and-staged-migration) replaces inheritance with same-name mappings in a separate implementation. It preserves the caller triggers, unconditional jobs, and activation rejection messages.
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
