# Handoff: implementing csm-ci-actions from Phase 2

This document is written so that you can continue the implementation from Phase 2 onward with this document alone.
[docs/first-release-plan.md](first-release-plan.md) is the source of truth for the specification. This document supplements it.
This document records four things.

- Decisions made during implementation
- GitHub behavior verified against real runs
- Details of the testing environment
- Working procedures

If first-release-plan.md and this document disagree, first-release-plan.md wins. Fix the disagreement in a PR.

- Written on: 2026-10-25 (JST)
- `main` at the time of writing: `7d51bc9` (Phase 1 done)
- The repository was recreated on 2026-10-25 with an English-only history, because Japanese had been committed (see AGENTS.md). Pull request numbers and csm-ci-actions run ids from before that no longer exist. Run ids in the testing repositories are still valid.

---

## 1. Current status

### 1.1 Completed phases

| Phase | Content | PR | Status |
|---|---|---|---|
| 0 | Foundation. src/lib, intake, request, server.yml, server-check, e2e harness, setup wizard, Renovate | 8970620, 55d8472, 9fd7edb, 7d51bc9 | In `main`. The CI e2e (smoke) was green |
| 1 spike | Whether an approval by the approver App counts as a required approval | eec9c01 (the plan records the result) | In `main` |
| 1 | approve. Auto approve, `/approve`, `/recheck` | 55d8472, 9fd7edb, 7d51bc9 | In `main`. CI and the local e2e (approve, smoke) were green |

### 1.2 Remaining phases and dependencies

Phases 2, 3, 4, 5a and 6 are independent of each other. You can work on them in parallel. Do 5b after 4 is done. Do 7 after all other phases.

Section 6.1 lists the shared places where parallel work can conflict.

### 1.3 Changes from the plan made in Phase 1 (already reflected in first-release-plan.md)

- **`/approve` takes no argument.** It approves only trusted commits. This has the same meaning as in the Rust version.
  - The original plan was to force-approve untrusted commits too, given a sha.
  - An attacker can brute-force a commit whose first 7 characters of the sha match (about 2^28 attempts). Requiring all 40 characters is too heavy in practice.
  - For a PR from an external contributor, the owner can approve it by hand in the GitHub UI.
  - The review body marker is `<!-- csm-ci:approve:command:<comment_id> -->`. The Phase 3 sensitive-paths policy treats this marker as the sign that "the approver accepted this".
- **The approver is a GitHub App.** A PAT and an approver bot user are no longer needed.
  - The approver App itself needs `contents: write`.
  - The token issued in the op job needs only `pull_requests: write` (section 3.4).
- **The S3 trust policies are always evaluated.** `signed-commits` and `trusted-committers` are evaluated even when `policies` in `csm-ci.yaml` does not list them (`ALWAYS` in `src/lib/approve.ts`).
- **"Update policy-check" happens in Phase 3.** Until Phase 3 adds the code that creates the check run `csm-ci/policy`, there is nothing to update.
- **`/recheck` is sent as an `approve` request (the second number is the comment id).** The server rereads the comment body and decides which command it is. Phase 3 adds the policy-check re-evaluation to this path.

### 1.4 Not yet verified

- Four e2e scenarios that use the untrusted-committer token (`needsUntrusted: true` in `e2e/approve.ts`). This token exists only in the csm-ci-actions environment `csm-ci-e2e`. So these scenarios run only in the CI e2e workflow, which you can run only from `main`.
  - In the CI e2e run from `main` of the old repository after Phase 1, 10 of 11 scenarios passed.
  - Of the four untrusted scenarios, these three passed.
    - A commit whose author the App faked as the owner through the REST API is unsigned and is not approved.
    - A signed commit from an untrusted App is not approved, even by `/approve`.
    - A label that points to a comment by someone who is not an approver gets neither 🚀 nor a receipt.
  - The remaining one, "a command from a non-collaborator creates no request", FAILED. The client run itself skipped as expected (`approve / request | skipped`). The harness failed because it read a job list that was still empty right after the run completed.
  - The harness fix (wait for the job list) is in `main`. Rerun the CI e2e and confirm that all four pass.
- The 60-minute deadline and "dismissal by a push during approval" are verified by unit tests only. The e2e cannot trigger them on purpose.

---

## 2. Repositories and environment

### 2.1 Repositories

| repo | Role | Notes |
|---|---|---|
| `civitaspo/csm-ci-actions` | The main repo. OSS, public | Squash merge only (already set by the user). Renovate is installed. Direct pushes to `main` are forbidden. Make every change through a PR |
| `civitaspo/testing-csm-ci-server` | Server repo for e2e | You may push directly to `main` (testing only). The harness syncs the fixtures |
| `civitaspo/testing-csm-ci-client` | Client repo for e2e | Same as above. See section 2.5 for the ruleset |
| `civitaspo/csm-ci-server` | Production server repo | Not created yet. Create it in Phase 7 |

The local clone is at `~/src/github.com/civitaspo/csm-ci-actions`.

### 2.2 GitHub Apps (testing)

| App | app_id | client_id | bot user id | Installed on (confirmed against the real token) | Repository permissions |
|---|---|---|---|---|---|
| `testing-csm-ci-client` | 5455035 | `Iv23liUXR149QVLpwKR8` | 347395374 | testing-csm-ci-server only | Issues: write |
| `testing-csm-ci-server` | 5455185 | `Iv23liiUPFJbx8Zduugd` | 347400474 | testing-csm-ci-server, testing-csm-ci-client | Contents, Pull requests, Issues, Checks, Workflows, Administration and Attestations are write. Actions is read |
| `testing-csm-ci-approver` | 5455223 | `Iv23liqkgftx8ti8s2dG` | 347401524 | testing-csm-ci-client only | Pull requests: write, **Contents: write** (section 3.4) |
| `testing-csm-ci-untrusted-committer` | 5455256 | `Iv23liLV53PdJxYE783g` | 347402450 | testing-csm-ci-client only | Contents: write, Pull requests: write |

- The login of a bot user is `<App name>[bot]`. Example: `testing-csm-ci-server[bot]`.
- The Apps are private, so `gh api /apps/<slug>` returns 404. Get the bot user id with `gh api /users/<slug>%5Bbot%5D --jq .id`.
- The owner `civitaspo` has user id 4525500 (`type: User`).
- You create the production Apps (`csm-ci-client`, `csm-ci-server`, `csm-ci-approver`) in Phase 7. Give them the same permissions as the testing Apps. Keep App names at 34 characters or fewer (the GitHub limit).

### 2.3 Environments, variables and secrets

Follow the naming rules in the plan's "Naming list".

- Store each App credential as a pair: `CSM_CI_<ROLE>_APP_CLIENT_ID` (variable) and `CSM_CI_<ROLE>_APP_PRIVATE_KEY` (secret).
- `<ROLE>` is the App name with `testing-csm-ci-` or `csm-ci-` removed, in upper snake case.
- Do not use the `app-id` input. It is deprecated in `actions/create-github-app-token` v3.

