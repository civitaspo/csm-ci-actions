# Testing

This page describes the testing environment, how to run and write live e2e scenarios, and GitHub behavior that the implementation relies on. Each behavior below was observed in real runs; verify again the same way before changing an assumption.

## Testing environment

| Repository | Role |
|---|---|
| `civitaspo/csm-ci-actions` | This repository. Changes go through PRs; never push to `main`. |
| `civitaspo/testing-csm-ci-server` | Server for e2e. The harness syncs its fixtures to `main`. |
| `civitaspo/testing-csm-ci-client` | Client for e2e. The harness syncs its fixtures to `main`. |

| App | App ID | Bot user ID | Installed on | Repository permissions |
|---|---|---|---|---|
| `testing-csm-ci-client` | 5455035 | 347395374 | testing server | Issues: write |
| `testing-csm-ci-server` | 5455185 | 347400474 | testing server and client | Contents, Pull requests, Issues, Checks, Workflows, Administration, Attestations: write; Actions: read |
| `testing-csm-ci-approver` | 5455223 | 347401524 | testing client | Pull requests: write, Contents: write |
| `testing-csm-ci-untrusted-committer` | 5455256 | 347402450 | testing client | Contents: write, Pull requests: write |

- A bot's login is `<App name>[bot]`. The Apps are private, so `gh api /apps/<slug>` returns 404; get a bot user ID with `gh api /users/<slug>%5Bbot%5D --jq .id`.
- Credential names follow the [Naming list](design.md#naming-list). The testing server's `csm-ci` environment and the client's repository variables mirror production. This repository's `csm-ci-e2e` environment holds the untrusted-committer App credentials and `CSM_CI_OWNER_TOKEN`, the owner's fine-grained PAT for the two testing repositories (Contents, Issues, Pull requests, Administration, Actions and Workflows: read and write).
- Agents never create, register or change private keys, PATs or App permissions. Ask the owner.
- The testing server configuration is `e2e/fixtures/testing-csm-ci-server/csm-ci.yaml`. Update it with the schema in `src/lib/config.ts` in the same PR.

## Running e2e

For suite selection and PR verification, follow [AGENTS.md](../AGENTS.md#run-live-e2e-safely). Open the PR before running its selected suites with `/e2e`. Run post-merge verification against the merged SHA using the tree comparison described there.

```bash
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full-sha> --feature <feature>[,<feature>...] [--scenario <substring>]
gh workflow run e2e.yml --repo civitaspo/csm-ci-actions --ref main -f ref=<sha> -f feature=<feature>[,<feature>...]
```

`--scenario` is a case-sensitive substring that must match at least one scenario. The local runner skips scenarios that need the second identity (`needsUntrusted: true`); the CI workflow on `main` runs them. See the [README](../README.md#run-live-e2e-in-the-testing-repositories) for prerequisites.

The harness takes the lock, force-pushes this repository's `e2e` branch to `--ref` (testing callers use `@e2e`), syncs fixtures to the testing repositories, runs the concurrent scenarios of every selected feature together, starting them 2 seconds apart and at most 20 at a time, then runs serial scenarios one at a time, and releases the lock. It prints each scenario's duration and the total wall time, lock wait included. Serial scenarios change state that every request reads, such as the server configuration, repository policy and client rulesets, so nothing else runs beside them. Concurrent scenarios touch only their own pull requests and requests.

- **`/e2e` comment.** The repository owner (immutable ID in `e2e-comment.yml`) comments exactly `/e2e --feature <feature>[,<feature>...] [--scenario <substring>]` on an open pull request. The `issue_comment` workflow runs from `main`, validates the commenter, the command and the feature names, pins the PR's current head SHA, runs the same steps as `e2e.yml` in its own job (a reusable workflow cannot read the `csm-ci-e2e` environment's secrets), reacts to the command, posts a start comment with the run URL, the pinned SHA and the harness used, and posts pass or fail when the run ends. Unauthorized commenters are ignored silently. The `e2e/` harness checked out for the run is the PR head's when the head branch is in this repository and every PR commit is GitHub-verified and authored by the owner, so changed scenarios are tested. Otherwise it is `main`'s, and the reply says so; such a PR that changes `e2e/` needs a local run or a post-merge CI run. A Deployment on the pinned PR head tracks the run and links to its logs. Cancellation is reported as an error Deployment status. The workflow files always come from `main`. `--scenario` is the harness's case-sensitive scenario-name substring, so a failed scenario can be rerun alone, for example `/e2e --feature merge --scenario a head change while /merge waits`; the rest of the line is the substring, up to 200 characters. Push a new commit and comment again to retest. The workflow's feature list must match `FEATURES` in `e2e/pr-metadata.ts`; a unit test enforces this.
- The workflow run summary links to the pull request that started the test.
- **Cancellation.** To request a safe stop, the owner comments `/e2e --cancel` on the same PR or runs `GH_TOKEN=$(gh auth token) REPO=civitaspo/csm-ci-actions bun e2e/cancel.ts <pr-number>`. The request selects the sole active run with a trusted start comment. If multiple runs are active, use `/e2e --cancel <run-id>` to select one. The harness stops starting scenarios, waits for active scenarios and their cleanup, and reports the result. The request itself does not confirm that cancellation completed. For a local run, press Ctrl+C once and wait for cleanup. GitHub Actions' Cancel workflow and forced process termination can interrupt cleanup; use them only when graceful cancellation cannot finish. A killed runner may leave test state behind.
- **Workflow drain.** Before releasing the lock, the harness waits for workflow runs created in both testing repositories during the invocation, including unrelated runs, and then requires 60 seconds without newly observed runs. GitHub provides no event-delivery barrier, so a workflow indexed after this quiet window can still appear later. API errors, a timeout, an incomplete run listing, or a scenario failure retain the lock for manual investigation.
- **Lock.** The `e2e-lock` label in this repository serializes invocations. Its description is `<ISO time> <features>@<sha7>#<rand>:<runner>`, with features cut to 20 characters and runner identifying a GitHub run and attempt or local process. The harness retries every 15 seconds and refreshes its timestamp every 5 minutes. It does not remove a stale or malformed lock automatically. After an interrupted or failed run, verify ownership, confirm the harness and its dispatched workflows have stopped, and inspect cleanup diagnostics before restoring owned test state and removing the lock. Never remove a lock based on its age alone.
- **Burst limit.** When about 20 scenarios opened pull requests within two seconds, GitHub started no workflow run for the last of them, for example [client PR 1232](https://github.com/civitaspo/testing-csm-ci-client/pull/1232); pull requests opened a few seconds apart all ran. The harness starts concurrent scenarios 2 seconds apart and runs at most 20 at a time.
- **CI dispatch.** GitHub keeps only one pending run per concurrency group, so a newer dispatch replaces an older pending one. Dispatch the next invocation only after the previous one finishes.
- **Cleanup.** Scenarios open PRs with `withPr` and close them in `finally`. After an interrupted run, close owned leftover PRs on `e2e-*` branches:

  ```bash
  for n in $(gh pr list --repo civitaspo/testing-csm-ci-client --state open --json number,headRefName --jq '.[] | select(.headRefName|startswith("e2e-")) | .number'); do gh pr close $n --repo civitaspo/testing-csm-ci-client --delete-branch; done
  ```

  Never delete a ruleset by name alone or reset an unverified managed branch. Changed-content resets of an existing `csm-ci/repo-settings` branch are not live-tested.

## Writing scenarios

- **Correlate exactly.** Match a server run by the accepted request in its intake log (operation, repository, PR number, comment ID), or, for a label rejected before parsing, by the complete label value in the cleanup step's environment. Similar error text is never an identity. Paginate run lists and apply the scenario's time window.
- Client comment runs carry the PR number and comment ID in their run name. Each comment needs its own completed run.
- Smoke dispatches carry a fresh correlation ID in the run title.
- Human-created labels skip intake, so that job has no log and the log API returns 404. Correlate through cleanup instead.
- Never wait with a fixed sleep. Wait for the specific evidence with a deadline using the harness polling helpers; a successful workflow conclusion does not prove that the expected job ran.
- The server's receipt comment also triggers `issue_comment`. The client prefilter skips it because the bot's association is `NONE`.
- `labelFor` (the `csm-ci-smoke.yml` dispatch) creates any request with the Client App key, which simulates an attacker holding that key.
- Make trusted commits with GraphQL `createCommitOnBranch` (`openPr(ctx, "signed")`).

## GitHub behavior relied on

- **Reusable workflow context.** Inside a reusable workflow, `job.workflow_repository` and `job.workflow_sha` name the called workflow's repository and commit; `github.workflow_sha` is the caller's ([run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40099821184)).
- **Named secrets.** A reusable workflow can receive environment secrets through an explicit named mapping. A missing required mapping fails at startup with zero jobs and `Secret <NAME> is required, but not provided while calling.` ([positive](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40303489939), [missing](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40303734933)).
- **App tokens.** `actions/create-github-app-token` takes `client-id` (`app-id` is deprecated). Requesting a permission the App lacks fails token issuance. With only `owner`, the token covers every installed repository. The post step revokes the token.
- **App approvals.** Whether an App's approval counts toward required approvals depends on the App's installed `contents: write`, not the token's permissions ([does not count](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40104472870), [counts](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40104932016)).
- **`GET /user`** cannot be called with an installation token. Verify the approver by the review's `user.id`.
- **Commit signing.** The REST contents API with a user token makes unsigned commits. `createCommitOnBranch` makes a `web-flow` commit signed by GitHub with `committedViaWeb: true`, authored by the token owner; it cannot set the author or the executable bit.
- **Edited comments.** An `issue_comment` payload can already contain the edited body when the edit follows within a second, so the client prefilter is not a security boundary. REST `updated_at` can equal `created_at` for a same-second edit while GraphQL `lastEditedAt` is set ([run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40116623333)); the server checks both.
- **Rulesets.** `GET` omits `bypass_actors` for a token without write access to the ruleset ([run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40155267064)), so inspection uses the administration token. GitHub stores `update` with `update_allows_fetch_and_merge: false` as `{"type":"update"}`. A PUT without `enforcement` keeps the current value.
- **Other API behavior.** Creating a label with an existing name returns 422 (the e2e lock uses this as test-and-set). `PATCH` of a missing ref returns 422 "Reference does not exist". Dispatching a just-created workflow returns 422 for a while. Octokit IDs are `number | bigint`; normalize with `Number()`.

## Tooling notes

- `bun build --target=node --format=esm` is deterministic, which the clean-dist check relies on.
- Suppress a jactionlint rule with `# jactionlint ignore=<rule>` on the line above, with the reason in a comment above that. Accepted suppressions are `concurrency-limits` (requests must not cancel each other), `dangerous-triggers` (callers never check out PR code), `github-app` where a token deliberately covers every installation (discovery and probes), and `unpinned-uses` for `@e2e` in fixtures only. Fixtures are outside the root `.github/workflows`, so lint them from the fixture directory with `jactionlint --online .github/workflows/*.yml`.
- `e2e/fixtures/**` is in Renovate's `ignorePaths`, so `@e2e` stays unpinned.
- Use YAML block scalars for shell code containing `: `.
- `sed -i` here is GNU sed; `sed -i ''` treats `''` as a file.
- Mutation scripts must bound each test run and restore from a copy taken before the first mutant.
