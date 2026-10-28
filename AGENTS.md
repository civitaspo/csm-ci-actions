# AGENTS.md

Follow this workflow for changes to csm-ci-actions and its live testing environment.

## Start with the current state

1. Inspect the working tree, branch, remote `main`, and related pull requests. Preserve unrelated work and start each new PR from the intended base.
2. Read [docs/design.md](docs/design.md), including the security design and Naming list, and the affected operation's page in `docs/`. Together they define supported behavior. Change them in a separate PR before adding behavior outside them.
3. Read [docs/testing.md](docs/testing.md) for the testing environment, e2e rules, and verified GitHub behavior. Check assumptions against the current code and live GitHub state. The design and operation pages win if documents disagree.
4. Trace the affected operation's callers, implementation, tests, fixtures, and generated files. For setup or production administration, also read [docs/setup.md](docs/setup.md) and [docs/repo-settings.md](docs/repo-settings.md).

## Develop one complete change

- Write code and tooling in TypeScript run by bun. Do not add Python or shell scripts; keep a few lines of shell only where a workflow step needs them.
- Choose the smallest change that satisfies the specification. Reuse existing helpers and remove superseded callers in the same change. Add abstractions or dependencies only for a concrete need.
- Define the data shape and trust boundary before writing logic. Keep decisions in pure functions and collect GitHub facts through the shared API helpers.
- Treat client events, labels, comments, artifacts, and checked-out client files as untrusted. Keep authorization and privileged writes on the server. Preserve final revalidation before writes.
- Follow the complete request path when changing an operation: client action or shared workflow, intake, server job, operation, receipt, and cleanup. Keep the operation page and fixtures in sync.
- Cover each new or changed rejection rule with a table-driven test that checks the rejection message. Test observable behavior, including rejected inputs and replay, rather than internal call structure.
- Mutation-check each changed rule individually. Use isolated copies, bound each mutant's runtime, and restore the original files after every attempt. A surviving mutant requires a stronger test.
- Verify assumptions about GitHub in the testing repositories. Record exact run URLs and distinguish observed behavior from assumptions or untested cases.
- Remove superseded configuration keys, inputs, and values outright: no aliases and no dedicated removal messages. The strict parser's ordinary unknown-key or invalid-value error is enough.
- Code that rewrites a pull request's head branch must never leave that branch equal to its base, even briefly: GitHub then closes or auto-merges the open PR asynchronously. Rebuild through `src/lib/branch-rebuild.ts`.
- Generated client files must already be stable under client tooling. Emit the pin comment that pinact-style autofix adds (`@<sha> # <version>`) and the jactionlint annotations that self-linting repositories need, so neither tool rewrites or rejects them.
- Server operations on one pull request share a concurrency group only with the same kind, except that `/approve`, `/recheck`, and policy-check share one group because they publish policy results. A new operation that waits must not hold that group.
- Continue authorized, reversible work without repeated permission requests. Report concrete blockers and the specific action needed from the user. Keep progress updates focused on findings and remaining work.

## Verify before opening a pull request

Use the tool versions in `mise.toml` and run all required local checks:

```sh
mise install
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
bun run build
test -z "$(git status --porcelain dist/)"
mise exec -- jactionlint
mise run actions-lock-verify
```

- If the build changes `dist/`, review and commit the generated files with their source. Rebuild and confirm the clean-dist check against that commit.
- When changing a shared client workflow or its composite dependencies, run `mise run actions-lock`. Review and commit the generated `.github/workflows/actions.lock`. Keep the task's configured workflow list and preserve the server checkout pattern.
- For executable changes, run the affected live feature suites and then smoke at the signed, pushed full head SHA. Documentation-only changes do not need live e2e.
- Before opening the PR, obtain an independent review of the diff against the relevant specification. Give the reviewer the diff and specification without your conclusions. Resolve findings and repeat affected checks after fixes.

## Run live e2e safely