| Location | Kind | Name |
|---|---|---|
| testing-csm-ci-server / environment `csm-ci` (deploys from `main` only) | variable | `CSM_CI_SERVER_APP_CLIENT_ID`, `CSM_CI_APPROVER_APP_CLIENT_ID` |
| Same as above | secret | `CSM_CI_SERVER_APP_PRIVATE_KEY`, `CSM_CI_APPROVER_APP_PRIVATE_KEY` |
| testing-csm-ci-client (repo level) | variable | `CSM_CI_CLIENT_APP_CLIENT_ID`, `CSM_CI_SERVER_REPOSITORY` (= `civitaspo/testing-csm-ci-server`) |
| Same as above | secret | `CSM_CI_CLIENT_APP_PRIVATE_KEY` |
| csm-ci-actions / environment `csm-ci-e2e` (deploys from `main` only) | variable | `CSM_CI_UNTRUSTED_COMMITTER_APP_CLIENT_ID` |
| Same as above | secret | `CSM_CI_UNTRUSTED_COMMITTER_APP_PRIVATE_KEY`, `CSM_CI_OWNER_TOKEN` |

`CSM_CI_OWNER_TOKEN` is the owner's fine-grained PAT.

- Its target repos are testing-csm-ci-server and testing-csm-ci-client.
- Its permissions are Read and write for Contents, Issues, Pull requests, Administration, Actions and Workflows.
- The harness uses this PAT to create PRs, post comments, sync fixtures (including `.github/workflows`), dispatch workflows, and read runs and logs.

**The AI must never** issue, register or change the permissions of private keys and PATs. If something is missing, stop and ask the user. You may use `gh` to register variables, create environments, and create or change rulesets.

### 2.4 Testing server config (`e2e/fixtures/testing-csm-ci-server/csm-ci.yaml`)

```yaml
owners: [civitaspo]
server_repository: civitaspo/testing-csm-ci-server
apps:
  client_bot_id: 347395374 # testing-csm-ci-client[bot]
  server_app_id: 5455185 # testing-csm-ci-server
  server_bot_id: 347400474 # testing-csm-ci-server[bot]
approver: { id: 347401524, login: "testing-csm-ci-approver[bot]" }
trust:
  committers:
    - { id: 4525500, login: civitaspo }
  approvers:
    - { id: 4525500, login: civitaspo }
policies:
  - { type: signed-commits }
  - { type: trusted-committers }
repositories:
  - { name: civitaspo/testing-csm-ci-client, ops: [approve, merge, policy-check] }
```

- The schema is zod strict, so an unknown key is an error. When a new phase adds config, update the schema (`src/lib/config.ts`) and this fixture in the same PR.
- The server repo itself (testing-csm-ci-server) is not in `repositories` yet. Phase 6 adds it.

### 2.5 Ruleset of testing-csm-ci-client

Ruleset id 25785295. The Phase 1 spike created it.

```json
{"name":"review-and-checks","enforcement":"active","target":"branch",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"pull_request","parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":true,
   "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,
   "allowed_merge_methods":["squash"],"require_extra_approval_for_unattributed_changes":true}}]}
```

- `actor_id: 5` is the repository admin role. This bypass lets the owner (admin) push directly to `main`. The harness's fixture sync relies on it.
- The Server App has no bypass. So when you merge with the Server App's token, the approval requirement applies. Use this property to verify merge (Phase 2).
- `require_extra_approval_for_unattributed_changes` was set by GitHub as a default at creation. Its behavior is not verified yet.
- This ruleset covers only part of `review-and-checks` in first-release-plan.md S6. Required checks, `integrity`, `controlled-merges` and `release-tags` are not in it yet. Complete them in Phase 2 or Phase 6.

### 2.6 Local tools

- bun 1.4.3, mise 2026.8.x, gh. The gh token has the `repo` and `workflow` scopes.
- jactionlint 2.3.0. It is not in the mise registry, so `mise.toml` specifies it as `"github:jdx/jactionlint" = "2.3.0"`.
- mise in this environment runs in locked mode. After you add a tool, update `mise.lock` with `MISE_LOCKED=0 mise lock`.
- TypeScript 7.0.2 (the Go version of tsc). `tsc --noEmit` works as is.
- `sed -i` behaves as GNU sed. If you write `sed -i ''`, it treats `''` as a file name and fails.

---

## 3. GitHub behavior verified against real runs

Each item was verified by running real workflows, not decided from the docs. If you change one of these assumptions, verify it against real runs the same way.

### 3.1 Using your own action at the same commit from a reusable workflow

- Inside a reusable workflow, `job.workflow_repository` and `job.workflow_sha` return the repo and commit of the called side (testing-csm-ci-client run 40099821184).
- `github.workflow_sha` is the commit of the caller, so you cannot use it instead.
- So put the following step first in every job, and use the action with `uses: ./.csm-ci-actions/actions/<name>`.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    repository: ${{ job.workflow_repository }}
    ref: ${{ job.workflow_sha }}
    path: .csm-ci-actions
    persist-credentials: false
