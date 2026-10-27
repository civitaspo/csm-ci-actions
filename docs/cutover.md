# Production cutover runbook

This runbook describes the production migration from `civitaspo/securefix-server` to `csm-ci-server` running csm-ci-actions. All ten selected repositories have completed their protected-merge and applicable release verification. [handoff.md](handoff.md#34-production-provider-verification) and the server's [production verification](https://github.com/civitaspo/csm-ci-server/blob/main/verification.md) record the executed steps. The additional Renovate caller rollout and legacy archival are tracked separately. This is Phase 7 of [first-release-plan.md](first-release-plan.md#phase-7-production-migration).

Names come from the plan's "Naming list". Replace `<owner>` with the account that owns the repositories and `<sha>` with the reviewed csm-ci-actions commit on `main` that you pin. The wizard registers the Apps under a personal account, so `<owner>` is that user.

## 0. Before you start

- Pick `<sha>`: a commit on csm-ci-actions `main` whose `status-check` passed and whose post-merge e2e for every feature passed. [handoff.md](handoff.md) lists the runs.
- List the repositories that securefix-server manages today. Migrate them one at a time in step 6. Keep securefix-server running until the last one has moved.
- Read [setup.md](setup.md). This runbook follows it and adds the order, checks and rollback for a live migration.
- Each repository has no merge path from step 6.3 until step 6.7 finishes. Keep that window short and announce it.
- `merge.required_checks` is global. `review-and-checks` requires every listed check on every configured repository, the server included, and `/merge` waits for each of them. List only checks that every repository produces, by name and App ID, or the first reconcile locks merging there. If clients gate on a CI check such as `status-check`, `csm-ci-server` needs a job with that name too (step 4).
- csm-ci never disables immutable releases and does not restore merge settings it changed. If the old release or merge flow depends on them, plan for that before reconciling.

## 1. Create the server repository

1. Create `<owner>/csm-ci-server`. Give write access only to the people who operate it.
2. The wizard in step 2 creates the environment `csm-ci` with deployments allowed only from `main`.

## 2. Register and install the production Apps

Run `scripts/setup-wizard.sh` from a csm-ci-actions checkout at `<sha>`. Give it every repository you will migrate: it stores the Client App key only in the repositories it is given, and you delete the `.pem` files afterwards. Installing the Server and Approver Apps early is harmless, because repo-settings touches only repositories that are both installed and configured.

| App | Install on |
|---|---|
| `csm-ci-server` | `csm-ci-server` and every repository you will migrate |
| `csm-ci-client` | `csm-ci-server` only |
| `csm-ci-approver` | every repository you will migrate, and `csm-ci-server` itself. Repo-settings refuses to activate `controlled-merges` where the approver cannot mint a contents-write token. The wizard installs it on clients only, so add the server installation by hand |

Use "Only select repositories" for every installation.

Credentials, by name:

- Environment `csm-ci` of `csm-ci-server`: `CSM_CI_SERVER_APP_CLIENT_ID` (variable), `CSM_CI_SERVER_APP_PRIVATE_KEY` (secret), `CSM_CI_APPROVER_APP_CLIENT_ID` (variable), `CSM_CI_APPROVER_APP_PRIVATE_KEY` (secret).
- Repository level of every client, and of `csm-ci-server` itself because its own pull requests use the client callers: `CSM_CI_CLIENT_APP_CLIENT_ID` (variable), `CSM_CI_CLIENT_APP_PRIVATE_KEY` (secret), `CSM_CI_SERVER_REPOSITORY` (variable, `<owner>/csm-ci-server`). Set them on `csm-ci-server` with `gh variable set` and `gh secret set` before deleting the `.pem` files.

If you later add a repository the wizard was not given, generate a new Client App private key, store it in that repository, and delete the `.pem`.

Delete the downloaded `.pem` files. Record the bot user IDs the wizard prints.

Check: `gh api repos/<owner>/csm-ci-server/environments/csm-ci/deployment-branch-policies --jq '.branch_policies[].name'` prints only `main`.

## 3. Write the server configuration

Add `csm-ci.yaml` to `csm-ci-server` as in [setup.md](setup.md#3-write-csm-ciyaml):

- `owners`, `server_repository`, `apps: { client_bot_id, server_app_id, server_bot_id }` and `approver: { id, login: "csm-ci-approver[bot]" }` from the wizard output.
- `repositories` lists only `{ name: <owner>/csm-ci-server, ops: [approve, merge, policy-check] }` at first. Step 6 adds client repositories one at a time. Keep an explicit list; do not use a wildcard (step 7).
- `merge.required_checks`: only checks that `csm-ci-server` and every client produce (step 0).
- Port trust entries by immutable user ID. The schema rejects the Server bot and the approver bot in trust lists. Do not port the old system's own bot into `trust.committers`.
- Securefix routes are global. release-pr needs the `securefix` op on the repository and the global `release-pr` route.
- Do not add `repo_settings` yet. Without it, repo-settings does nothing.

## 4. Bring up the server without rulesets

Add these to `csm-ci-server`'s default branch, each pinned to `<sha>`:

- `.github/workflows/csm-ci.yml` (the label caller, `server.yml` on `label: created`) and `.github/workflows/csm-ci-check.yml`: [setup.md section 4](setup.md#4-add-the-server-workflows).
- The client callers for approve, policy-check and merge: [setup.md section 5](setup.md#5-add-the-client-workflows). Upgrade caller pins and mappings together to the reviewed contract revision. Before it activates `controlled-merges`, repo-settings checks that the merge caller (and, on the server, the label caller) uses the explicit same-name secret mappings and has no job-level `if:`.
- A job for every `merge.required_checks` entry, for example a workflow whose job is named `status-check` and runs the same checks as `csm-ci-check`.

Checks:

1. `csm-ci-check` passes on the default branch.
2. Open a small pull request on `csm-ci-server`. The server treats every path as sensitive, so automatic approval declines it. The `csm-ci/policy` check appears and every `merge.required_checks` check reports. A trusted approver comments `/approve`; the approval appears; a trusted merger comments `/merge`; it merges.

From here on, every change to `csm-ci-server` goes through a pull request, `/approve` and `/merge`.

## 5. Enable repo-settings on the server

1. In one pull request, add the `repo_settings` block ([repo-settings.md](repo-settings.md)) with `additional_managed_files: {}`, and `.github/workflows/csm-ci-repo-settings.yml` from [setup.md section 6](setup.md#6-add-repository-settings-reconciliation). Its schedule may fire as soon as it merges, so merge it when you are ready to do step 5.2.
2. Dispatch `csm-ci-repo-settings` with `repository: <owner>/csm-ci-server` and `targets: all`. It creates `integrity`, `review-and-checks`, `controlled-merges` and `release-tags`, activates `controlled-merges` after its preflight, and enables immutable releases.
3. Check: `gh api repos/<owner>/csm-ci-server/rulesets --jq '.[] | [.name, .enforcement]'` shows the four rulesets active, and `gh api repos/<owner>/csm-ci-server/immutable-releases` shows `"enabled": true`. Repeat check 4.2 with another small pull request.

Production server activation and protected [PR #5](https://github.com/civitaspo/csm-ci-server/pull/5) verified the required App review and controlled merge. This path was not exercised in the isolated testing server.

Do not copy securefix-server's admin PAT into `csm-ci-server`. The Server App's `administration: write`, minted only in the repo-settings job, replaces it. Revoke the PAT in step 7.

## 6. Migrate one repository

Repeat for each repository. Do the least critical one first. The order matters: once a repository is configured and installed, a reconcile creates `review-and-checks`, which requires `csm-ci/policy`, and only the csm-ci callers produce that check. A reconcile also takes over any existing ruleset with one of the four csm-ci names, so rename those before configuring.

Ruleset edits below send the full body, because only the omission of `enforcement` has been verified to keep the current value. To change one field of a ruleset:

```bash
gh api repos/<owner>/<repo>/rulesets/<id> | jq '{name, target, enforcement, conditions, rules, bypass_actors} + {name: "<new name>"}' | gh api -X PUT repos/<owner>/<repo>/rulesets/<id> --input -
```

Use `{enforcement: "disabled"}` or `{enforcement: "active"}` in place of the name to disable or re-enable one.

1. **Stop the old system's reconciliation.** Make securefix-server stop reconciling this repository's settings, rulesets and managed files, including the caller workflows it distributes. Keep only its merge path until step 3. Confirm that its next scheduled run skips the repository.
2. **Freeze, back up and rename.**
   - Make sure no pull request has auto-merge enabled and no securefix or release run is in progress. Close any pull request the old system opened from `release/next` or a managed-file branch, and delete that branch; csm-ci refuses to reuse a branch with commits it did not make.
   - Make sure every `merge.required_checks` check runs in this repository.
   - Save the current state: `gh api --paginate 'repos/<owner>/<repo>/rulesets?includes_parents=false' --jq '.[].id'`, then `gh api repos/<owner>/<repo>/rulesets/<id> > ruleset-<id>.json` for each id, and `gh api repos/<owner>/<repo> > repository.json` for the merge settings. If `gh api repos/<owner>/<repo>/branches/<default>/protection` returns classic protection, record it; it must be recreated by hand.
   - Rename every saved ruleset named `integrity`, `review-and-checks`, `controlled-merges` or `release-tags` to `legacy-<name>` with the command above. It keeps protecting the branch under its new name.
3. **Switch callers.** In one pull request to the repository, remove every workflow that calls securefix-server or uses its variables, including CI jobs that request automatic fixes through its client action, and add the csm-ci callers from [setup.md section 5](setup.md#5-add-the-client-workflows), pinned to `<sha>`. Move automatic fixes to csm-ci [securefix](securefix.md); otherwise a required check that depends on them fails once the old credentials are gone. Merge it with the old system. This is the last change the old system merges. Until step 4 lands, the new callers' requests are rejected at intake because the repository is not configured; that is harmless. The repository has no merge path from here until step 7.
4. **Configure.** In a pull request to `csm-ci-server`, add the repository to `repositories` with its ops and release build type. Merge it with `/approve` and `/merge`.
5. **Check for collisions.** `gh api repos/<owner>/<repo>/rulesets --jq '.[].name'` lists no `integrity`, `review-and-checks`, `controlled-merges` or `release-tags` other than any a scheduled run created since step 4. Repo-settings fails on duplicate names.
6. **Reconcile.** Dispatch `csm-ci-repo-settings` with `repository: <owner>/<repo>` and `targets: all`. The run fails before any administrative write if the merge caller is missing, the approver cannot mint a token, auto-merge is queued, or a non-active `controlled-merges` has a bypass other than the Server App's `pull_request`. Fix the cause and dispatch again. Then `gh api repos/<owner>/<repo>/rulesets --jq '.[] | [.name, .enforcement]'` shows the four csm-ci rulesets active.
7. **Remove the old protection.** Delete the `legacy-*` rulesets and any other ruleset or classic protection that requires securefix-server's checks or grants its bypasses. Leave unrelated rulesets alone. This ends the no-merge window.
8. **Resume waiting pull requests.** Comment `/recheck` on each open pull request so it gets `csm-ci/policy` and an approval decision.
9. **Verify.** Use a real, intended change: the `csm-ci/policy` check appears, the approver approves trusted commits (or a trusted approver uses `/approve` for sensitive paths such as `.github/**`), and `/merge` merges. Then do a release round trip with a real version: release-pr, merge of `release/next`, tag, and an immutable release with attestation. The tag and release are permanent. This is the plan's production verification.
10. **Detach the old system.** Remove the repository from securefix-server's configuration. Keep the old Apps installed and their secrets in place until step 7, so a rollback does not need new keys.

### Rollback for one repository

- **Before step 7:** an administrator disables the `legacy-review-and-checks` and `legacy-controlled-merges` rulesets (or whichever old rulesets block merging), merges a revert of step 3 in the GitHub UI, and re-enables them. Rolling forward means finishing through step 7.
- **To stop controlled merges:** set the `controlled-merges` ruleset's enforcement to `disabled`. Scheduled runs keep it disabled. A manual dispatch for the repository, or one without `repository`, activates it again after its preflight.
- **Break glass, when csm-ci itself cannot merge:** stop repo-settings from touching the repository first, because a scheduled run re-activates `integrity`, `review-and-checks` and `release-tags`. Disable the workflow with `gh workflow disable csm-ci-repo-settings -R <owner>/csm-ci-server`, or uninstall the Server App from the repository. Then disable the rulesets that block you with the full-body command above. The same applies to `csm-ci-server` itself.
- **Back to securefix-server:** with csm-ci stopped as above, revert the step 3 pull request, remove the repository from `csm-ci.yaml`, and delete the four csm-ci rulesets. Rename any surviving `legacy-*` rulesets back. Recreate only saved rulesets that no longer exist, with `jq '{name, target, enforcement, conditions, rules, bypass_actors}' ruleset-<id>.json | gh api -X POST repos/<owner>/<repo>/rulesets --input -`, or let securefix-server's reconciliation recreate them. Re-add the repository to securefix-server's configuration. Immutable releases stay enabled; restore the merge settings from `repository.json` if the old flow needs them.

## 7. Retire securefix-server

After the last repository has moved and passed step 6.9:

1. Confirm nothing still calls the old system: `gh search code securefix-server --owner <owner> --extension yml` and `gh search code SECUREFIX_ --owner <owner>`. Code search indexes only default branches and may lag, so also read each migrated repository's `.github/workflows`.
2. Keep `repositories` an explicit list. A wildcard would enroll every repository the Server App is later installed on, and the next reconcile would require `csm-ci/policy` on a repository without callers. If you do use globs, keep the server's entry first, because the first match wins.
3. Revoke the old admin PAT and any PAT the old approver bot used, and remove that bot's write access from the repositories. Its approvals would otherwise still count while `controlled-merges` is disabled.
4. Uninstall the old Apps from every repository, delete their secrets and variables there, and delete the old Apps' private keys and the Apps.
5. Archive `civitaspo/securefix-server`. Do not delete it. Its history documents the previous trust rules.

## Known dependencies and unverified behavior

- Changing the content of an existing `csm-ci/repo-settings` branch resets it to the default branch with a Git lease before writing. Unit tests and local Git tests cover this. It was not exercised live in the testing repositories, because force-pushes there were not authorized. Watch the first managed-file update after a configuration change. The reset mints workflows write to fail safe; whether GitHub requires it is unknown.
- The scheduled trigger itself was not observed in testing. Testing dispatched the schedule branch of the reusable workflow directly. Check the first scheduled run of `csm-ci-repo-settings` after step 5.
- The isolated testing server did not exercise `controlled-merges` activation because its approver App is not installed there. Production activation and protected server PR #5 passed.
- Server reconciliation runs after failed client jobs, provided discovery succeeded and the client wave was not cancelled. Cancellation still stops the server step.


## Generated caller rollout gate

The standard caller generator runtime requires the [reviewed adoption procedure](repo-settings.md#adopt-existing-callers). Upgrade every Server parser pin before adding `release_prepare`. Remove selected caller destinations from `additional_managed_files` in the same reviewed configuration change that selects them. Configure `release_prepare.version_files` for repositories whose release version files differ from the default set. Review each generated PR that replaces or deletes a caller before merging it.

Discovery resolves and validates one published stable release for all targets and both managed-file stages. The current stable `v0.1.0` lacks the required interfaces, so deployment is blocked until an intended compatible release is separately authorized and published. Do not select an older release, use a mutable ref, or publish a temporary version. Full-SHA local tests do not establish this published-stable gate. Run repo-settings, release-pr, affected client suites, then smoke at the signed pushed candidate after that prerequisite. Preserve the normal protected review and merge process and the owned-branch recovery procedure for incompatible pending managed PRs.