Read [README.md](README.md#run-live-e2e-in-the-testing-repositories) for prerequisites and [docs/testing.md](docs/testing.md#running-e2e) for cleanup and correlation rules.

```sh
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full-head-sha> --feature <feature>
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full-head-sha> --feature smoke
```

- The harness writes to `testing-csm-ci-client`, `testing-csm-ci-server`, and this repository's `e2e` ref. Production repositories are not test fixtures.
- Run one harness invocation at a time. An invocation may list several features, such as `--feature approve,merge,policy-check`; their concurrent scenarios overlap and serial scenarios run alone. Wait for completion before dispatching another CI suite, because a newer pending run can replace an older one.
- Use `--scenario <substring>` while iterating, then run the full affected feature. The `release-prepare` client action belongs to the `release-pr` suite.
- Another session or a multi-feature run can hold `e2e-lock` for a long time. Read the lock's description before waiting, and tell the user what you are waiting on.
- Under GitHub's account-wide job limit, runs can stay queued for more than ten minutes, and a job's API status can lag its finished steps. Check the queue and step conclusions before blaming the code or retrying.
- For mutation checks in copied trees, exclude `mise.toml` (an untrusted copy makes `mise` refuse to run) and call the real binary from `mise which bun`. Confirm the unmutated baseline passes. Install dependencies in every worktree instead of symlinking `node_modules`, because bundles embed the dependency path.
- Local runs skip scenarios requiring the second identity. Record those skips. Run the affected suites and smoke through `e2e.yml` on `main` against the merged SHA after an authorized merge. Keep the runner checkout on `main` so candidate code cannot receive the privileged e2e environment.
- Before removing a stale `e2e-lock`, confirm ownership and that the harness and its dispatched workflows have stopped. Inspect cleanup diagnostics, restore only owned test state, and close owned leftover `e2e-*` PRs and branches. Never delete a ruleset by name alone or reset an unverified managed branch.

## Troubleshoot from the request to the result

1. Establish identity first. Record the repository, full head SHA, PR number, comment ID or request label, and run URLs. Confirm which caller and reusable workflow commits actually executed. A green run for another SHA is not evidence for the candidate.
2. Inspect the client trigger and job conditions. Distinguish a skipped prefilter from a failed request. Check the actual event, comment body, author identity, and Bot ownership rules before changing filters.
3. Inspect intake and correlate the exact accepted request. Match operation, repository, and numeric arguments. For rejection before parsing, use the full cleanup label. Paginate runs and apply the scenario's time window. Similar error text does not identify a request.
4. Inspect the operation's first failing step, then receipt and cleanup. For approval or merge failures, check the current head, trusted immutable IDs, unedited command evidence, approval, policy, and required checks. Read the governing operation page before changing trust rules.
5. Check token scope and workflow context. Confirm the expected App installation, requested token permissions, `secrets: inherit`, environment name, and deployment branch restrictions. Inspect secret names and metadata only. Private Apps can return 404 from the public App endpoint.
6. Check GitHub's current state before repeating a write whose response was lost. Follow [docs/github-api.md](docs/github-api.md): use bounded shared retries for reads, propagate cancellation and API errors, and recover writes through operation-specific state checks. Treat 404 or 422 as missing only when that endpoint and operation define that meaning.
7. If a completed run has an empty jobs list or missing evidence, wait for the specific evidence with a deadline. Use the harness polling helpers. A fixed sleep or successful workflow conclusion cannot prove that the expected job ran.

For workflow failures, also check these repository-specific constraints:

- Shared client workflows use the generated action lock. Server jobs check out `job.workflow_repository` at `job.workflow_sha` to load actions from the called workflow's revision.
- Resolve bundled helper files relative to the action module, not the runner's working directory. Node actions cannot rely on `GITHUB_ACTION_PATH`.
- Use YAML block scalars for shell code containing `: `. Run jactionlint and the build before diagnosing a GitHub platform issue.
- When two fixes fail at the same point, test the shared assumption before trying a third fix. Preserve the original failure evidence and fix the first incorrect state.

## Verify production results

- Read [docs/repo-settings.md](docs/repo-settings.md#rulesets-and-emergency-stop) before production configuration, ruleset, or caller changes. Snapshot affected settings and identify managed resources by ID and full configuration. Preserve unrelated protection and settings.
- Roll out to one repository at a time. Finish its original CI jobs, approval, policy, protected merge, and applicable release checks before starting the next repository.
- Before moving csm-ci-server pins, diff every called reusable workflow's `on.workflow_call` between the old and new SHA. Change the callers in the same PR. A required secret that exists only in the `csm-ci` environment needs an explicit mapping; `secrets: inherit` cannot satisfy it, and the label workflow then fails for every request.
- Reconcile many repositories as one repo-settings run without a repository selector. Its matrix runs serially. Parallel per-repository dispatches exhausted the Server App's hourly API limit.
- If the label workflow is down, the protected merge path is down too. Follow [Break glass](docs/repo-settings.md#break-glass).
- Treat client CI and server publication as separate gates. For releases, follow [docs/release.md](docs/release.md) and [docs/release-attestation.md](docs/release-attestation.md). Verify the actual asset set, digests, checksums, attestations, and supported installation path. For Terraform providers, also verify the public GPG signature, Registry discovery, and provider loading.
- Use intended versions for production releases. Immutable tags and assets are permanent. A docs change alone does not establish runtime or release compatibility.
- Declare completion only after checking the live result. Report remaining failures, skipped scenarios, and unverified behavior explicitly. Link detailed evidence instead of adding a development narrative to this file.
- Bound every wait on GitHub to about five minutes. Before a longer wait, say what it waits on and roughly how long; past the bound, inspect the cause.

## Keep language and reviews consistent

- Everything committed here is English: code, comments, docs, commit messages, PR titles, and PR bodies. CI rejects CJK characters in tracked files. Translate before the first commit.
- Write direct instructions and concise explanations. Use the repository's names consistently. Put behavior and operator procedures in the operation pages, verified GitHub behavior in `docs/testing.md`, and verification evidence in the PR body.
- Never push directly to `main`. Use a branch, open a PR, and squash-merge. Sign commits and include the tool's `Co-Authored-By` trailer.
- Use Conventional Commit PR titles, such as `fix(merge): ...`. PR bodies use Why, What changed, Scope, Tradeoffs, Blast Radius, and Verification. Drop empty sections. Explain material choices and link verification evidence.
- Merge only when `status-check` is green and the user authorized merging that PR. A green PR without merge authorization is ready for review. After an authorized merge, verify the merged SHA and complete the affected post-merge CI e2e checks.

## Keep credentials with the operator

- Names of Apps, environments, variables, and secrets come only from the [Naming list](docs/design.md#naming-list).
- Keep strong runtime credentials in the server's `csm-ci` environment. Client repositories hold only the Client App key. Use the separate `csm-ci-e2e` environment for privileged test credentials.
- Agents never create, read, register, revoke, or change private keys, PATs, or GitHub App permissions. Ask the user to handle those operations. Metadata-only checks may confirm secret names and placement. Never print credential values in commands, logs, review evidence, or chat.