```

### 3.2 Environment secrets do not arrive without `secrets: inherit`

- Even if the called job declares `environment: csm-ci`, the environment secrets are empty unless the caller sets `secrets: inherit` (testing-csm-ci-server run 40099955263).
- With `secrets: inherit`, they arrive (run 40100014166).
- Variables are visible without `inherit`.
- jactionlint reports this as `secrets-inherit`. Suppress it and write the reason (section 3.10).

### 3.3 `actions/create-github-app-token` v3.3.0

- The SHA is `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`.
- Use `client-id`. `app-id` is deprecated.
- You can pass either `name` or `owner/name` to `repositories`. If the owner part differs from the `owner` input, it is an error.
- If you specify only `owner`, the token covers every repo the App is installed on. The install probe uses this property.
- If the App lacks a requested `permission-*`, token issuance fails.
- The post step revokes the token automatically.

### 3.4 When an App's approval counts as a required approval

Verified with a ruleset that requires 1 approval on testing-csm-ci-client.

| Approving App | App permission | Token permission | Result | run |
|---|---|---|---|---|
| approver | contents: read | pull_requests: write | Does not count. It stays `REVIEW_REQUIRED`, and merge returns 405 with "At least 1 approving review is required by reviewers with write access." | 40104472870 |
| server | contents: write | contents + pull_requests: write | Counts | 40104538521 |
| approver | **contents: write** | pull_requests: write **only** | Counts | 40104932016 |
| approver | contents: write | contents + pull_requests: write | Counts | 40104965007 |

Whether an approval counts is **decided by the permissions on the App, not by the permissions you put on the token**.

### 3.5 Commit signing

- The results are as follows.

| How the commit is made | committer | Signature | `committedViaWeb` | Verdict |
|---|---|---|---|---|
| REST contents API (`PUT /repos/{o}/{r}/contents/{path}`) with a user's token, no author specified | The user | **unsigned** (`verified: false`, `reason: unsigned`) | false | Unsigned |
| REST contents API with a user's token, author set to someone else (the noreply email of `renovate[bot]`) | n/a | unsigned | n/a | Rejected as unsigned |
| GraphQL `createCommitOnBranch` with a user's token | `web-flow` | verified, `wasSignedByGitHub: true` | **true** | Trusted through the S3 web-flow path |

- To make a trusted commit in the e2e, use `createCommitOnBranch` (`openPr(ctx, "signed")` in `e2e/harness.ts`).
- `createCommitOnBranch` has no input to set the author. The author is the token's owner.
- Using the REST contents API with an App token and faking the author as the owner is not verified. Verify it in a CI-only scenario (section 1.4).

### 3.6 The issue_comment event payload can contain the edited body

- If you edit a comment about 1 second after posting it, `github.event.comment.body`, as evaluated by the client's workflow run, was the **edited body**. We observed this in two directions.
  - Edit "`/approve`" to "`/approve `": the client skipped (testing-csm-ci-client run 40106990826).
  - Edit "plain text" to "`/approve`": the client sent a request (server runs 40109202824 and 40109202885).
- So **the client's prefilter is not a security boundary**. The boundary is the "unedited" check (`created_at == updated_at`) that the server makes after rereading the comment.
- The e2e scenario for an edited `/approve` checks that every request is rejected, whether there is one request or two (`expectEveryOp`).

### 3.7 Other API behavior

- `PATCH /git/refs/heads/x` for a ref that does not exist returns 422 with "Reference does not exist".
- Creating a label with an existing name returns 422. The e2e lock uses this property as a test-and-set.
- In octokit's types, an id is `number | bigint`. Normalize it with `Number()` before you compare it or pass it as an argument.
- Calling `POST /repos/.../actions/workflows/{id}/dispatches` makes octokit warn "deprecated, removed on 2028-03-10". It does not affect the harness. Move to the new API at some point.
- Dispatching a workflow right after you create it returns 422 for a while. The harness retries while the status is 422.

### 3.8 `GET /user` cannot be called with an installation token

Verify the approver's identity after the approval by looking at the review's `user.id` (S6 and docs/approve.md). If it differs, dismiss the review and fail.

### 3.9 bun build

- `bun build --target=node --format=esm` is deterministic. We built twice and the hashes matched. check-dist relies on this property.
- Each `dist/*.js` is about 1.4MB (it includes octokit and zod).

### 3.10 jactionlint

- To suppress a rule, write `# jactionlint ignore=<rule>[,<rule>]` on the line above the target line. Write the reason in a comment above that.
- These rules have appeared so far.

| Rule | What it reports | Response |
|---|---|---|
| `concurrency-limits` | There is no concurrency | Suppress (label and client events must not cancel each other) |
| `secrets-inherit` | It uses `secrets: inherit` | Suppress (section 3.2) |
| `unpinned-uses` | It is not pinned by SHA | Suppress only for `@e2e` in the testing fixtures |
| `dangerous-triggers` | It uses `pull_request_target` or `issue_comment` | Suppress (it does not check out the PR. The only key that crosses over is the Client App's key) |
| `github-app` | It specifies only `owner` and no `repositories` | Suppress only for the probe |
| `missing-timeout` | There is no timeout | Add `timeout-minutes` |
| `unused-job-output` | A job output is unused | Delete it |

- CI runs `jactionlint --online`. This also detects pins to impostor commits. That is why pinact is not installed.
- The fixtures are not in the repo root's `.github/workflows`, so the CI jactionlint does not check them. After you change a fixture, move into the fixture directory, name the files explicitly, and check with `jactionlint --online .github/workflows/*.yml`.

---

## 4. Current implementation (by file)

```
src/lib/config.ts        zod schema of csm-ci.yaml (strict), repositoryEntry (first-match glob, narrowed by owners)
src/lib/request.ts       REQUEST_KINDS (number shape per op), parseLabel, validateIntake (S2), buildLabel, concurrencyKey
src/lib/intake.ts        runIntake: parse the event -> load config -> validateIntake -> verifyLiveLabel
src/lib/github.ts        octokit factory (fetch is injectable), loadConfig, verifyLiveLabel, splitRepository
src/lib/trust.ts         CommitFacts -> evaluateTrust (S3), fetchCommitFacts (REST, and GraphQL only for web-flow commits)
src/lib/policies/        Policy discriminated union and the EVALUATORS table. signed-commits, trusted-committers
src/lib/command.ts       parseCommand (exact match of /approve and /recheck), validateComment (S5), requirePrincipal, checkPullState
src/lib/approve.ts       runApprove: auto / /approve / /recheck, approveHead (idempotent, refetches head after approval and dismisses, identity check)
src/lib/notify.ts        marker, hasServerMarker (counts only what the server bot wrote), postResult
src/lib/testing.ts       Test fixtures (CONFIG_YAML) and fakeFetch (returns responses by method and path, and `then` can change the responses from the second call on)
src/<entry>/main.ts      Action entry points: intake, request, approve, check-config
actions/<name>/action.yml  node24 JS action. main is ../../dist/<name>.js
scripts/build.ts         Bundles src/*/main.ts into dist/<name>.js
scripts/setup-wizard.sh  Guides App registration and installation, and secret and variable registration (generic. Takes the prefix as input)
.github/workflows/server.yml        reusable. intake -> op -> cleanup
.github/workflows/server-check.yml  reusable. zod validation of csm-ci.yaml and jactionlint
.github/workflows/client-approve.yml reusable. Receives pull_request_target and issue_comment, and creates a label after the prefilter
.github/workflows/ci.yml           status-check (typecheck, test, check-dist, jactionlint --online)
.github/workflows/e2e.yml          workflow_dispatch(ref, feature). Environment csm-ci-e2e, from main only
e2e/run.ts      lock, FEATURES registration, execution
e2e/harness.ts  Shared helpers (dispatch, serverRun, expectOp, openPr, closePr, postComment, and others)
e2e/smoke.ts, e2e/approve.ts  Scenarios per feature
e2e/fixtures/<repo>/...      Files synced to the testing repos
docs/first-release-plan.md, docs/approve.md, docs/setup.md, docs/handoff.md
```

### 4.1 Structure of server.yml (the pattern for adding an op)

- **`intake`**
  - It starts on `label: created`. It runs only when the label name starts with `csm-ci-` and `sender.type` is `Bot`.
  - Its permissions are `contents: read` and `issues: read`.
  - It passes the S2 validation and outputs `kind`, `owner`, `name`, `args` (JSON) and `concurrency-key`.
- **`op`**
  - `needs: intake`, `environment: csm-ci`.
  - `concurrency: csm-ci-${{ needs.intake.outputs.concurrency-key }}`, `cancel-in-progress: false`.
  - Its permission is `contents: read` (to load the config).
  - For each op, put a token step and an action step under `if: needs.intake.outputs.kind == '<op>'`. Issue the token for each op with the minimum permissions.
  - For a kind that has no handler yet, the job only prints `no <kind> handler yet`.
- **`cleanup`**
  - It always deletes the request label with `always()`. Its permission is `issues: write`.

To add a new op:

1. Add the token step and the action step with an `if`.
2. Add a condition that excludes that kind to the condition of the "no handler" step.

### 4.2 Request shape (`REQUEST_KINDS`)

| kind | Number shape | Use |
|---|---|---|
| approve | `[pr]` or `[pr, comment]` | auto / `/approve`, `/recheck` |
| merge | `[pr, comment]` | `/merge` (Phase 2) |
| policy-check | `[pr]` or `[pr, comment]` | Phase 3 |
| securefix | `[run_id]` | Phase 4 |
| release | `[pr]` | Phase 5a |

The label name is `csm-ci-<kind>-<16 hex>` (50 characters or fewer). The description is `owner/repo/<n>[/<n>]` (lowercased. Leading zeros and numbers outside the safe integer range are rejected).

---

## 5. How to work (quality bar)

We did Phases 0 and 1 with this procedure. Follow the same procedure.

1. **Check the specification.** Read the relevant phase in first-release-plan.md, and S1 to S7. Do not add features that first-release-plan.md does not have (ponytail). If you decide a feature should be added, send the first-release-plan.md update as a PR first.
2. **Verify assumptions about external behavior against real runs.** Put a temporary workflow in a testing repo, try it, and delete it afterward. Record the URL of the resulting run in the decision log and in first-release-plan.md.
3. **Decide the data shape first.** Separate pure functions (decisions) from functions that call APIs (fact collection). Test decisions with table-driven tests.
4. **Cover every rejection condition with table-driven tests, one case per row.** Also assert the wording of the rejection reason.
5. **Verify with mutation.** Remove one rejection condition at a time and confirm that a test fails. If a mutation survives, add a test.
   We have used the following script at `$TMPDIR/mutate.sh`. You may put it in `scripts/` if needed.

   ```bash
   #!/usr/bin/env bash
   # usage: mutate.sh <file> <exact line substring> <replacement>
   f=$1; from=$2; to=$3; cp "$f" "$f.orig"
   python3 -I -c 'import sys;p,a,b=sys.argv[1:4];s=open(p).read();assert a in s,("missing",a);open(p,"w").write(s.replace(a,b,1))' "$f" "$from" "$to" || { mv "$f.orig" "$f"; echo "SETUP-FAIL $from"; exit 2; }
   if bun test >/dev/null 2>&1; then r="SURVIVED"; else r="killed"; fi; mv "$f.orig" "$f"; echo "$r: $f :: $from"
   ```

6. **Never swallow API errors.** `catch {}` is forbidden. Branch only on statuses that mean "does not exist" (404 and 422), and throw everything else (use `hasStatus`).
7. **Verify locally.**

   ```bash
   bun install --frozen-lockfile --ignore-scripts && bun run typecheck && bun test && bun run build && test -z "$(git status --porcelain dist/)"
   mise exec -- jactionlint
   ```

8. **Run the e2e.** See section 7.
9. **Before you open a PR, ask a fresh subagent for an independent review.**
   - Give it the specification (the relevant section of first-release-plan.md) and the diff. Ask it, as an attacker, to look for places weaker than the specification, changes the tests cannot catch, and code outside the plan.
   - Do not give it your conclusions.
   - Check each finding yourself before you fix it. In Phases 0 and 1, every review found real holes.
     - S3 could be disabled through config.
     - A 7-character sha could be brute-forced.
     - A replay could mass-produce comments.
     - An unsigned commit was treated as trusted.
10. **PR format.**
    - The title is a Conventional Commit (`feat(approve): ...`).
    - The body has Why / What changed / Scope / Tradeoffs / Blast Radius / Verification.
    - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` (replace it with the Codex version when you use Codex).
    - End each commit message with the Co-Authored-By of the tool you use.
    - Commits are signed over SSH (already set in git config).
11. **Merge.**
    - Merge only by squash. When the PR is CI green, stop and report.
    - Merge with `gh pr merge <n> --squash` only if the user allows it.
    - When you merge stacked PRs, retarget the base of the child PR.
12. **Decision log.**
    - `decisions.tsv` (columns: ts, phase, decision, why, evidence, result) records decisions. It sits at the repo root. Git does not track it. It is listed in `.git/info/exclude`.
    - The key decisions so far are copied into this document and first-release-plan.md.

---

## 6. Implementation instructions for the remaining phases

first-release-plan.md is the source of truth for each phase's specification. This section adds only implementation notes. The DoD (first-release-plan.md "DoD (all phases)") is as follows.

- Unit tests, table-driven tests, mutation
- e2e in the testing environment
- `docs/<feature>.md`
- check-dist

### 6.1 Shared places when working in parallel

Every phase appends to the following files. Only append. Do not change existing lines.

| File | What to append |
|---|---|
| `src/lib/config.ts` | The config keys of your phase (example: `merge: {...}`) |
| `e2e/fixtures/testing-csm-ci-server/csm-ci.yaml` | The values for those keys. The fixture must pass the strict schema |
| `.github/workflows/server.yml` | The op job's token step and action step. The exclusion condition of "no handler" |
| `e2e/run.ts` | One line in `FEATURES` |
| `REQUEST_KINDS` in `src/lib/request.ts` | Only when you change the shape |
| `docs/setup.md` | The section on the client caller |
| `README.md` | Only when needed |

- Make one PR per phase, and branch from `main`. Resolve conflicts by rebasing.
- **The e2e runs one at a time because of the lock (section 7.2).** Even if you develop in parallel, e2e runs go one by one.
- Phases that change testing repo fixtures must take care not to overwrite each other's fixtures. On every run, the harness syncs the fixtures of its own branch. So another phase's fixtures can disappear temporarily. Keep every phase's fixture changes append-only.

### 6.2 Phase 2: merge

- **client:** Create `client-merge.yml` (same shape as `client-approve.yml`). When it receives a `/merge` comment, it sends the `merge` kind with `[pr, comment]`. The prefilter is the same (association and exact match of the body).
- **sha argument:** first-release-plan.md says `/merge [sha]`, but for the same reason as `/approve`, **we recommend no argument**. If you accept a sha, accept only an exact 40-character match. Ask the user which one to use when you start.
- **server** (`src/lib/merge.ts`)
  1. Pass the S5 validation (the flow of `validateComment`).
     - Add the parse of `/merge` to `parseCommand`.
     - The comment author must be in `trust.mergers` or `trust.bot_mergers`. For `bot_mergers`, also check that the PR author and the effective identity of every commit are the same bot.
     - Use `marker("merge", comment_id)` for the replay check.
  2. Check the PR state, pass trust (`ALWAYS` and the config policies), and pin the head.
  3. Check that the head was not created after the comment (the same check as `checkHeadPredatesComment`).
  4. Poll for readiness. Poll every 30 seconds until `merge.deadline_minutes` (add it to the config, default 60). On every poll, revalidate the PR state, the head and the comment (kill switch). The ready condition has three parts.
     - The approver's latest review is an APPROVE for that head.
     - The policies pass when you re-evaluate them inside the server.
     - `merge.required_checks` (`[{name, app_id}]`) is success or skipped from the specified app.
  5. Only after it is ready, issue the write token (Server App, `contents: write` and `pull_requests: write`).
     - Call `pulls.merge({sha: head, merge_method: "squash", commit_message})`.
     - The commit message is the PR body plus the `Co-authored-by` lines with duplicates removed.
     - Retry 405, 422 and 503 after revalidation. Treat 409 as an immediate failure. Check that `merged: true`.
  6. Report the result with a receipt that carries a marker.
- **Config to add:** `trust.mergers`, `trust.bot_mergers`, `merge.required_checks`, `merge.deadline_minutes`. Also add the fixture and schema tests.
- **Ruleset:** Add `controlled-merges` from first-release-plan.md S6 (an `update` rule. The only bypass is the Server App's `pull_request` mode) to testing-csm-ci-client by hand.
  - The bypass actor is `{"actor_id": 5455185, "actor_type": "Integration", "bypass_mode": "pull_request"}`.
  - Verify its interaction with the admin bypass of the existing `review-and-checks` against real runs. The owner's fixture sync (direct push) must not stop.
- **e2e:** Cover every e2e item of first-release-plan.md Phase 2. The harness may add the approval through the approver's review. In that case, using the approval from the Phase 1 auto approve is enough.
  - For "it is rejected when not approved, even with the ruleset removed", temporarily set the ruleset to disabled, verify, and always restore it afterward (`try/finally`).
- **Note:** The merge wait can take up to 60 minutes. Build the scenarios so they finish within the e2e timeout (`TIMEOUT_MS` = 10 minutes) and the e2e workflow's `timeout-minutes: 60` (for example, make the required checks succeed immediately).

### 6.3 Phase 3: policy-check

- **client:** `client-policy-check.yml`. On `pull_request_target` (opened / synchronize / reopened / ready_for_review / edited), it sends the `policy-check` kind with `[pr]`.
- **server**
  - Evaluate `ALWAYS` and the config policies against the head.
  - Create or update the check run `csm-ci/policy` with the Server App (`checks: write`). Set `external_id` to the head. Put a table of results per policy in the summary.
  - After approve (auto and `/approve`) and on `/recheck`, update the check run with the same evaluation. The "update policy-check" item left from Phase 1 is this.
- **sensitive-paths policy** (`src/lib/policies/sensitive-paths.ts`)
  - Get the changed files with `pulls.listFiles`. The limit is 3000 files. Fail closed above that. Match both `filename` and `previous_filename`.
  - Match globs with `picomatch` and `dot: true`.
  - `exempt` applies only when the PR author and every commit are the same principal.
  - Otherwise, it needs **a valid review that carries the `/approve` marker (`approve:command:<comment_id>`)**. A valid review meets these conditions.
    - The review's `user.id` equals the approver's id.
    - `state` is APPROVED.
    - `commit_id` equals the head.
    - When you reread the comment the marker points to, its author is in approvers.
  - **The server repo and the csm-ci-actions repo always treat every path as sensitive in code.** Do not use exempt and bot_mergers for them. Make this behavior impossible to change through config (see the config section of first-release-plan.md).
  - You need to add functions to `PolicyContext`, such as the changed files, the reviews, and a function that rereads a comment. The current `PolicyContext` is only `{ trust }`, so make the shape change by appending.
- **Note:** The auto approve decision also includes sensitive-paths. This creates a cycle: sensitive-paths looks for the `/approve` marker, but `/approve` itself has not approved yet. In `commandApprove`, evaluate sensitive-paths as already satisfied by "the approver's approval". There are two design options. Pick one.
  - In `/approve`, evaluate without sensitive-paths.
  - Pass the comment as evidence equivalent to the marker.

Implementation decision: `/approve` first checks all always-run and configured policies except sensitive-paths, then creates the approval pinned to the head with the source comment marker, and reevaluates all policies to update the check. This uses the same persisted evidence as later evaluations and avoids treating the command as a separate policy bypass.

| Condition | Impact | Current limitation | Fix |
|---|---|---|---|
| A pull request touches 3,000 or more files | Policy fails closed | GitHub caps listing at 3,000 and the summary reports the limit, not the full changed-file set | Keep the fail-closed cap; do not raise it without a different complete-file source |

### 6.4 Phase 4: securefix

- **client:** A reusable workflow. It turns the diff files into an artifact (`actions/upload-artifact`, pinned by SHA) after it checks path safety. The limits are 512 files, 8MB per file and 10MB in total. It sends the `securefix` kind with `[run_id]`.
- **server**
  - Fetch the artifact from the other repo with `actions/download-artifact`, specifying `run-id` and `github-token`.
  - After the download, revalidate paths, sizes and symlinks.
  - Check the route binding of S4.
    - `run.pull_requests` has exactly 1 entry, and that PR's base is the default branch.
    - The head branch has no 2 or more open PRs.
  - **TOCTOU defense:** Reject if the PR's current head differs from `run.head_sha`. Write with `createCommitOnBranch(expectedHeadOid=run.head_sha)`.
  - Issue a `workflows: write` token only when there are changes under `.github/workflows/**` (`allow_workflow_changes`).
- **Idempotency:** On a retry, treat it as success if the head is a commit that "has `run.head_sha` as its parent, was made by the server, and has content that matches the artifact".
- **e2e:** Cover every item in first-release-plan.md. In particular, always include "a path that uses a PR from the same branch to a different base" (the defense for the new hole in S4).
- **Note:** `createCommitOnBranch` cannot set the executable bit. State this in the docs.

### 6.5 Phase 5a: release (publish)

- **spike (the first PR):** Settle the attestation storage location, the predicate shape and the verification command against real runs.
- **Job separation**
  - **plan:** Read token. Check that the PR is merged, that `merged_by` is the Server bot, that it is a PR from `release/next` to the default branch, and that `.release-version` is a semver. The server creates the tag.
  - **build:** `permissions: {}`, no secrets, no environment and no cache. Use a composite action per `build_type` (`actions/release-build/<type>/`).
  - **publish:** Checksum, attestation, draft creation, upload, confirmation that the asset set matches exactly, publish, and confirmation that the release is immutable.
- **Tag ruleset:** Add `release-tags` to testing-csm-ci-client (forbid creating, updating and deleting `refs/tags/v*`. The only bypass is the Server App).
- **build_type:** none, js-action (check-dist), goreleaser, cargo. In the e2e, start with none and js-action. goreleaser and cargo need testing client material (small Go and Rust programs). Place them as fixtures.

### 6.6 Phase 5b: release-pr (after Phase 4)

- Use the route mode of securefix (`from: default`, `to: release/next`, constraints on `paths`).
- `version-only` checks, with a line-level diff, that only the `version` line changed.

### 6.7 Phase 6: repo-settings

- Create `server-repo-settings.yml` (schedule and dispatch, environment `csm-ci`). Issue the Server App's token per target repo with `administration: write` only.
- Sync the four rulesets of first-release-plan.md S6 and immutable releases. Do not enable controlled-merges from the schedule.
- Write the managed files to the `csm-ci/repo-settings` branch with `createCommitOnBranch`, and create a PR.
- Replace the hand-made ruleset of testing-csm-ci-client (section 2.5) with the result of the Phase 6 sync. Watch for name collisions (two or more rulesets with the same name is an error).

### 6.8 Phase 7: production migration

This phase is mostly human work. A human creates and installs the Apps, registers the keys, and creates `csm-ci-server`. The AI prepares the wizard (`scripts/setup-wizard.sh`) and the procedure.

---

## 7. Using the e2e, and cautions

### 7.1 Running

```bash
# From your machine. GH_TOKEN is the owner's gh token
GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <full sha of the PR head> --feature <smoke|approve|...> [--scenario <name substring>]

# From CI (the harness on main runs. The untrusted scenarios also run)
gh workflow run e2e.yml --repo civitaspo/csm-ci-actions --ref main -f ref=<sha> -f feature=<feature>
```

Use `--scenario` to run a representative scenario while iterating, for example `--feature approve --scenario "edited after posting"`. The filter is a case-sensitive substring of the scenario name; it must match at least one scenario. Omitting it runs the full feature. CI runs still execute the full feature.

The harness runs in this order.

1. Take the lock.
2. Force-push the `e2e` branch of csm-ci-actions to `--ref`. The testing callers reference `@e2e`.
3. Sync the fixtures to `main` of the testing repos (commit if there is a diff).
4. Run scenarios concurrently, and print PASS / FAIL / SKIP with the run URLs.
5. Release the lock.

### 7.2 The lock

- Take it with the label `e2e-lock` in csm-ci-actions. The description is `<ISO time> <feature>@<sha7>#<rand>`.
- If it cannot take the lock, it waits and retries every 15 seconds. It steals a lock older than 60 minutes.
- We confirmed that two runs started at the same time run in series (smoke printed "waiting for the e2e lock" 38 times and started after approve finished).
- **If you kill the harness process, the lock stays.** After you confirm that it is yours, delete it with `gh label delete e2e-lock --repo civitaspo/csm-ci-actions --yes`.

### 7.3 Cautions when writing scenarios

- **Cleanup:** Open PRs with `withPr` (`e2e/approve.ts`), and close the PR and delete the branch in `finally`. If you kill the process, PRs stay open. Close the open PRs on branches that start with `e2e-`.

  ```bash
  for n in $(gh pr list --repo civitaspo/testing-csm-ci-client --state open --json number,headRefName --jq '.[] | select(.headRefName|startswith("e2e-")) | .number'); do gh pr close $n --repo civitaspo/testing-csm-ci-client --delete-branch; done
  ```

- Match server runs only by the accepted request in the intake log, including its operation, repository, PR number and comment id, or by an exact label name in the cleanup log for labels rejected before parsing. Similar error text is never an identity. Search all workflow-run pages within the scenario time window.
- Client issue-comment workflow run names include the PR number and comment id so a skipped request can be matched to the exact comment.
- **The server's receipt comment also triggers issue_comment.** The prefilter rejects that client run because of the bot's association (`NONE`), so it skips. The server runs do not increase.
- **For scenarios that need a second identity,** set `needsUntrusted: true`. They are SKIPped on your machine and run only in the CI e2e workflow.
- **`labelFor`** (the dispatch of `csm-ci-smoke.yml`) lets you create any request with the Client App. You can use it to simulate "an attacker who holds the Client App's key".

---

## 8. Open items and candidates for next work

1. **Approve untrusted commits with `/approve` that takes no argument** (the user's proposal).
   - The commit date is freely chosen by its author, and it stays verified even when signed. So you cannot compare dates.
   - A usable alternative is to look, instead of the push time, at the creation time of the `pull_request_target` (synchronize) workflow run that GitHub started for that head. If there is no run yet, reject (fail closed).
   - The current decision is "trusted commits only". If you adopt this, agree with the user first, then change first-release-plan.md.
2. **Renovate dependency update PRs fail check-dist** (they do not rebuild dist). Until Phase 4 securefix provides a flow to rebuild dist, run `bun run build` by hand and commit.
3. **The workflow dispatch API is deprecated** (section 3.7).
4. **`require_extra_approval_for_unattributed_changes`** (section 2.5): verify in Phase 2 how it affects the approval of bot commits.
5. **The client caller in docs/setup.md:** Each time you add a client workflow in Phase 2 or later, add a section.
6. **Make the e2e scenarios of a feature run in parallel.** (Implemented.)
   - Scenarios use separate pull requests and run concurrently under the feature-level lock. Server runs are matched to the intake request, and skipped client runs are matched by PR and comment id.
   - Smoke workflow dispatches carry a unique correlation id in the run title. The harness searches paginated recent runs for that exact title; probe and check dispatches select only runs created after dispatch began. Server cleanup checks inspect only the request's own label.
   - Local smoke at `38cc650` passed all six scenarios, including a human-created label whose intake job is skipped. Local approve at `38cc650` passed all seven runnable scenarios with four CI-only skips. The final exact PR-number boundary fix at `cc01ff9` passed all seven runnable approve scenarios and all six smoke scenarios. See section 12 for the correlation rules and evidence.
   - Keep the feature-level lock because features share the fixtures.

7. **Give every GitHub API call a timeout and a retry.**
   - Observed on 2026-10-25: a server intake job that usually takes about 10 seconds ran for 6.5 minutes and hit its 5-minute `timeout-minutes` (testing-csm-ci-server run 40113558825). In the same period the API returned HTTP 502 and some local `gh` calls timed out. githubstatus.com showed all systems operational. The intake log was not available, so the hanging call is not known.
   - Completed in [PR 6](https://github.com/civitaspo/csm-ci-actions/pull/6): the shared client now bounds the complete request and retries safe reads. See section 11.
   - Fix it in the `github()` factory: an `AbortSignal.timeout` per request (for example 30 seconds) and a bounded retry with backoff for network errors, 502, 503 and 504. Retry only idempotent calls. Do not retry writes such as `createReview`, `pulls.merge` or `createCommitOnBranch`, because a write that succeeded but whose response was lost must not run twice. The approve and merge flows already re-read the state, which covers that case.
   - Add table-driven tests with the fake fetch: a hang that times out, a 502 then a success, a write that is not retried.

---

### Follow-up

| Condition | Impact | Current limitation | Proposed fix |
|---|---|---|---|
| Workflow-run logs are unavailable before the scenario window expires | A run cannot be correlated or inspected | Correlation requires the accepted-request intake line or exact cleanup label line | Preserve the request identity in workflow metadata so correlation does not depend on downloadable logs |

## 9. Verification record (key runs)

| Content | run |
|---|---|
| Install targets and permissions of the 4 Apps (Phase 0) | testing-csm-ci-server 40099263631, testing-csm-ci-client 40099334300, and the untrusted committer App in a CI e2e of the old repository |
| Smoke e2e from CI (Phase 0) | Ran green in the old repository |
| approve spike | testing-csm-ci-server 40104472870, 40104538521, 40104932016, 40104965007 |
| Local approve e2e (final head of Phase 1, 8e350d4) | 7 PASS, 4 SKIP. Examples: testing-csm-ci-server 40109466977 (auto approve), 40109645823 (`/approve`), 40109819219 (replay), 40110043805 and 40110042180 (edited), 40110177486 (`/recheck`) |
| Local smoke e2e (8e350d4) | 6/6. Example: testing-csm-ci-server 40110303817 |
| Local approve e2e (target `1745ca8b54a86c8ec49250cd4292893e2a34de84`) | 7 PASS, 4 SKIP. Runs: [40117624912](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117624912), [40117625071](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117625071), [40117626200](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117626200), [40117681890](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117681890), [40117625298](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117625298), [40117703360](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117703360), [40117628033](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117628033), [40117713499](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117713499), [40117623557](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117623557), [40117694855](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40117694855), [40117705864](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117705864), [40117706889](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117706889), [40117627207](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117627207), [40117711535](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117711535), [40117766099](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40117766099), [40117776062](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117776062). |
| CI e2e from `main` of the old repository (after Phase 1) | approve 10/11; the remaining scenario failed on a harness wait shortfall, which is fixed in `main`. smoke green. Rerun both in this repository |

---

## 10. Pitfalls so far (to avoid repeating them)

- **If you put "pass the CI e2e after the merge" in a goal's completion condition, the goal stays stuck waiting for the merge.** Make the completion condition "the PR is CI green and the local e2e is green". Ask for the post-merge check as separate work.
- **Re-registering a secret stored an empty value.** `GH_TOKEN=""` is ignored, and gh uses your usual authentication. To check that a PAT is valid, use `curl -fsS -H "Authorization: Bearer $T" https://api.github.com/user`.
- **Mixing merge commits and squash.** csm-ci-actions is squash only now. For stacked PRs, merge the parent PR first, then retarget the base of the child PR.
- **Renovate tried to pin `@e2e` in the e2e fixtures to a SHA** (in the old repository). `e2e/fixtures/**` is in `ignorePaths` in `renovate.json`.
- **The auto mode permission check sometimes rejects `gh pr merge`.** When that happens, do not work around it. Ask the user.
- **If a YAML plain scalar contains `xxx: `, YAML reads it as a key.** Writing `echo "client: ..."` as the value of `run:` breaks it. Use a `run: |` block scalar.

## 11. GitHub request deadlines and retries

The shared `github()` factory now bounds each complete request attempt, including response-body reads, to 30 seconds. Read requests get at most three attempts, with 250 milliseconds and one second between attempts. See [GitHub API requests](github-api.md).

The retry boundary is the Octokit request hook. A fetch-only wrapper would miss a stalled response body because fetch resolves when the headers arrive. The installed Octokit request implementation also catches response-body errors, so the deadline races the complete request and aborts its underlying fetch.

Only REST GET and HEAD requests and conservatively recognized GraphQL queries can be retried. Timeouts, network failures, and HTTP 502, 503, and 504 qualify. Caller cancellation and other API errors propagate. Writes, including GraphQL mutations, get one attempt because their response may be lost after GitHub accepts them.

The limits cover both the actions and the e2e runner. They do not affect external actions or `gh`. This implements section 8 item 7.

Verification includes table-driven retry and no-retry cases, stalled headers and bodies, cancellation, and the final request payload after Octokit applies overrides. Fourteen mutations were detected, including removing the attempt bound, the read-only restriction, the full-response deadline, the fetch abort signal, and the GraphQL mutation restriction. An independent security review found no actionable issues.

While preparing this change, the jobs API for [server run 40114635373](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40114635373) returned HTTP 502. That baseline run later completed as cancelled. The PR records the new local e2e runs; post-merge CI runs are recorded with the next handoff update.

### Same-second comment edits discovered during retry validation

The edited-comment scenario exposed a pre-existing acceptance bug in [server run 40116623333](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40116623333). Comment 6387356105 on testing client PR 79 was created and edited at `2026-10-24T17:32:47Z`. REST returned identical `created_at` and `updated_at`, while GraphQL returned a non-null `lastEditedAt`. The server approved it because it previously compared only REST timestamps.

Comment reads now fetch GraphQL `databaseId` and `lastEditedAt`, verify that the node matches the REST comment, and fail closed if either value is missing or inconsistent. Command acceptance rejects any non-null edit time, including during the final revalidation. Sensitive-path approval markers use the same comment reader and require the source comment to be on the matching pull request, authored by a trusted human approver, and unedited. API errors propagate; deleted or unverified marker evidence is not accepted. This repair is included with the request timeout work because its live acceptance gate found an authorization failure that cannot be deferred. The specification's unedited requirement is unchanged; its API evidence is corrected.

## 12. Parallel e2e request correlation

Scenarios within one feature run concurrently. The cross-process lock still serializes feature runs because they share the testing repositories and the `e2e` ref. A failed scenario does not release that lock while other scenarios are running.

The harness identifies accepted requests by operation, repository, and numeric arguments in the intake log. Rejected labels use the complete label value printed by the runner in the cleanup step's environment. This is verified in [server run 40117575130](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117575130); the runner prints `LABEL:` even though the shell command does not echo it. Cleanup checks examine only the scenario's label.

Client comment runs include the PR and comment ID in their title. Each requested comment must have its own completed run; duplicate runs for one comment cannot substitute for another. The edited-comment scenario waits for the client to finish, counts the labels it emitted together with the explicit test request, and then waits for all corresponding server runs. A short fixed delay cannot establish that every request has arrived.

Smoke dispatches use a fresh correlation ID. All run searches paginate and apply the scenario's start time; non-overlapping probe and check dispatches retain the same time filter. Nine mutations were detected across exact PR-number boundaries, request identity, dispatch identity, time filtering, pagination, comment coverage, complete cleanup labels, the expected server request count, and skipped intake logs.

[PR 6](https://github.com/civitaspo/csm-ci-actions/pull/6), `fix(github): bound request timeouts and retries`, merged at `f3ceef02dba85f02f5fad6b3e191b9edfa822965`. Its post-merge [smoke e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40118182203) passed all six scenarios, and [approve e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40118332288) passed all eleven, including the four CI-only untrusted-committer scenarios. These runs established the timeout and retry baseline before parallel request correlation was added. The first queued approve run was replaced by a later pending run because GitHub concurrency permits only one pending run per group. After cancelling the older baseline run and removing its stale lock, approve was dispatched again. Dispatch the next feature only after the first has started to avoid replacing a pending run.

The first parallel smoke run exposed a missing-log edge in [server run 40119806270](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40119806270). Human-created labels skip intake, so the skipped intake job has no downloadable log and its log API returns 404. Candidate scans now skip that download and correlate the human label through cleanup. Other API errors still propagate. An integration-style test using the real Octokit client and a fake HTTP transport reproduces the missing log and checks both matching and unrelated requests.

Local parallel smoke at `38cc650afde638aeba966d2e7d112f7eac1f29b4` passed all six scenarios. Evidence includes [server/App permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121038621), [client App permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40121039427), [configuration check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121039930), [human label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121040555), [disabled operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121049844), and [accepted label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121048588).

Final local parallel approve at `cc01ff99b72aa1a17e4bee696efe8abbf919bae5` passed seven scenarios; four require the CI-only untrusted identity. Evidence includes [trusted automatic approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121352451), [unsigned rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121419041), [command approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121426005), [recheck](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121420295), [edited rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121430154), and [replay rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121503833). Independent review also found that the client-run regex allowed a PR-number prefix; an exact numeric boundary and regression test now reject that match. Removing the boundary made the test fail.

Final local parallel smoke at `cc01ff99b72aa1a17e4bee696efe8abbf919bae5` passed six of six: [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121569343), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40121569429), [configuration](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121569472), [human label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121571175), [disabled operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121596017), and [accepted label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40121602695).

## 13. Policy-check integration

Parallel e2e request correlation merged in [PR 7](https://github.com/civitaspo/csm-ci-actions/pull/7) as `31d0e0cc3c41271f5d01fce223504b2180cd1faa`. Its post-merge [approve e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40121818143) passed eleven scenarios with no skips. The post-merge [smoke e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40121839872) also completed successfully.

The policy-check e2e feature uses an isolated pull request for each scenario. It checks the summary rows and Server App identity, exercises both signed and trusted-committer failures, and runs the sensitive-path approval marker and `/recheck` cycle. Draft pull requests keep the fake non-approver and COMMENT review tests from accepting a real `/approve` request. The client workflow fixture is synchronized as part of e2e setup; it does not alter the shared server policy or repository rulesets. Final local policy-check, approve, and smoke verification passed; the branch CI attempt and the required post-merge CI coverage are described below.

The independent review found no policy bypass and requested two follow-ups: enumerate the default sensitive-path patterns and prevent attacker-controlled filenames from injecting Markdown into the check summary. Both are fixed and were re-reviewed. Check updates explicitly set `completed_at`; the e2e uses the actual Octokit check-run type rather than assuming an `updated_at` field.

Mutation checks detected removal or weakening of the file cap, protected-repository sensitivity, dot-directory matching, exemption membership/nonempty/all-commit identity rules, prospective command head/approver binding, review producer/state/head binding, marker syntax, source PR/body/human/trusted identity, REST and GraphQL edit evidence, source node identity, and 404-only missing-comment handling. The unmarked review regression permanently contains a valid comment number, so weakening the marker format fails the unchanged suite. Removing the GraphQL timestamp shape check alone is behaviorally equivalent for policy rejection because the downstream non-null check independently rejects missing evidence. The full suite passed 254 tests with 518 assertions before live verification.

A pre-merge branch CI attempt, [40122789929](https://github.com/civitaspo/csm-ci-actions/actions/runs/40122789929), was rejected before any job ran: `codex/policy-check` is not allowed by the `csm-ci-e2e` environment protection rules. Do not change those settings. Run the CI-only identity cases from `main` after merge, as required by the working process. Local runs still exercise the cases available to the owner identity.

Local policy-check at `0424eab6f6efc0db1e5184e837c5699719e4aed4` passed all three cases available without the CI-only identity: [ordinary signed/trusted paths](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122805962), [unsigned rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122805550), and [/recheck refresh](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122865902). Each check was created by Server App 5455185 with the current head as external ID; `/recheck` updated the same check with a later completion time. Four identity-dependent cases remain for post-merge CI.

Local smoke at the same policy-check head passed six of six: [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122924004), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40122923757), [configuration](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122924203), [human label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122925795), [disabled securefix operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122934527), and [accepted label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40122935133).

The approve regression run at `0424eab` exposed two harness problems. [Unsigned rejection run 40123115085](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123115085) correctly reported the new per-policy rejection, but the test still expected the old message. The edited-command scanner also attempted intake-log downloads for unfinished runs. It now reuses completed-run correlation and still waits for the number of labels emitted by the client. A fake-HTTP/real-Octokit regression verifies that an unfinished candidate is not queried for logs and cannot satisfy the expected request count. The final suite passed 255 tests with 522 assertions.

Final local approve regression at `5cbaac342f739fc3fb653afd9352a98122d6c215` passed seven scenarios with four CI-only skips. Evidence: [automatic approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123559974), [unsigned command rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123623859), [recheck](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123629559), [command approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123664662), [edited rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123658751), and [replay rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123728505). Removing the completed-run filter also made the new harness regression test fail.

Final local policy-check at `5cbaac342f739fc3fb653afd9352a98122d6c215` passed three cases with four CI-only skips: [ordinary paths](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123803370), [unsigned rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123802107), and [/recheck refresh](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123863156). Final smoke at that head passed six of six: [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123927781), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40123927820), [configuration](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123928305), [human label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123929052), [disabled operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123939150), and [accepted label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40123937247).

## 14. Phase 2 merge implementation

The merge command is exactly `/merge`; an earlier `/merge [sha]` wording in the plan was corrected after the user authorized the no-argument behavior. Server readiness is tied to the accepted comment and pinned head, and every retry rechecks the approval, policies, checks, comment edit history, trust, and current pull request state. Equal-timestamp review and check-run records use their numeric IDs as a tie-breaker so a newer failed record cannot be hidden by an older success.

The merge e2e feature now covers the real client `/merge` caller, a successful squash and receipt, a non-merger rejection, replay, head movement, comment edits and deletion while waiting, the readiness deadline, and an unapproved request with the review ruleset disabled. The ruleset case runs serially and restores the original enforcement in `finally`. The bot scenario temporarily adds the existing test App ID to the testing server's `trust.committers` and `trust.bot_mergers` lists, exercises other-author and mixed-commit rejection plus a bot-owned merge, then restores the original configuration snapshot in `finally`, while refusing to overwrite an unrelated concurrent edit. Do not add the live force-push scenario under the current authorization: the user limited force-pushes to the csm-ci-actions `e2e` branch. Unit tests cover rejection of a force-push event after the command; live coverage needs explicit authorization to force-push a temporary testing-client pull request branch.

Post-merge `main` CI is green: [policy-check](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124151667) passed 7/7 with no skips, [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124183888) passed 6/6, and [approve](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124403552) passed 11/11 with no skips. These runs validate the integrated policy, request-correlation, and approval baseline; they do not yet exercise the new merge scenarios.

Local verification passed 315 tests with 676 assertions, type checking, the generated action build, and workflow lint. Mutation checks detected all 33 tested merge-rule removals and the current-server identity guard; the approve command-kind guard also has a mutation-verified regression. Independent review prompted fresh read and receipt tokens after readiness waits, reconciliation of lost merge responses without repeating the write, preservation of original failures when receipt delivery fails, and explicit separation of `/approve` from `/merge`. Current configuration is reloaded before acceptance and readiness attempts. Failure receipts remain deliverable after a repository is removed or merge is disabled.

The first live merge run, [40126649075](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40126649075), rejected both the rocket reaction and receipt with HTTP 403 when the notification token had only `issues: write`. Notification tokens now also request `pull_requests: write`, using the existing Server App grant. They still omit contents write access; the merge token is minted only after readiness.

The follow-up [40126975033](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40126975033) successfully posted its reaction and failure receipt, but readiness expired because the test fixture required a nonexistent `status-check` from App 15368. The fixture now requires its actual `csm-ci/policy` check from Server App 5455185. Merge still independently evaluates policies against current configuration.

The isolated [notification permission probe](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127493948) returned HTTP 201 for both the reaction and comment, then HTTP 403 with `Resource not accessible by integration` for the merge attempt. The approved test PR remained open at its original head. This verifies that the notification token cannot merge without contents write access.

Local merge e2e at `e0d507a` passed seven scenarios with two CI-only identity skips. Evidence includes [successful squash and receipt](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127214094), [edited comment rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127223234), [moved head rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127218605), [deleted comment rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127236811), [readiness deadline](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127236599), [replay rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127371809), [notification token boundary](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127493948), and [unapproved rejection with the ruleset disabled](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127615750). The ruleset was restored to active and temporary pull requests were closed. The non-merger and configured-bot identity cases remain for main CI.

Local smoke at `e0d507a` passed six of six: [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127751647), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40127751793), [configuration](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127752046), [human label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127753089), [disabled operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127761500), and [accepted label](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40127760212).
