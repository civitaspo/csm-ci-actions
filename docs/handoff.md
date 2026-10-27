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

### 3.2 Environment secret forwarding

The historical no-secret-map run [40099955263](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40099955263) and inherited-secret run [40100014166](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40100014166) motivated the current inheritance requirement. They did not test explicit named mappings. Their workflow success conclusions alone do not establish secret availability. Variables are visible without inheritance.

The later [explicit secret contract probe](#explicit-secret-contract-probe) verified named mappings while retaining the server environment and its deployment policy. This supersedes the conclusion that inheritance is the only supported GitHub forwarding mechanism. Production runtime migration remains separate. Existing inheritance suppressions remain until callers and reusable workflows migrate together.

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

- The attestation spike passed in [testing server run 40117137591](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117137591). Its storage location, predicate shape and verification command are recorded in [release-attestation.md](release-attestation.md).
- A repository that enables `release` must have a strict `release: { build_type: ... }` entry. `cargo` also requires a unique, non-empty list of supported target triples mapped to fixed runner labels in `src/release/runners.ts`.
- **Job separation**
  - **plan:** Read the PR, `.release-version`, tag and release with a Server App contents:read token. Mint contents:write only when a missing annotated tag must be created. Archive tracked source at the merge SHA.
  - **build:** Download only the source archive and run a composite action per `build_type`. Use `permissions: {}` with no secrets, environment, cache or OIDC permission.
  - **publish:** Validate flat regular files, write `SHA256SUMS`, attest every asset with the plan facts, then create or resume a draft. Upload without overwriting. Confirm the exact asset set and digests before publishing. Re-fetch the release and tag and confirm immutability and the merge SHA.
- **Tag ruleset:** Add `release-tags` to testing-csm-ci-client. Forbid creating, updating and deleting `refs/tags/v*`. The Server App is the only bypass. Tagger fields alone do not prove tag ownership.
- **build_type:** none, js-action (check-dist), goreleaser and cargo. The testing client has minimal JavaScript, GoReleaser and Cargo fixtures. Run all four build types against the testing client before calling Phase 5a verified.

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

The issue #72 regression uses the current session's authorization for necessary live e2e to reset only the just-created, harness-owned ephemeral testing-client PR branch to testing-client `main`. It resets while the PR is open because GitHub retains the old head snapshot after an explicit close; GitHub may then close the zero-commit PR automatically. This authorization excludes production branches and shared managed refs such as `release/next` and `csm-ci/repo-settings`; the historical live coverage gaps for existing securefix route and release branches remain. This setup observation does not establish a passing candidate feature suite.

At signed executable candidate `493faf4120cd88d0abf0b6c20e0c0d382491a439`, the closed/shared-SHA [targeted scenario](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40352797222) passed 1/1 without skips. The complete policy-check suite passed 4/8 scenarios with four expected second-identity skips. Its closed/shared-SHA [request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40353803289) left the policy-check state on the shared main SHA unchanged. The local approve suite passed six scenarios and skipped four second-identity scenarios; its remaining `/recheck` scenario stopped on an HTTP 503 with the failing API endpoint unverified. A fresh [automatic approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40356168075) and [explicit `/recheck`](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40356367475) passed the targeted retry 1/1 without skips. After the targeted retry, the client and server runs had drained, the owned test PRs and branches were cleaned up, and the e2e lock was absent.

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

### Post-merge command-edit e2e correction

The first Phase 2 CI run on main passed eight of nine scenarios, including all configured-bot cases, but its edited-comment assertion omitted a valid rejection message. The shared command loader can reject the modified body before the merge-specific edited-comment check. The server correctly rejected `/merge edited` as not exactly one of the supported commands and left the PR open. The e2e assertion now accepts that message as well; runtime behavior is unchanged.

- CI run: https://github.com/civitaspo/csm-ci-actions/actions/runs/40127955610
- Expected server rejection: https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40128085500

The assertion fix at `a143cb384fed1f3e5b8f9827cce1caea0c40d35a` passed all seven locally available merge scenarios (two CI-only bot scenarios skipped) and all six smoke scenarios. The edited-comment case passed at https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129274015. Other merge evidence: normal merge https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129249641, head movement https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129257373, deletion https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129271456, deadline/replay https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129248711 and https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129395283, notification token scope https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129522884, and disabled-ruleset refusal https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129660880.

Smoke evidence: configuration https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129802308, server permissions https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129801858, client permissions https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40129802373, human label https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129803317, disabled operation https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129809639, and accepted request https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40129809905. The previous main smoke run https://github.com/civitaspo/csm-ci-actions/actions/runs/40127975831 also passed.

The independent review found no issue with the correction. All 315 unit tests, typecheck, build with clean committed dist, and workflow lint passed. No rejection rule or runtime behavior changed, so no new mutation case was needed.

### Phase 4 implementation and verification notes

Securefix now packages a manifest and bounded file payloads in the client generation job, then requests server processing from a separate job. The server locates an exact artifact ID using a read token, downloads it into a 12 MiB/1,024-inode temporary filesystem with a two-minute step timeout, revalidates it, and only then mints a write token. PR mode gets pull-requests read access; route mode gets write access to create or repair its PR. All stages honor the reusable workflow's `config-path`.

The existing per-request concurrency key is retained. A repository-wide securefix group would replace unrelated pending GitHub jobs. Conditional Git leases and `createCommitOnBranch(expectedHeadOid=...)` protect competing branch writes without that group. Route sources remain limited to the default branch.

Independent review found missing rejection and e2e coverage, which was added. Local typecheck, all 476 tests (850 assertions), build, and workflow lint passed before live verification. Mutation checks cover helper refusals, operation refusals and retry trust/content checks, route config, and Git source/target leases. File and aggregate size limits have overlapping guards; deleting the whole rule makes their tests fail. Duplicate exact-one-route checks are likewise checked together. Redundant PR-array and root-parent fallback guards are protected by their earlier checked invariants. The parent-directory replacement test deterministically replaces a directory after Git lists the changes, and the conditional-reset tests distinguish a moved ref from a transport failure.

Review also noted the client's path check/read race. The generation job already chooses arbitrary file bytes and has no server write credential or Client App private key. Server-side artifact binding and path checks remain authoritative; no claim of an atomic client filesystem snapshot is made.

Needs the user: a live rewrite of an existing testing-client route branch remains unverified because authorization permits force-pushing only the actions repository's `e2e` branch. Real local bare-Git tests verify both successful conditional reset and rejected stale leases. Live coverage uses fresh route-branch creation and idempotent retries instead.

Post-merge verification of the command-edit correction passed on main `e5ebdfc19f2ee1b667fd33be8b8078c1a37eb964`: [merge](https://github.com/civitaspo/csm-ci-actions/actions/runs/40130018389) passed 9/9 and [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40130129706) passed 6/6, both without skips.

The initial securefix live run wrote the PR change successfully in [40131222067](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40131222067), then the retry [40131349074](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40131349074) exposed an incorrect assumption: the workflow run's nested PR head is updated after the branch moves. It is not an immutable copy of `run.head_sha`. PR binding no longer compares those two SHA fields. The immutable workflow head still binds the artifact, and the fresh current PR head must match it unless the exact verified server-made child and artifact contents satisfy idempotency. Regressions cover both acceptance of that exact retry and rejection of a different parent. Restoring either removed comparison makes its regression fail.

Final local securefix at `4fa1476b78fb09606ac3f31e8e685e9c259568cd` passed 14/14 scenarios with no skips. Evidence includes [PR write and retry](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40131976468), [route creation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132105452), [route PR repair](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132168598), [version-only rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132242840), and [default-branch rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132325311).

The following smoke run exposed a stale fixture expectation in [40132402186](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132402186): its disabled-operation scenario still requested securefix after this phase enabled it. That scenario now requests release, which remains disabled in the testing configuration. Intake behavior is unchanged.

Local smoke at `fb48720b22ff5b04ee81ec61676f4bfe60c75a4e` passed 6/6 with no skips after the fixture correction. Run evidence: https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132514685, https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132516450, https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40132515000, https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132515880, https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40132514780, https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132524997, https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40132515085, https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40132527336. Independent review found no issue with the correction; all 478 tests (853 assertions), typecheck, build with clean committed dist, and workflow lint passed.

The first PR status check [40132605179](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132605179) found a test-only portability issue: the cloned submodule did not inherit the temporary parent repository's Git identity. Its test commit now supplies its own name and email. Running the test with global and system Git configuration disabled reproduced the failure before the fix and passed afterward.

## 15. Release attestation spike

[PR 11](https://github.com/civitaspo/csm-ci-actions/pull/11) merged securefix as `0b4c80a82d908ab87f55d76aa756849d62959c8e` after [status-check](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132736651) passed. Its post-merge [securefix e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132821986) passed 14/14 and [smoke e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132862932) passed 6/6, both with no skips.

The attestation spike passed in [40117137591](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117137591). The [attestation reference](release-attestation.md) records storage, the exact predicate, and the verified command. The server repository stores the attestation using its workflow token, so this choice does not require a new Server App permission. The publish job must supply validated client repository, merge SHA, and tag fields and must not execute client code.

The temporary probe workflow was removed after verification. It used a fixed file and created no release or tag. On the hosted runner, signature verification accepted the expected subject and rejected a modified subject. The separate predicate check matched the expected client and did not match a wrong client. Local Sigstore initialization failed, so local signature verification is not claimed. The final reusable workflow identity, build types, asset publication, and immutable release behavior remain Phase 5a implementation gates.

## 16. Release publishing

Phase 5a adds the release caller and server plan/build/publish jobs. The plan archives tracked source with a read token and creates a missing protected annotated tag with a separate write token. Builds receive no App token, environment, secrets, cache or OIDC permission. Publication validates flat regular files, creates SHA256SUMS, attests every asset with the client/merge/tag predicate, and verifies the immutable release and exact remote asset digests.

The testing client now has immutable releases enabled and active tag ruleset `release-tags` (25798106) protecting `refs/tags/v*` creation, update and deletion, with only Server App integration 5455185 bypassing it. Tagger name/email alone are forgeable; this ruleset supplies creation authority. These settings apply only to the testing repository.

Independent review found that computing `make_latest` before the build allowed an older release to overwrite Latest after a newer release published. The serialized publish job now compares current published versions immediately before publishing; drafts and prereleases never become Latest. A regression covers stale ordering. Another review found that the hosted attestation check could select an earlier dispatch; the verifier now uses a unique request input and exact run title.

GoReleaser publishes only archive entries from its artifact manifest, excluding internal binaries and metadata. Cargo installs its configured target and uses portable executable detection. The e2e suite covers all four build types, all five Cargo targets, immutable retries, check-dist failure, invalid versions, wrong merger, tag/release collisions, and denial by the active tag ruleset. A hosted verifier checks every asset signature and the exact predicate. Live results are recorded below when available.

Mutation checks removed each reachable release rejection guard: planning 14/14, assets 4/4, tag creation 1/1, release configuration 8/8, and publication 14/14 were detected. Three redundant publisher guards remain protected by earlier invariants: the typed create result is defined, release ownership validation already checks its tag, and the plan schema already validates semver. Publisher tests distinguish manifest length from digest mismatches and cover draft creation, resumption and completed retries.

The first live publish attempt [40134884494](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40134884494) confirmed planning, protected tag creation, isolated source build and attestation, then GitHub rejected the zero-byte SHA256SUMS asset (`size must be greater than or equal to 1`). An empty asset list now contains one newline; its digest and attestation are still verified. A regression checks the exact bytes and idempotent preparation. The closed-PR client run [40134875302](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40134875302) also returned an empty `pull_requests` list. E2E correlation now uses the fixture's explicit PR-number run title. The stopped harness's owned branch and lock were removed; no open test PR remained and server config was restored.

Review found that Cargo's default tar metadata changed between rebuilds even when binary contents did not. Packaging now sorts entries and fixes tar ownership, modes and timestamps plus gzip header metadata. A two-pass integration test changes input creation order and mtimes and compares the complete output bytes. Table-driven tests cover empty input, symlinks and invalid invocation; removing each of those three guards makes its test fail. The isolated build's synthetic Git commit also uses the verified source commit timestamp, and the GoReleaser fixture opts into stable build/archive metadata. These measures remove packaging-induced variation; arbitrary time-dependent client binaries are still rejected on a digest-changing retry.

The GoReleaser build in [40135876140](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40135876140) failed because the isolated Git repository had no origin URL. Source preparation now supplies the validated client repository URL without credentials. It also explicitly selects Bash so the same preparation script runs on Windows Cargo runners. Local verification after these changes passed 568 tests (991 assertions), typecheck, build with unchanged dist, and workflow lint.

The Cargo matrix run [40136076997](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40136076997) passed both Linux and both macOS targets. Windows source preparation failed because PowerShell interpreted the Bash environment reference as an empty tag; the explicit Bash shell fixes that path. The foreign-draft scenario [40137314669](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40137314669) then exposed that the read-token planning check cannot see a draft through the published-release-by-tag endpoint. The publisher now searches the paginated release listing with its existing write token when a published tag lookup returns 404, validates ownership before writes, and resumes only a server-owned draft. The live scenario switches to a successful source-only build for the retry so it reaches and verifies that authoritative publication check. See the [release API visibility contract](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name).

Draft lookup regressions cover owner-authored and ambiguous drafts before any write, server-owned draft resumption after a by-tag 404, and list API failures. Mutations removing the listing fallback, ownership check, 404-only handling and ambiguity guard all failed their tests. Local verification passed 572 tests with 999 assertions, typecheck, generated build and workflow lint.

The owner tag-creation probe returned a generic 422 `Reference update failed`, rather than naming the protection rule. Its [rule suite 4705098509](https://api.github.com/repos/civitaspo/testing-csm-ci-client/rulesets/rule-suites/4705098509) confirms the active `release-tags` creation rule rejected that exact ref and target SHA. The e2e assertion now checks this authoritative rule evaluation instead of matching GitHub error prose.

The follow-up GoReleaser run [40138581683](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40138581683) reached Git validation but failed because its `--clean` removed the shared fixture's tracked JavaScript `dist/action.js`. The GoReleaser scenario now removes that JavaScript-only asset in its release PR. The normal GoReleaser clean/validation behavior is unchanged. Later JavaScript rejection cases explicitly add their stale dist file, and fixture synchronization restores the baseline before the next suite.

A local isolated-fixture probe using GoReleaser 2.18.2 and Go 1.26.10 completed `release --skip=publish,sign,announce --clean` after omitting the tracked JavaScript output, producing the expected `testing-csm-ci-client_1.2.3_linux_amd64.tar.gz` archive and artifact manifest. Hosted verification uses the pinned GoReleaser 2.19.0.

The corrected Cargo matrix passed all five targets, immutable publication and every asset's hosted attestation verification in [40138776711](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40138776711) and [40138922111](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40138922111). The completed-release retry also preserved exact asset digests in [40139095698](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40139095698) and [40139188989](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40139188989).

A subsequent GitHub API 503 interrupted the tag-collision scenario and left its merged test branch behind, preventing later scenarios from starting. After checking that `release/next` still pointed to PR 277's exact head, the owned branch was removed. The harness lock had already been released. This was an infrastructure interruption; it does not establish the skipped scenarios' results.

Targeted verification at `9d4c2a33f549c023e2c8dc86621f6155058f61d0` then passed GoReleaser publication [40139834906](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40139834906) with hosted attestation verification [40139936850](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40139936850), and foreign-draft refusal [40140183695](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140183695) without adding assets. During iteration, run failed and directly related scenarios with `--scenario`; run the full feature and smoke after those pass for the final PR gate.

Final local release verification at `73dd466622bdf406d365e90fbc1b2dfa5401eafa` passed 12/12 scenarios with no skips. Published releases and hosted attestation checks passed for [none](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140525605) / [verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140600156), [JavaScript](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140745741) / [verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140819632), [GoReleaser](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140964601) / [verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40141060978), and [all five Cargo targets](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40141223573) / [verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40141347231).

The same run verified [disabled operation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40140349779), [immutable replay](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40141598832), [stale dist](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40141803977), [tag collision](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142209326), [foreign draft](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142464258), [invalid version](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142683146), [wrong merger](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142815248), and [active tag protection](https://api.github.com/repos/civitaspo/testing-csm-ci-client/rulesets/rule-suites/4705571174).

Final local smoke at the same commit passed 5/5 scenarios with no skips: [server configuration](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142884077), [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142883818), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40142883864), [human label cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142884883), and [accepted client request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40142894801). Release's disabled-operation case is now covered in its own feature suite.


## 17. Release tag visibility follow-up

PR 14 merged Phase 5a as `9d42d213d4db8ec454b54052b21b98d3435b8229`. Its post-merge [release e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40143101984) passed 11/12, while [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40143103996) passed. The stale-dist scenario failed before its build because [tag creation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40144510431) succeeded but its immediate verification GET returned 404. A subsequent read confirmed annotated tag `936c3e7f0565f3d69b78d644d97d9fcc64d6516a` for `v1.0.1792885853821`, the correct Server bot identity and target `c869694a1e8c7f5606d623c413e464fa9268d369`.

A regression reproduces that exact response sequence. Verification now retries only a missing ref, with four total reads and 250/500/1,000 ms waits. The 422 race path uses the same bounded verification. It never retries writes or suppresses identity mismatches and unexpected API errors. Release-pr remains on its separate feature branch until this follow-up passes.

Local release verification at `6cd73125cb5e55d24d1e9d0c84ccee592a798280` passed 12/12 with no skips. The targeted stale-dist regression passed in [40145824822](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40145824822), and the full suite repeated it successfully in [40147309281](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40147309281). The full suite also verified [Cargo publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40146765087), [immutable replay](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40147111113), [tag collision](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40147664613), and [foreign release rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40147884543).

The initial smoke run passed 4/5; a connection reset (`ECONNRESET`, HTTP 500) interrupted server-check dispatch. A full retry at the same commit passed 5/5 with no skips: [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40148375872), [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40148375621), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40148376122), [human label cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40148376655), and [client request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40148385250).

## 18. Release PR generation

[PR 17](https://github.com/civitaspo/csm-ci-actions/pull/17) merged the tag visibility follow-up as `92fd1f2f09379987a7a8a0d39e7f95cfcd551bcf` after [status-check](https://github.com/civitaspo/csm-ci-actions/actions/runs/40148505196) passed. Its post-merge [release e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40148584310) passed 12/12 and [smoke e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40148586386) passed 5/5, both with no skips.

Phase 5b generates release files in a separate client job, then submits the existing securefix route. A typed preparation action preserves manifest formatting and updates only supported root version fields; shell-based manifest rewriting was rejected because it could silently rewrite dependency versions or non-version lines. The generation job has only contents read permission. The request job forwards only the existing Client App key to the securefix reusable workflow.

The pinned git-cliff 2.14.2 binary inferred `v1.0.1` from a local `v1.0.0` tag followed by a `fix:` commit and generated the changelog. Running the preparation action with that binary also updated the testing client's package.json, Cargo.toml and Cargo.lock fixtures correctly. Its downloaded archive digest matched the release asset's published SHA-256.

Independent workflow/e2e review found no issue. Preparation review found a TOML multiline-string ambiguity: a version-shaped description line could be mistaken for a root version. The supported input format now explicitly rejects triple-quoted TOML strings. Regression cases cover both basic and literal multiline strings; removing the guard fails both. The preparation tests also cover exact formatting, dependency preservation, invalid inputs, unsafe files, CLI arguments and failure propagation. Twenty-two earlier mutation checks detected rule removals, lockfile identity changes, removal of `--no-exec`, and dropped CLI failure reporting. After the review fix, all 612 tests (1,047 assertions), typecheck, build and workflow lint passed.

Needs the user: a live changed-content rewrite of an existing `release/next` branch is still excluded by the authorization to force-push only the actions repository's `e2e` branch. The release-pr suite checks initial creation, exact repeated generation updating the existing PR metadata, automatic version inference on a default-branch push, invalid-version refusal, and non-default-branch skipping. The repeat fixture uses a changelog template without wall-clock timestamps so it takes the exact-content retry path. Changed-content reset behavior remains covered by the existing real local Git lease tests; no live rewrite is claimed.

The first live release-pr run generated and opened the expected PR ([client](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40151082716), [server](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40151102721)), but its CHANGELOG omitted the requested version. Reproducing against the actual testing-client history with git-cliff 2.14.2 showed that default conventional-commit filtering excluded all recent fixture commits. The fixture now sets `filter_unconventional = false`, retaining conventional parsing for version inference while including the harness's nonconventional commits in its changelog. The same real-history probe then included the exact explicit version. Product generation still respects each client's git-cliff configuration.

The full suite passed generation, exact retry, inference and invalid-version rejection. Its non-default dispatch [40151788496](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40151788496) correctly skipped both jobs; GitHub reports the workflow conclusion as `skipped`, not `success`. The e2e expectation now matches that observed conclusion and still verifies that every job was skipped and no artifact was created.

The targeted retry [40151883060](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40151883060) also concluded `skipped`, but its immediate jobs snapshot did not yet satisfy the completed-job assertion. A later direct jobs API read returned both `generate` and `request` as skipped. The scenario now waits for both named jobs to have conclusions before asserting that every job skipped; actual non-skipped conclusions still fail.

Final local release-pr verification at `21dd68ce3d388937c18dde77403ab7b823eff42c` passed 4/4 with no skips: [explicit generation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152073852), [exact repeated generation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152144076), [push version inference](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152226536), [invalid-version refusal](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40152271561), and [non-default skipping](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40152296851). The targeted non-default retry also passed in [40151993262](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40151993262). Independent review accepted both fixture corrections and the bounded job-visibility wait.

Final local smoke at the same commit passed 5/5 with no skips: [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152331064), [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152331022), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40152331081), [human cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152331886), and [client request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40152340478). The final local gates passed: mise install, frozen install without scripts, all 617 tests (1,058 assertions), typecheck, build with unchanged committed dist, and workflow lint.

## 19. Repository settings reconciliation

[PR 21](https://github.com/civitaspo/csm-ci-actions/pull/21) merged release-pr as `23fe9cbc0f99b402eed2813854f6719d43f9a43e` after [status-check](https://github.com/civitaspo/csm-ci-actions/actions/runs/40152425563) passed. Its post-merge [release-pr e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40152507012) and [smoke e2e](https://github.com/civitaspo/csm-ci-actions/actions/runs/40152508687) both passed. [PR 22](https://github.com/civitaspo/csm-ci-actions/pull/22) recorded the Phase 6 decisions below in the plan first.

### Design

Phase 6 uses one global `repo_settings` block, the four fixed S6 rulesets, and a separate managed-file PR operation. A per-target reconciler owns observation and application, avoiding a general serialized plan/executor layer. The settings schema allows only merge-related booleans, with the merge methods fixed to squash only. Managed files are a map of safe literal paths to text, supplied by the trusted server configuration. A fixed template catalog was rejected because the specification does not prescribe one. Repository entries have no policy overrides.

Tokens come only from the official action. Discovery uses a metadata-only installation token for the server's owner. Each target gets a contents and pull-requests read token for the activation preflight and managed-file inspection, an `administration: write` token for reading and changing settings, rulesets and immutable releases, and a contents and pull-requests write token for managed files, with workflows write added only for workflow paths or the branch reset. The server job runs last, after the client wave finishes; a final review showed that requiring every client to succeed let one repository writer stall the server's repair by poisoning `csm-ci/repo-settings`, so it now runs unless the wave was cancelled, and each target applies settings before managed files.

The S4 history proof moved from securefix into `src/lib/server-owned-history.ts` and is shared by the securefix route and managed files. It now paginates the comparison, requires a merge base, and checks that the single-parent chain links the merge base to the branch head.

### GitHub behavior verified

- `GET /repos/{owner}/{repo}/rulesets/{id}` omits `bypass_actors` for a token without write access to the ruleset, as the REST documentation states. With the read-only token every bypass looked empty, and the repeated dispatch [40155267064](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40155267064) rejected the ruleset it had just created. Inspection now reads with the administration token, and a response without the field is rejected instead of being read as empty.
- GitHub stores `{"type":"update","parameters":{"update_allows_fetch_and_merge":false}}` as `{"type":"update"}`. Sending the parameter made every run see drift ([40155746981](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40155746981)). The fixed definition now uses GitHub's stored form.
- A ruleset PUT without `enforcement` keeps the current value. A probe on testing-csm-ci-client (ruleset 25806815, 2026-10-25) created a disabled ruleset on a non-existent branch, updated it without `enforcement`, read `disabled` back, and deleted it. Every repair that does not activate `controlled-merges` uses this, so a stop set during the run survives.
- An installation token with `administration: write` sees the merge settings fields of `GET /repos/{owner}/{repo}`.

### Verification

- Local feature e2e at `fb08baf5b24e1deb70602ee2fb0a0e8343f55957` passed 1/1: the [initial dispatch](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157257046) repaired four settings and three rulesets, activated `controlled-merges` after the preflight, and opened the managed PR; the [repeated dispatch](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157306142) found no drift and skipped the approver token, both apply stages and both managed write tokens; the [schedule](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157347571) repaired a drifted bypass on the stopped `controlled-merges` and left it disabled; the [server schedule](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157385133) created three rulesets, enabled immutable releases and did not create `controlled-merges`. The scenario restored both repositories' settings, rulesets and immutable-release state and removed its branch and PR.
- Local smoke at the same commit passed 5/5: [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157429221), [server permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157428981), [client permissions](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40157429121), [human cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157430238), and [client request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157437984). An earlier smoke failed because the new server fixture lacked the `unpinned-uses,secrets-inherit` ignore comments the other fixtures carry ([40157144526](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157144526)).
- The shared history proof was regression-tested at `fb16e062c699e7655f822215fbc23411f4fa3a99`, after which only repo-settings code, docs and fixtures changed: securefix 14/14 (for example the [route retry](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40156694706) and [default-branch refusal](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40156821812)) and release-pr 4/4 (the [explicit version](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40156893200), its [repeat](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40156971271), and the [push inference](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40157052723)).
- Mutation checks: 45 core configuration and context mutants (43 killed, two redundant clauses removed); 24 S4 history and managed-file mutants; and 28 more for the review fixes and new rejection rows. Every mutant failed a test, except the empty-page pagination guard, which hangs instead of failing and was detected by timeout. Three redundant clauses were removed: the comparison count check and the page-one duplicate check, both implied by the parent-chain proof, and an unreachable preflight branch.
- An interrupted mutation run in the previous session had left `if (false)` in place of the pagination guard, and its next run treated that as the original. The guard was restored before any commit. Mutation scripts must time out each test run and restore from a copy taken before the first mutant.

### Needs the user

- The testing approver App is installed only on the testing client. Activating `controlled-merges` on the testing server requires installing it there with its existing contents-write permission. Production needs the same installation on `csm-ci-server`.
- The server's own merge caller needs the Client App repository variables and key, as for other clients.

### Not verified live

- Changing the content of an existing `csm-ci/repo-settings` branch resets it with a Git lease. Only creation and exact repetition ran live, because force-pushes in the testing repositories are not authorized. Unit and local Git tests cover the reset.
- Whether GitHub requires workflows write for that reset is unknown. The workflow mints it for every reset to fail safe.
- After that reset, GitHub may update an open managed PR's head asynchronously, or close the PR. The PR step then rejects with "managed files pull request head does not match the branch head" and the next run should recover. Watch the first changed-content update.
- The e2e fixture calls the per-target workflow with the schedule mode. The cron trigger and the outer workflow's discovery of every installed repository were not exercised.
- Activating `controlled-merges` on the server, which depends on the approver installation above.

## 20. Final report: first release through Phase 6

Phases 2 to 6 are merged. Phase 7 is the user's runbook in [cutover.md](cutover.md); nothing was executed in production. Every merge below passed `status-check`, and each feature's CI e2e and smoke ran from `main` right after the merge.

### Merged pull requests and post-merge CI e2e

| PR | Work | Post-merge CI e2e from `main` |
|---|---|---|
| [6](https://github.com/civitaspo/csm-ci-actions/pull/6) | Request timeout and bounded retry of safe reads | [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40118182203), [approve](https://github.com/civitaspo/csm-ci-actions/actions/runs/40118332288) |
| [7](https://github.com/civitaspo/csm-ci-actions/pull/7) | Parallel feature scenarios with exact request correlation | [approve](https://github.com/civitaspo/csm-ci-actions/actions/runs/40121818143), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40121839872) |
| [8](https://github.com/civitaspo/csm-ci-actions/pull/8) | Phase 3 policy-check and sensitive paths | [policy-check](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124151667), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124183888), [approve](https://github.com/civitaspo/csm-ci-actions/actions/runs/40124403552) (11/11 with the CI-only untrusted-committer cases) |
| [9](https://github.com/civitaspo/csm-ci-actions/pull/9) | Phase 2 merge | [merge failed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40127955610) on an e2e expectation, fixed in PR 10; [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40127975831) |
| [10](https://github.com/civitaspo/csm-ci-actions/pull/10) | Merge e2e expectation for edited comments | [merge](https://github.com/civitaspo/csm-ci-actions/actions/runs/40130018389), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40130129706) |
| [11](https://github.com/civitaspo/csm-ci-actions/pull/11) | Phase 4 securefix | [securefix](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132821986), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40132862932) |
| [13](https://github.com/civitaspo/csm-ci-actions/pull/13) | Release attestation spike contract | [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40133607613) |
| [14](https://github.com/civitaspo/csm-ci-actions/pull/14) | Phase 5a release publish | [release failed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40143101984) on tag visibility delay, fixed in PR 17; [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40143103996) |
| [17](https://github.com/civitaspo/csm-ci-actions/pull/17) | Release tag visibility follow-up | [release](https://github.com/civitaspo/csm-ci-actions/actions/runs/40148584310), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40148586386) |
| [21](https://github.com/civitaspo/csm-ci-actions/pull/21) | Phase 5b release-pr | [release-pr](https://github.com/civitaspo/csm-ci-actions/actions/runs/40152507012), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40152508687) |
| [22](https://github.com/civitaspo/csm-ci-actions/pull/22) | Plan: Phase 6 decisions | Documentation only; covered by the PR 23 runs |
| [23](https://github.com/civitaspo/csm-ci-actions/pull/23) | Phase 6 repo-settings | [repo-settings](https://github.com/civitaspo/csm-ci-actions/actions/runs/40157590133), [smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40157767523) |
| [24](https://github.com/civitaspo/csm-ci-actions/pull/24) | Phase 7 cutover runbook | Documentation only |

### What each phase verified

- **API robustness (PR 6).** A hung request times out, 502/503/504 and network errors retry only for safe reads, and writes never retry. Section 11.
- **Parallel e2e (PR 7).** Scenarios of one feature run concurrently, matched to their own server runs by request identity. Section 12.
- **Phase 3 policy-check.** `csm-ci/policy` is bound to the head, sensitive paths need an approver marker bound to author, state and head, and approve and `/recheck` refresh the check. Section 13.
- **Phase 2 merge.** `/merge` takes no argument, pins the head it observed, waits for approval, policy and required checks, and rejects edited, stale, replayed or force-pushed requests. Section 14.
- **Phase 4 securefix.** PR mode is bound to exactly one PR whose base is default; route mode is bound to its workflow, event and default head, with path, size, symlink and version-only limits; writes are compare-and-swap. Section 14.
- **Phase 5a release.** The server verifies the merge, creates the tag (only the Server App may), builds without credentials, attests assets, and publishes an immutable release; check-dist mismatches abort. Sections 15 to 17.
- **Phase 5b release-pr.** git-cliff generation goes through the securefix route; an exact repeat preserves the PR and commit. Section 18.
- **Phase 6 repo-settings.** Drift repair, a managed PR, a no-op second run, a schedule that keeps a stopped `controlled-merges` stopped while repairing it, and a server schedule that never creates it. The shared S4 history proof was regression-tested with securefix and release-pr. Section 19.

### Decisions and reasons

- `/merge` and `/approve` take no argument. A short SHA can be brute-forced and a full one is impractical to type; the server pins the head it observed and rejects later pushes.
- `/approve` approves trusted commits only (section 8 item 1 left as a proposal), because the commit date cannot prove when a commit was pushed.
- Sensitive-paths circularity (section 6.3): `/approve` first validates the command and every other policy, then writes the approval pinned to the head with the source comment marker, then re-evaluates all policies. Later evaluations use that persisted head-bound marker. Automatic approval and `/recheck` never create human approval evidence, so no evaluation path bypasses the policy.
- Phase 6 uses one per-target reconciler instead of a generic plan/executor, a global `repo_settings` block, and a literal-path managed-file map instead of a template catalog.
- The administration token also reads repository state, because GitHub hides ruleset bypass actors from read-only tokens.
- The `controlled-merges` preflight runs only for activation, so steady-state dispatches are not blocked by queued auto-merges. Every repair that does not activate it omits enforcement, so a stop set mid-run survives.
- `review-and-checks` does not require up-to-date branches, because `/merge` never updates them.

### Needs the user

1. Install the testing approver App on `testing-csm-ci-server` to verify `controlled-merges` activation on a server. Production needs the same on `csm-ci-server`.
2. Provision the Client App repository variables and key on the server repository, so the server's own merge caller works.
3. Every Phase 7 step in [cutover.md](cutover.md): repository and App creation, credentials, caller migration and retiring securefix-server.
4. Renovate PRs 2, 3, 12, 15, 16, 18, 19 and 20 were left untouched. Dependency updates need a rebuilt `dist/` (section 8 item 2).

### Not verified

- Live changed-content reset of an existing `release/next` or `csm-ci/repo-settings` branch. Force-pushes in the testing repositories were not authorized; unit and local Git lease tests cover it. Whether that reset needs workflows write is unknown; the managed-file reset mints it to fail safe.
- The cron trigger of repo-settings and the outer workflow's discovery across every installed repository; e2e dispatches the per-target schedule branch directly.
- `controlled-merges` activation on a server (item 1 above).
- The 60-minute command deadline and dismissal by a push during approval are unit-tested only.

### Process incidents

- An interrupted mutation run left `if (false)` in place of the comparison pagination guard in the uncommitted Phase 6 source, and a later run saved that text as its baseline. It was found by review and restored before the first commit. Section 19 records the mutation-script rule this led to.
- While reviewing the cutover runbook, a review subagent made read-only `GET` requests to `civitaspo/securefix-server` and one production client repository. Both are outside the three repositories this work was authorized to touch. It wrote nothing. The brief forbade GitHub writes but did not restrict reads to the authorized repositories. Only generic lessons from those reads went into [cutover.md](cutover.md); it names no production repository, ruleset or App ID.

## 21. Single-action securefix client

The user decided that the securefix client should match the shape of `csm-actions/securefix-action`: one step in the job that generates the changes. [PR 27](https://github.com/civitaspo/csm-ci-actions/pull/27) changed the plan first. The implementation makes the client action, now `actions/client/securefix` (the server-side action moved to `actions/server/securefix`), a composite action that packages, uploads with `actions/upload-artifact`, mints the Client App token with `actions/create-github-app-token` and creates the label. It removes `client-securefix.yml`, migrates `client-release-pr.yml` to one job, and runs the route fixture through the real action. Earlier sections that describe a separate packaging job and a request job (sections 4, 14 and 18) are historical.

The action fails unless the workspace is at the run head, because on `pull_request` a checkout without a ref is the merge commit and the server writes whole files onto the head. It skips fork pull requests with a notice instead of failing their checks. The Client App key is now present in the job that runs fix tools, which the plan accepts under S7 and S1.

The first live run showed that e2e correlation depends on the exact client log line `created label <name> (<description>) in <server>`; dropping the description broke four scenarios (client runs [40170768402](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40170768402), [40170857604](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40170857604), [40171093927](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40171093927) and [40171489809](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40171489809)). `requestLogLine` now builds the line and a unit test pins it. One of those runs still created its label, so the server applied the route retry after the scenario's cleanup and left `e2e-securefix-route` with an open PR, which made the next run's precondition fail. Both were e2e-owned (verified Server App commit) and were removed before the rerun.

## 22. Action layout and client interfaces

The implementation now follows the Layout introduced by PR 28. Public actions live one level below `actions/client` or `actions/server`; JavaScript entry points and bundles use side-prefixed names. The generic request action is removed. Approve, merge, policy-check and release-publish filter their own events, mint a Client App token scoped to the server repository, and create a fixed-kind request label. The exact request log line and reusable-workflow job names remain stable for e2e correlation.

Release preparation installs the pinned git-cliff version, generates changes and submits them through the shared securefix implementation within one client action. Its wrapper supplies checkout and inputs. The composite repeats the securefix upload/token steps because nested local action references resolve in the caller workspace, not beside the outer action. Validation, packaging and request code remain shared. The release-build action selects the existing build implementation through `build-type`; builds retain their separate job without permissions, secrets or an environment.

### Verification

Local checks passed: tool installation, frozen dependency installation, typecheck, 868 tests, build, clean committed bundles and jactionlint. Mutation checks covered the new client event/argument rules, release-build selection and release-prepare change gates. An independent review found a stale release workflow test, which was updated and passed in the complete suite.

The initial signed head was `63a08a53e4cbfe348b839cbd7a1d5f7abcbca7bf`. The release-prepare completion correction is signed head `9eddb0a6ea5a11d75bdd5957de8c126dd366c608`. GitHub verified both signatures. All eight feature suites completed at the initial head. Release-pr and smoke were then repeated at the correction head; the other operations were unchanged by that correction. PR 30 was squash-merged as `bb0e6ffc4fea5344d35d3483caab017396120910`; the post-merge CI evidence below exercises that revision.

| Feature | Passed | CI-only skips | Representative live runs |
| --- | ---: | ---: | --- |
| approve | 7 | 4 | [40178692806](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40178692806), [40178827087](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40178827087) |
| merge | 7 | 2 | [40178907081](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40178907081), [40179321656](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40179321656) |
| policy-check | 3 | 4 | [40179469046](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40179469046), [40179520035](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40179520035) |
| securefix | 14 | 0 | [40179590413](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40179590413), [40180082229](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40180082229) |
| release | 12 | 0 | [40180138159](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40180138159), [40182651732](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40182651732) |
| release-pr | 4 | 0 | [40183300851](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40183300851), [40183560295](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40183560295) |
| repo-settings | 1 | 0 | [40182965065](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40182965065), [40183125187](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40183125187) |
| smoke | 5 | 0 | [40183587908](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40183587908), [40183598173](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40183598173) |

Release verification covered all four build types, asset attestations, immutable-release replay, stale bundles, tag collisions, foreign releases, invalid versions and owner-merge rejection. Repo-settings verification restored both testing repositories after the scenarios. The post-merge CI suites passed all ten cases skipped locally, with no skips. No production cutover was executed.

### Post-merge CI e2e

| Feature | Run from main |
| --- | --- |
| approve | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40183837034) |
| merge | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40184091141) |
| policy-check | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40185055313) |
| securefix | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40185276320) |
| release | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40185838104) |
| release-pr | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40188328480) |
| repo-settings | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40188620990) |
| smoke | [Passed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40188838690) |

## 23. Managed-files-only bootstrap specification

The Phase 6 plan now specifies an explicit `managed-files-only` dispatch mode. It distributes configured files through the existing managed PR without obtaining administration or approver capability tokens, inspecting administrative state, or changing repository settings, rulesets or immutable releases. Target selection, S4 history verification, path limits and expected-head checks remain required. Normal reconciliation retains its activation preflight and emergency-stop behavior.

Bootstrap proceeds from user-provisioned Apps and credentials to file distribution, review and merge through the repository's existing process, caller and check verification, and then normal reconciliation. The global literal map remains unchanged; per-repository templates and server-specific distribution are outside this change. This section records a specification change, not an implemented mode.

Local installation, frozen dependencies, typecheck, all 868 tests, build with clean bundles and jactionlint passed. Independent specification review found no blocking issue. Smoke passed all five scenarios at signed, pushed head `b52f6eecc26fbfb54367e721c0804cd2bc3f1091`: [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40188267793), [server request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40188277257), [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40188268177). The evidence-only handoff update does not change executable files. No rejection rule changed; implementation must add message assertions and mutation checks for the new guards.

PR 31 was squash-merged as `b35ad94befe8cc4005269cf6194b9943f845bf65`. Its [post-merge CI smoke](https://github.com/civitaspo/csm-ci-actions/actions/runs/40189040890) passed all five scenarios without skips.

## 24. Independent Phase 6 review

The review covered repo-settings, the shared server-owned history proof, the securefix client, token boundaries and e2e cleanup against the plan after the layout change. Separate reviewers examined security boundaries, history and managed branches, and restoration. The table below resolves every risk in sections 5 and 6 of the preceding implementation handoff.

### Findings and decisions

| Risk or concern | Decision and reason |
| --- | --- |
| 1. Shared Server App key | Retain the S7 trust model. Target tokens are scoped to one repository, but a compromised server job with the key can mint broader App permissions. Avoiding an administration token in bootstrap mode does not isolate the key. |
| 2. Live approver capability token | Retain token issuance as the capability proof during activation. Subsequent action inputs receive the App slug, not this token; the official token action revokes it during cleanup. No reliable replacement proof has been established. |
| 3. Trusted internal event mode | Retain the target helper for trusted workflows on the server default branch. The pinned configuration, server/default-ref checks and schedule-to-dispatch rejection still apply. Direct callers can bypass outer ordering; write access to the trusted server branch is already inside S1. |
| 4. Poisoned managed branch | Fail closed. Untrusted commits, paths or ambiguous PRs require operator investigation; they are never overwritten to restore service. Administrative repair precedes managed-file inspection, and one client failure does not stop server reconciliation. |
| 5. Compare pagination before trust checks | Verify each page before requesting another. An untrusted first page must stop further pagination. Preserve final head, linear-history, changed-file completeness and duplicate checks. Do not introduce an arbitrary history limit or rely on the earlier handoff's unsupported approximate compare cap. |
| 6. Caller presence without ref provenance | Retain the S1 decision. Preflight checks the caller path, event, inherited secrets and lack of a job condition. It intentionally does not establish the referenced action revision's provenance. |
| 7. Existing-branch reset | Retain conditional Git leases and expected-head checks. Live changed-content resets remain outside the authorized tests. GitHub PR-head convergence after a reset and the exact workflows permission requirement remain unverified. Re-dispatch after convergence; investigate persistent mismatches. |
| 8. Recursive omission of metadata keys | Accept as compatibility debt for the current fixed rulesets. No current managed parameter depends on nested `id`, `_links`, `source` or `source_type`. Review this comparison before adding ruleset parameters. |
| 9. Extra approval for unattributed changes | Keep PR 26's `false`. The plan requires one approving review and stale-approval dismissal; it does not require this additional condition, whose GitHub semantics remain unverified. |
| 10. Client key in tool jobs | Retain the S1/S7 decision for securefix and release preparation. The minted token has issues write on the server only. Server validation independently reads the authoritative request and repository facts. |
| 11. One installation's discovery | Retain the documented scope: configured repositories must also be visible in the server owner's installation. A different owner's repository is not automatically managed. |
| Server after client failure | Keep PR 26. Failed client repair must not prevent server repair; cancellation still stops the server wave. |
| Ruleset restoration ownership | Record IDs returned by successful creation in the correlated server run. Cleanup may delete only those recorded IDs, never an unknown ruleset merely because its managed name was absent from the snapshot. Preserve unknown IDs and report recovery needs while attempting the remaining restoration steps. |
| Managed branch without a PR | Keep cleanup's refusal. A verified commit alone does not establish a matching PR and unchanged current head. Operator recovery must establish ownership before deletion. |
| Failed server restoration | Preserve the failure and recovery diagnostics. Leftover protections can prevent the later fixture-config restore; do not claim every partial failure repairs itself. |
| Pending-run replacement | Retain the existing concurrency group and document its limitation: a later queued run can replace a pending dispatch despite `cancel-in-progress: false`. Check the final run and dispatch again when necessary. |
| Mutation interruption | Copy baseline sources once before the first mutant, impose a timeout on each run and restore unconditionally. Never use a potentially mutated working file as the next baseline. |
| Dependency bundles and test rulesets | Dependency updates still require regenerated committed bundles. Testing repositories' pre-existing rulesets are restored rather than permanently replaced. |

A further functional defect was reproduced against the actual managed-file inspector and a local Git repository: a retained managed branch can be an ancestor of default, still contain the desired files, and have no unmerged commits after default later drifts. Content equality alone then selects a PR-only retry, which cannot produce a diff. The branch must instead be rebuilt from the current default head under the existing lease. An ahead branch with the expected content keeps its existing idempotent behavior. Securefix's repeat check already requires the exact source-parent binding and does not share this defect.

The managed-files-only implementation follows section 23's boundary. The literal map and ordinary managed PR remain the distribution mechanism; it does not merge the PR, provision credentials or enable protections.

### Verification boundaries

Live verification still excludes changed-content resets of existing managed branches, actual cron triggering, full unselected discovery, server controlled-merges activation, deploy-key bypass repair and same-second GitHub comparison ordering. Missing or inaccessible creation evidence must leave a newly observed ruleset intact and report the gap. A missing creation response after a successful write cannot be safely reconstructed from a ruleset name alone.

### Local verification

Tool and frozen dependency installation, typecheck, all 915 tests, build and jactionlint passed. All 35 targeted mutants were detected by failing assertions; the runner restored its original source copies after every mutant. Coverage includes operation and event guards, action-entry validation before configuration/token inputs, workflow token gates, history completeness and early trust, ancestor recovery, creation receipts and cleanup ownership. The empty-page fixture rejects an unexpected third comparison, so a removed pagination guard produces an assertion failure instead of relying on a process timeout.

Both original bug reproductions now pass: the first untrusted history page is rejected after one comparison call, and an ancestor managed branch requires a lease-protected rebuild even when its files match. A local Git repository establishes the ancestor/default-drift shape. These are local proofs, not a claim that a live changed-content reset was performed.

Review also exposed inconsistent handling of an explicitly empty mode: the action normalized it to `reconcile`, while workflow conditions used the raw input. Workflows now consume the validated mode output for target calls and administrative-stage gates. This does not weaken the rejection of managed-files-only execution on a schedule or another non-dispatch event.

### Signed-head live verification

GitHub verified signed head `baa97c03490ad9f5b79aa01ce40ef1a534978139`. All affected suites and smoke passed sequentially without skips. The later handoff evidence update changes no executable files.

| Feature | Passed | Representative runs |
| --- | ---: | --- |
| repo-settings | 1/1 | [initial repair](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190158626), [bootstrap](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190367454), [bootstrap repeat](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190408871), [expected normal-mode rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190449100) |
| securefix | 14/14 | [PR update](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190527394), [route retry](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190858236), [default-branch rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40190996611) |
| release-pr | 4/4 | [explicit version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40191049390), [repeat](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40191114132), [inferred version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40191195191) |
| smoke | 5/5 | [client](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40191332219), [server](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40191341087), [configuration check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40191332593) |

The repo-settings scenario verified client repair and idempotency, preservation of a disabled controlled-merges stop, server schedule-mode reconciliation, managed-files-only bootstrap with a missing caller, stable PR reuse, skipped administration and approver stages, unchanged administrative state, and normal-mode rejection before applying settings. Both testing repositories passed snapshot restoration checks. The scheduled path was dispatched with schedule mode; actual cron triggering remains unverified. The normal-mode rejection run is an expected failure tested by the passing scenario.

### Post-merge CI e2e

PR 32 was squash-merged as `3a5e26bbbc5f2957a42be86d81862d567ca944d0`. Each affected suite and smoke ran from `main`, one at a time, against that merged revision. All passed without skips.

| Feature | Passed | CI run |
| --- | ---: | --- |
| repo-settings | 1/1 | [40191607802](https://github.com/civitaspo/csm-ci-actions/actions/runs/40191607802) |
| securefix | 14/14 | [40191970499](https://github.com/civitaspo/csm-ci-actions/actions/runs/40191970499) |
| release-pr | 4/4 | [40192550330](https://github.com/civitaspo/csm-ci-actions/actions/runs/40192550330) |
| smoke | 5/5 | [40192854354](https://github.com/civitaspo/csm-ci-actions/actions/runs/40192854354) |

## 25. Operator and action documentation

The root README now explains the credential problem, the capabilities, and the client and server entry points. It explicitly acknowledges the strong influence of the Client-Server Model and securefix-action. Each of the six client actions and twelve server actions has a reference beside its metadata, with inputs, outputs, conditional requirements, prerequisites, and direct examples. Internal progress and verification history remain outside those operator-facing introductions.

Tool installation, frozen dependencies, typecheck, all 915 tests, build with clean bundles, and jactionlint passed. A documentation check verified coverage of all declared input and output names, action input names and required fields in the examples, all 23 action-reference YAML examples, and local links. The release-plan JSON example passed its runtime schema. The four root README workflow examples also parsed. Independent review identified and corrected the schedule example, conditional input requirements, token references, cross-repository artifact download fields, and JSON output shapes. No executable files or rejection rules changed.

GitHub verified signed head `189a113f1d418d433f4fd47aabe427270c85e0e2`. Smoke passed all five scenarios without skips: [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40193650489), [server request](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40193661108), and [configuration check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40193650799). The later handoff-only evidence commit changes no executable files.

The README requires human review before merge. Phase 7 and the final report remain pending that review. No production cutover was executed.

## 26. Production bootstrap and actions repository enrollment

The human reviewed the reader-facing README and authorized PR #33, the production target-plan PR #34, and production server bootstrap PR #1. Those PRs were merged. The plan now explicitly includes the installed, configured actions repository as a repo-settings client, retains its fixed all-paths-sensitive policy, and requires preserving existing release contracts during migration.

The production server is [civitaspo/csm-ci-server](https://github.com/civitaspo/csm-ci-server). The owner created and installed the production Apps and registered their keys. Server App ID is `5467106`; bot user IDs are Client `347822659`, Server `347821498`, and Approver `347823687`. Strong keys are restricted to the server's `csm-ci` environment, whose deployment policy allows only `main`. Only the server is initially enrolled; the ten planned targets and release migration gates are recorded in its `migration-targets.md`.

Production [Renovate PR #2](https://github.com/civitaspo/csm-ci-server/pull/2) verified the actual request path at signed head `80c59d74b7be68b3f37ccfb5bd5eb71e926957b5`. [CI](https://github.com/civitaspo/csm-ci-server/actions/runs/40200040619) passed. Automatic approval produced no review, and `csm-ci/policy` failed until the owner explicitly requested `/approve`. The [approval run](https://github.com/civitaspo/csm-ci-server/actions/runs/40200120806) created an exact-head review by `csm-ci-approver[bot]`, with the command marker for comment `6398562732`; the policy check owned by App `5467106` then passed. The owner requested `/merge`, and the [merge run](https://github.com/civitaspo/csm-ci-server/actions/runs/40200231900) squash-merged it as `d2a2cf619d04fa201de51abee18d71e5fb5b16e5`, with `merged_by` equal to `csm-ci-server[bot]`. [Post-merge CI](https://github.com/civitaspo/csm-ci-server/actions/runs/40200284559) passed. Production rulesets were not yet active, so a separate merge under managed protection remains required before client enrollment.

The repo-settings implementation now permits the actions repository in discovery, explicit selection, and execution context when it is installed and configured. It still cannot serve as the server repository. All 918 tests and 1,630 assertions passed, along with typecheck, frozen dependencies, build with committed bundles, tool installation, and jactionlint. Five isolated mutation checks failed as expected when restoring each former exclusion or removing either explicit-selection guard. Independent review found no remaining code/specification issue.

At signed head `bd51b0dad3121a18e825e76dd319623de8fef3e4`, local repo-settings e2e passed its scenario without skips: [initial reconciliation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200081648), [schedule preserving the stop](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200194898), [managed-files-only bootstrap](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200301972), and [expected missing-caller rejection before writes](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200388883). These existing e2e scenarios cover reconciliation behavior; acceptance of the actions role is additionally covered by focused discovery and execution-context tests. Production actions enrollment remains pending the reviewed implementation merge and caller migration.

Do not archive either securefix-server repository or remove the old approver credentials until the final client has migrated. Terraform Provider publishing still requires a compatible GPG signing design; existing musl/raw-binary Rust assets also differ from the first-release Cargo builder. The owner handles private keys, PATs, and App permission changes.

Smoke at the same signed head also passed all five scenarios without skips: [configuration and workflow validation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200443059), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40200442836), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40200458421). The later handoff-only evidence commit changes no executable files.

### Protected server and first client bootstrap

The owner authorized sequential migration of all ten planned repositories, including their existing release contracts. The production server's [reconcile run](https://github.com/civitaspo/csm-ci-server/actions/runs/40201817007) activated the four managed rulesets. API inspection confirmed that integrity and review-and-checks have no bypass, require one approval with stale dismissal, and bind `status-check` to App `15368` and `csm-ci/policy` to App `5467106`. Controlled merges and release tags admit only the Server App. Squash-only merging, branch cleanup and immutable releases are enabled.

[Server PR #5](https://github.com/civitaspo/csm-ci-server/pull/5) then verified an intended merge under those protections. GitHub changed its review decision from `REVIEW_REQUIRED` to `APPROVED` after the exact-head Approver App review. The [Server App merge](https://github.com/civitaspo/csm-ci-server/actions/runs/40202334965) and [main CI](https://github.com/civitaspo/csm-ci-server/actions/runs/40202378983) passed. This establishes that GitHub counts the App review toward the active approval rule.

[Server PR #6](https://github.com/civitaspo/csm-ci-server/pull/6) enrolled only the actions repository in addition to the server and added the bounded release route and common client callers. The [managed-files-only run](https://github.com/civitaspo/csm-ci-server/actions/runs/40203199588) opened [actions PR #36](https://github.com/civitaspo/csm-ci-actions/pull/36) with three callers and the PR template; API inspection confirmed that client rulesets remained absent. Independent review, all 918 tests, typecheck, build with unchanged bundles and jactionlint passed. Signed-head smoke passed five scenarios without skips, including [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203339412) and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40203349828). PR #36 used the existing owner merge process before the callers were available on default; [main CI](https://github.com/civitaspo/csm-ci-actions/actions/runs/40203431699) passed.

The actions repository now adds the two documented release callers at reviewed revision `85d8fc79ef0ca89ec4cc073d142dab75ebe09a66` and an initial package version of `0.1.0`. The version field is required by release preparation; this does not publish a package or a GitHub release. Verify the new client request path, then reconcile client protection before approving and merging its generated release PR. The JS-action builder must still verify committed `dist/`, and publication must confirm an immutable release. Other clients remain pending and must migrate one at a time.

### Migration verification scope

Reuse completed Phase 6 verification for unchanged reusable implementations. Caller-only migration changes require workflow validation and CI, actual production approval and merge under protection, and verification of that target's release contract. Broaden testing only for a changed implementation, a failure, or a specific unresolved concern. Testing-repository success alone does not establish production migration.

At signed implementation head `74ca322dacf22f5d9b0bad8c6a75bf103e90d121`, release preparation passed four scenarios without skips, with five recorded runs because the first scenario also retries its request: [explicit version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203633409), [repeat](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203725604), [inferred version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203818500), [invalid version rejection](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203899489), and [non-default dispatch](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40203931162). A broader release run was stopped as redundant after six successful scenarios; it is not a completed suite. Its completed evidence remains in the run logs. The owned open test PR and unchanged branch were removed, the exact server fixture configuration was restored, and the original test rulesets and lock cleanup were verified.

## 27. dbt package release compatibility

The actions client completed its protected production merge and immutable `v0.1.0` publication; the production server's [verification record](https://github.com/civitaspo/csm-ci-server/blob/main/verification.md) contains the release and attestation evidence. Dotfiles then completed its caller cutover, four managed rulesets and protected [PR #266](https://github.com/civitaspo/dotfiles/pull/266), merged by the new Server App. [Main CI](https://github.com/civitaspo/dotfiles/actions/runs/40209284971) passed. Its unrelated default-branch ruleset remains active; the two old service rulesets were removed only after the new protections were verified.

The next client, `dbt-authorized-models`, requires its root `dbt_project.yml` version to match `pyproject.toml` and `.release-version`. Specification [PR #40](https://github.com/civitaspo/csm-ci-actions/pull/40) was merged before implementing that compatibility. Release preparation now uses the existing YAML dependency to validate the root version, preserves unrelated bytes, and rejects unsupported metadata before writing any release files. Typecheck, all 935 tests, build with committed bundles, and jactionlint passed. Seven isolated mutation checks failed as expected. Independent review found no remaining issue.

At signed implementation head `02cb663d2b3d95bf3029a16dbaafcb8c563e9c5c`, release preparation passed all four scenarios without skips: [explicit version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40210206313), [repeat](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40210282365), [inferred version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40210379367), [invalid version rejection](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40210462715), and [non-default dispatch](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40210488643). The generated PR assertions verify synchronized dbt and Python root versions and preservation of their other fields. The later evidence-only commit changes no executable files. The release builder and publisher are unchanged and reuse their completed verification. The dbt production cutover and release verification remain pending.

## 28. Raw Rust binary release compatibility

The sequential production migration reached `herdr-linear-agent`, whose installer consumes four raw Darwin/musl binaries and individual checksum sidecars. Its [previous upload run](https://github.com/civitaspo/herdr-linear-agent/actions/runs/39526055780) failed after the release became immutable. Its Cargo and plugin manifest versions deliberately remain fixed while `.release-version` controls the reported release version. Specification [PR #43](https://github.com/civitaspo/csm-ci-actions/pull/43) was merged before implementing these contracts.

The bounded `cargo-raw` build type requires a safe binary name and accepts only the four documented targets. Fixed native runners build without credentials or caches, verify executable format and architecture, execute each binary to check its release version, and verify static musl linkage on Linux. The trusted publisher requires the exact binary set, generates the four checksum sidecars and `SHA256SUMS`, and attests all nine assets before immutable publication. Publication revalidates the asset contract. Existing Cargo archives retain their names and five-target support. Release preparation defaults to updating root versions; clients can explicitly set `update-root-version: false` to change only `.release-version` and `CHANGELOG.md`.

Tool installation, frozen dependencies, typecheck, all 991 tests, build with unchanged committed bundles, and jactionlint passed. All 26 isolated rejection-rule mutations failed as expected. Independent code/specification review found no remaining issue.

Signed implementation head `76bddade9fd5938f02165d6a342e6e54c52163b0` passed the raw release scenario without skips: [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40228274530), [four native builds and publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40228287095), and [all-nine-asset checksum and attestation verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40228435807). The resulting [release](https://github.com/civitaspo/testing-csm-ci-client/releases/tag/v1.0.1792957989380) is immutable and Server-authored. A separate existing Cargo scenario passed its [five-target build and publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40228660263) and [attestation verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40228799379).

At the same implementation head, release preparation passed all five scenarios without skips: [fixed manifests preserved](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40228867218), [explicit version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40228949704), [repeat](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40229036386), [inferred version](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40229133548), [invalid version rejection](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40229217081), and [non-default dispatch](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40229240251). The fixed-manifest case checks that the generated PR changes only the release version and changelog. The later evidence-only commit changes no executable files. Production client enrollment, protected release merge, all four real client binary builds, and installer verification remain separate gates.

## 29. Lockfile-enforced reusable release workflows

The migrated `herdr-linear-agent` caller passed full PR and main CI, but its first [release-preparation run](https://github.com/civitaspo/herdr-linear-agent/actions/runs/40230211130) failed at startup. GitHub reported that `client-release-prepare.yml@313dac1ce1e5a288fc2f5fe729e8f4ca7ad71180` lacked a lockfile in its defining repository. Both official verification modes had accepted the client's fresh lockfile: reusable workflow dependencies are covered by the defining repository's lockfile, outside the caller's coverage. Specification [PR #47](https://github.com/civitaspo/csm-ci-actions/pull/47) was merged before this correction.

Only shared release preparation and publication use `$/actions/client/...` to resolve composites at the defining workflow's repository and commit. Their redundant runtime checkouts are removed. The official generator follows these self-repository composites, so the scoped source lockfile covers the installer, token and artifact actions as well as preparation's client checkout. Every external SHA is unchanged. Other reusable workflows retain the verified checkout pattern. The pinned mise tasks generate and verify only these two workflows; CI verifies their lock with GitHub authentication. Regenerate it whenever either workflow or composite dependencies change, without rewriting SHA pins.

The real locked production client must start both workflows before its migration can complete; fixture CI alone does not establish enforcement behavior.

At signed implementation head `a0b3c72e4d9e80194d1f64a63eea28bfcb3deb5b`, required installation, frozen dependencies, typecheck, all 991 tests, build with unchanged committed bundles, jactionlint and scoped offline/online official lock verification passed. Independent implementation/specification review found no actionable issue. The official checker accepted an isolated original lock and rejected both mutations: removing the transitive installer dependency and removing the publication workflow entry. No new runtime rejection logic was added.

Live fixed-manifest preparation passed without skips: [client generation](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40231067526), [server application](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40231089610), and [generated PR #571](https://github.com/civitaspo/testing-csm-ci-client/pull/571). Only `.release-version` and `CHANGELOG.md` changed; the scenario verified all five root manifests byte-for-byte. The fixture exercises `$/` resolution and committed runtime bundles; the production locked-client gate remains separate.

At the same implementation head, source-only publication passed without skips: [publication caller](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40231326516), [server pipeline](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40231343716), immutable [fixture release](https://github.com/civitaspo/testing-csm-ci-client/releases/tag/v1.0.1792960288109), and [asset attestation verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40231439255). This verifies both shared composite calls after removing the self-checkouts. The first Linux CI run installed the raw generator asset as `linux-amd64`, so the verification command could not resolve `gh-actions-lock`. The mise tool entry now explicitly sets its executable name; the already pinned platform assets and lockfile bytes are unchanged. Independent review and local lock verification passed after that correction. Later handoff edits change no workflow, action or runtime bytes. The pending production HLA migration still requires its reviewed caller-pin follow-up, protection reconciliation, protected release, all four native client builds, nine-asset verification and actual installer check.

## 30. Lockfile coverage for every reusable client workflow

HLA follow-up [PR #200](https://github.com/civitaspo/herdr-linear-agent/pull/200) exposed the remaining shared request workflows before it was merged. Its [policy run](https://github.com/civitaspo/herdr-linear-agent/actions/runs/40232158811) failed at startup because `client-policy-check.yml@85d8fc79ef0ca89ec4cc073d142dab75ebe09a66` lacked a defining-repository lockfile. The approval run failed for the same reason. Auditing all five shared caller revisions found the two release workflows covered and all three request workflows uncovered. The earlier two-workflow correction was incomplete for the locked client's complete request path. No HLA follow-up bootstrap or protection retirement was performed before this audit.

Specification [PR #51](https://github.com/civitaspo/csm-ci-actions/pull/51) expanded the bounded design before implementation. Approve, merge and policy-check now use their defining-repository composites through `$/actions/client/...`, removing only their self-checkouts. Event filtering, credentials, permissions, inputs, JavaScript bundles and external SHA pins are unchanged. Official scoped generation and verification now cover all five reusable client workflows. Each added request workflow depends on the existing pinned App-token action. Server reusable workflows retain their documented runtime checkout pattern.

Required installation, frozen dependencies, typecheck, all 991 tests, build with unchanged committed bundles, jactionlint and scoped official lock verification passed. Independent implementation/specification review found no actionable issue. In an isolated copy, the official checker accepted the original lock and rejected removal of the App-token entry from each of the three added workflow sections. The real locked-client path remains a migration gate, including all five caller startups, protected release, native binaries and installer verification.

At signed implementation head `66a60757dbfa6edb84b81bf6d07d897cd4f9e46a`, three representative scenarios ran sequentially and passed without skips: explicit [approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40232734845), [ordinary signed/trusted policy evaluation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40233108824), and [approved-head squash merge with one receipt](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40232929340). These verify each changed wrapper's defining-repository composite and committed bundle. This is a focused request-wiring check, not a rerun of the unchanged rejection suites. An initial sensitive-policy selection required the CI-only untrusted token and skipped, so it provides no passing evidence; the completed ordinary-policy scenario replaces it. The earlier release-only correction's live preparation and publication verification remains applicable because those two wrappers are unchanged. Later evidence-only edits change no executable bytes.


## 31. Terraform provider migration contract

The ninth sequential migration, `hook-relay-client-rs`, completed its protected [release PR #68](https://github.com/civitaspo/hook-relay-client-rs/pull/68). Its [original full PR CI](https://github.com/civitaspo/hook-relay-client-rs/actions/runs/40237913832) passed all four real jobs; exact-head Approver review and policy preceded the Server App's protected merge `e4583e8265dd18132ec24ed70c35bebf6abf08d1`. The [server pipeline](https://github.com/civitaspo/csm-ci-server/actions/runs/40238247594) passed all four native builds, publication and cleanup. Immutable [v0.1.1](https://github.com/civitaspo/hook-relay-client-rs/releases/tag/v0.1.1) has the exact nine expected assets. Local verification checked every GitHub digest, sidecar, aggregate checksum and strict attestation against client, merge, tag and reusable signer `313dac1ce1e5a288fc2f5fe729e8f4ca7ad71180`, denying self-hosted runners. Both fixed Cargo manifests remained byte-identical. The unchanged README download/checksum commands installed the actual macOS ARM binary in an isolated directory; it reported `hook-relay-client 0.1.1`. Final [main CI](https://github.com/civitaspo/hook-relay-client-rs/actions/runs/40238237080) passed every job. The after-snapshot confirmed six rulesets, preserved unrelated protection, and only the reviewed exact installer allowlist addition. Four other open PRs passed the new policy without merging or automerge.

Only after those gates passed was `terraform-provider-sigma` selected. Its actual [v0.2.3](https://github.com/civitaspo/terraform-provider-sigma/releases/tag/v0.2.3) has thirteen ZIPs, a protocol-6 manifest, a provider-prefixed SHA256SUMS and its binary GPG signature. Downloaded Darwin and Windows archives contain a root versioned binary (`.exe` on Windows), LICENSE, README.md and CHANGELOG.md. Local public-key-only GnuPG verification confirmed the published checksum signature against the Registry's public fingerprint `12D7B26BEB5394D7AA579FB300F0D373EFFA1DC6`. The existing client GoReleaser configuration builds with CGO disabled, trimpath and `main.version`, retaining ARMv6 support through GoReleaser's default. Provider source and dependencies remain outside this migration's scope.

The [Registry publishing contract](https://developer.hashicorp.com/terraform/registry/providers/publishing) requires platform ZIPs, a release manifest, provider-prefixed checksums, and a binary detached GPG signature. Attestation alone cannot replace that signature. The Registry's [download API](https://registry.terraform.io/v1/providers/civitaspo/sigma/0.2.3/download/darwin/arm64) currently advertises version 0.2.3 and the same public signing key. Repository webhook inspection returned an empty list; do not assume a classic release webhook is present or alter Registry/App permissions. Verify new-version discovery against the actual Registry after publication and involve the human if Registry-side resync is necessary.

The specification adds a bounded provider type, reusing unprivileged GoReleaser builds and placing all GPG work in the trusted publish job. A dedicated Go cross-compile implementation would duplicate the client's already verified packaging settings; giving the generic GoReleaser type signing access would broaden unrelated releases. Neither alternative is required. Fixed primary RSA selection and the source commit timestamp make the signature repeatable across workflow retries. The provider-prefixed checksum retains Registry compatibility while the existing aggregate checksum and provenance cover the signature as well.

Metadata-only inspection found only App secrets in the new production server's `csm-ci` environment. The legacy server's `main` environment lists `TERRAFORM_PROVIDER_GPG_PRIVATE_KEY` and `TERRAFORM_PROVIDER_GPG_PASSPHRASE`; no values were accessed. The human must register the existing production key and passphrase, and a separate testing key, under the new Naming-list names. No provider caller, ruleset, release PR, Registry setting or legacy signing workflow has yet been changed. Provider migration and live verification remain pending; this specification does not establish Terraform compatibility or authorize an agent to handle private keys.

## 32. Terraform provider implementation verification

The implementation candidate is signed commit `5af7781f957bc932f8fb4d56fe5d9833110896e1`. It adds the bounded provider type, isolated archive collection, trusted GPG preparation, public-key revalidation and a seventeen-asset publication/replay scenario. The required local tool installation, frozen dependency installation, type checking, 1,012 tests, build, clean committed `dist/`, jactionlint and action-lock verification passed. Every one of the 43 new Python and TypeScript rejection guards was removed individually in an isolated copy; each mutation failed its tests. Independent implementation/specification review found no outstanding issue. The GPG unit tests simulate the command protocol without creating or retrieving a private key; they do not establish live signing compatibility.

The unchanged generic GoReleaser path passed a focused live regression at signed implementation commit `8dc519ea37455d92e2b0e38a76b75e9b9634f382`: [approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40241322274), [Server App merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40241407635), [publication request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40241451898), [build, publication and cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40241466928), immutable [release](https://github.com/civitaspo/testing-csm-ci-client/releases/tag/v1.0.1792968031827), and [checksum/attestation verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40241573561). The scenario passed without skips. Later executable fixes affect only the provider fixture and helper resolution. Other unchanged release suites were not repeated.

All thirteen actual platform ZIPs and the manifest from the provider's existing `v0.2.3` release passed the new archive/manifest validator. Their bytes matched the published provider checksums and GitHub asset digests. This verifies the existing package layout against the validator; it does not replace a new provider build or signature verification.

The owner registered `CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY` and `CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE` in both servers' `csm-ci` environments. Metadata-only inspection confirmed those names and distinct public fingerprints: production `12D7B26BEB5394D7AA579FB300F0D373EFFA1DC6`, testing `539BD45AF62991F6AB8F931BA00D8967015E154E`. No agent created, read or registered a private credential. The production fingerprint retains the Registry-registered identity; the testing key must never be registered with the public Registry. A read-only before-snapshot records provider head `8e8fe8cac97850ba6b38b7a9893ab293e969241d`, four rulesets and nineteen workflow/configuration files.

The first provider attempt failed before signing because the inherited tracked JS fixture became dirty under GoReleaser's clean build. The fixture now removes that unrelated output, as the generic fixture already does. The second [build](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40246883931) produced all thirteen valid ZIPs and the manifest, but asset preparation failed to find its Python helper because Node actions do not set `GITHUB_ACTION_PATH`. Helper resolution now uses the compiled action's module URL. A regression test copies the real bundle and helper into a temporary checkout and runs Node from another directory without that environment variable. The test failed before the fix and passed afterward. Both corrections received independent review.

At signed candidate `5af7781f957bc932f8fb4d56fe5d9833110896e1`, the complete provider scenario passed without skips: [approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40247436570), [protected Server merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40247489963), [publication request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40247536602), [thirteen-platform build and signed publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40247550679), immutable [release](https://github.com/civitaspo/testing-csm-ci-client/releases/tag/v1.0.1792972947495), and [all-seventeen-asset verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40247755172). A second [request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40247852597) repeated the [build and publisher](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40247865322) successfully. The scenario confirmed the same immutable release ID and identical names and digests for every asset, including the binary GPG signature. The [replay verifier](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40248043693) again checked the exact asset set, Registry signature and fingerprint, checksums and each attestation's client, merge, tag and digest.

The production provider gates are now complete, as recorded in section 34. The separately requested Renovate rollout and final operator-reference audit still precede legacy archival. Later evidence-only changes do not change executable bytes.


## 33. Native Bot merge comments

Production Renovate comments were discarded because GitHub reports CONTRIBUTOR association for the Bot, while both client filters accepted only OWNER, MEMBER and COLLABORATOR. The server already supports configured Bot mergers, but production had an empty bot-merger list. The owner requested eligible Renovate auto-merges. Specification [PR #60](https://github.com/civitaspo/csm-ci-actions/pull/60) defined the bounded client exception before implementation.

The shared merge workflow and action now also forward a newly created, exact `/merge` comment from a Bot whose immutable ID matches the PR author. The action validates both IDs as positive integers. The server remains responsible for Bot trust membership, ownership of the PR and every commit, current approval, policies and required checks. Its fixed prohibition on Bot mergers in the server and actions repositories is unchanged. Approval and recheck association rules, permissions, external action pins and server bundles are unchanged. Official scoped lock regeneration produced identical bytes.

Test-only [PR #61](https://github.com/civitaspo/csm-ci-actions/pull/61) removed the manual-dispatch fallback from the Bot-owned PR and mixed-commit scenarios before the runtime candidate was tested. The wrong-PR-author scenario retains explicit dispatch to exercise the server's independent ownership check. The main-only e2e environment and trusted runner checkout are unchanged.

At signed implementation `495ee72c7dac10dfdfe0ed3d4100c974769233ad`, required installation, frozen dependencies, typecheck, all 1,033 tests, clean rebuilt bundles, jactionlint and official action-lock verification passed. Removing each of five Bot type, positive-ID, integer-ID, ownership and forwarding rules in isolation failed its tests. Independent implementation/specification review found no actionable issue.

The credentialed [merge suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40255902418) passed all nine scenarios without skips. GitHub gave the isolated test Bot CONTRIBUTOR association. Its native [mixed-commit request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40256761685) reached the [server rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40256773464). Its native [own-PR request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40256928948) led to a successful [Server merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40256942388) of [PR #597](https://github.com/civitaspo/testing-csm-ci-client/pull/597), with one success receipt for comment `6406552537`. The suite also verified the [wrong-PR-author rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40256614267) and the existing human merge, changed-head, edited/deleted-comment, missing-approval and notification-token restrictions. Test configuration and locks were restored. Production [server PR #15](https://github.com/civitaspo/csm-ci-server/pull/15) has configured Renovate Bot trust and its own merge caller. The remaining client caller rollout and a real Renovate merge are separate gates. Later evidence-only changes do not change executable bytes.


## 34. Production provider verification

All ten selected repositories completed their sequential migration and applicable release gates. For the final provider, [release PR #215](https://github.com/civitaspo/terraform-provider-sigma/pull/215) passed [all four original CI jobs](https://github.com/civitaspo/terraform-provider-sigma/actions/runs/40251495812), exact-head Approver review and policy. The [Server merge](https://github.com/civitaspo/csm-ci-server/actions/runs/40252010134) produced `b61bde0167aaf74b38f6ad517c1c5ff49c12ab8d`. The [production release pipeline](https://github.com/civitaspo/csm-ci-server/actions/runs/40252077526) built all thirteen platforms and published immutable [v0.2.4](https://github.com/civitaspo/terraform-provider-sigma/releases/tag/v0.2.4) with the expected seventeen assets.

Local verification checked every asset digest, archive contract, manifest, checksum, public GPG signature and strict attestation against the client, merge, tag and reusable signer `82917b4c3a28e5ff4023991ed355b40081d650fb`, denying self-hosted runners. The production primary fingerprint remains `12D7B26BEB5394D7AA579FB300F0D373EFFA1DC6`. Five fixed source manifests stayed byte-identical. Final [main CI](https://github.com/civitaspo/terraform-provider-sigma/actions/runs/40252063971) passed every job.

The actual Terraform Registry discovered version 0.2.4. Terraform 1.17 installed it in a clean project and loaded the provider schema with 29 resources and 34 data sources without Sigma credentials. The final snapshot confirmed all six provider rulesets, preserved unrelated protection and Actions settings, and only the reviewed installer allowlist addition. The server's [verification record](https://github.com/civitaspo/csm-ci-server/blob/main/verification.md) contains the complete production sequence.

The owner subsequently requested eligible Renovate auto-merges and `/merge` comment configuration in every repository. The read-only ten-repository audit found eight existing comment configurations and two missing configurations, on the server and this actions repository. The server rollout and this caller change add those missing non-major comment requests with platform automerge disabled. The fixed prohibition on Bot mergers in both privileged repositories remains; their Renovate requests still require an operator. The remaining eight client caller updates, native production Renovate merge proof, final reference audit and three legacy repository archives remain required before the rollout is complete. No agent handled private credentials or App permissions.

## Explicit secret contract probe

Issue [#76](https://github.com/civitaspo/csm-ci-actions/issues/76) now has a separate [specification](first-release-plan.md#explicit-secret-contract-and-staged-migration). It is not a completed runtime migration.

The [positive run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40303489939), attempt 1, used testing-server caller `1ebcba6b0054f0ab352610318cd9a5dc6035d6e4`, reusable candidate `b99d243b4f07a56a9b85f87b254ae4555c8610b9`, and nested leaves `75b1a47c2b78dbf1cfe04785e8cb96f931ec2d77`. All four expected Boolean availability assertions completed successfully, with none skipped. These were the direct environment job, nested discovery, nested client target, and nested server-after-clients target. The direct job checked all four configured names. Nested discovery checked the Server App key only. Each nested target checked the Server App and approver App keys. The nested wrapper declared and forwarded only those two names, never provider signing credentials. All checks used Boolean availability expressions without printing values or lengths.

The separate [missing-required-mapping run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40303734933), attempt 1, used caller `4af3da61ac99f2c33132c7bf8f4b55fd3b47746c` and the same reusable candidate. It ended in `startup_failure` with zero jobs. The GitHub run summary reported `Secret CSM_CI_SERVER_APP_PRIVATE_KEY is required, but not provided while calling.` This establishes required mapping validation, not selected-feature runtime validation.

Metadata before and after both runs showed owner `civitaspo` was a User, ID `4525500`, with zero repository Actions secrets. The server's `csm-ci` environment contained exactly the Server App key, approver App key, provider GPG private key, and provider GPG passphrase names in the Naming list. Its sole deployment policy remained branch `main`, policy ID `64190557`. Organization secret scope does not apply to this personal account. These metadata observations establish environment provenance separately from the assertion steps. No credential values or job logs were retrieved. No secret, App, production configuration, or environment policy changed.

Both temporary caller paths returned 404 at cleanup commit `9c7512438ddc6ccf6fc6bb76c6bbbc62b46b5353`. The [cleanup CI run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40303897065) succeeded. The owned temporary actions branch was deleted after both runs completed, using the expected candidate head. Probe workflow source is not part of the specification change.

The probe did not mint App tokens, activate controlled merges, submit client requests, sign releases, or test the full migrated runtime. Those gates, including missing and wrong mappings and selected-feature credential rejection tests, remain required by the specification. The optional no-map probe was not run.

## 35. Smoke fixture lint prerequisite

The smoke attempt at candidate `b1a42322f7805dd7b99d434d4135b5cb2178a488` failed in the testing server's [check run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40290018469). jactionlint 2.3.0 rejected the Terraform public-key verification pipeline in `.github/workflows/csm-ci-release-verify.yml` because the default shell omits `pipefail`. The live workflow matched the authoritative fixture byte-for-byte at both that candidate and main `984235a`. The pipeline originated in `82917b4c3a28e5ff4023991ed355b40081d650fb`; restoring the unchanged fixture cannot repair it.

The fixture now selects `shell: bash` for that step so an upstream `jq` failure fails the step. Local jactionlint reproduced the original `pipeline-without-pipefail` error and passed with the correction. Live release and smoke verification subsequently passed at signed candidate `ec29e772425d2260fe11b09d528061f9b7fe6e41`, as recorded in section 36.

## 36. Release fixture deletion across build types

The full release suite at `a2b27bcef9bfcc4dce1ea83ca08e730a6a3b216b` passed none, js-action, GoReleaser, Cargo and cargo-raw publication, then failed before creating the Terraform release PR. The GoReleaser fixture had already removed `dist/action.js` in [client commit `345c5c3`](https://github.com/civitaspo/testing-csm-ci-client/commit/345c5c38236dd2f1479faf1c8a6f89f26b7f732a). Terraform requested that deletion again against client base `dba0a9207f4100ca7e8193106cbe495af5bf7279`, whose tree no longer contains the path. GitHub rejected the commit with "A path was requested for deletion which does not exist". This fixture behavior predates the verification-shell correction.

`openReleasePr` now checks deletion paths at its pinned base SHA and omits paths already absent there. Other lookup errors propagate; the commit still requires the same expected head, and branch cleanup retains its ownership check. Focused tests cover present and absent paths, pinned-base reads, preserved additions and expected head, and HTTP 403, 422 and 503 failures. The final complete release suite verified Terraform publication and replay alongside the other supported build types.

Local verification passed all 1,038 tests, typecheck, build with unchanged bundles, jactionlint and actions-lock verification. Five isolated mutation checks detected unconditional deletions, omitted present-path deletions, swallowed lookup errors, reads against mutable `main`, and removal of the expected-head condition. The complete release suite passed all 14 scenarios without skips at signed candidate `ec29e772425d2260fe11b09d528061f9b7fe6e41`. The Terraform scenario verified its [publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40307291864), [all seventeen assets](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40307568638), [immutable replay](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40307761443), and [replay verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40308041353).

Smoke passed all five scenarios without skips at the same signed candidate: [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40317288667), [server intake and cleanup](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40317306440), [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40317289764), [App permission probe](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40317289138), and [human-label rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40317291236). The later integration changes only documentation and preserves every non-Markdown tracked blob from this verified candidate.

## Renovate repository skill packaging

[Issue #93](https://github.com/civitaspo/csm-ci-actions/issues/93) packages the existing #75 and #80 operator procedure as the [Renovate review skill](../.agents/skills/renovate-review/SKILL.md). Its [validation record](../.agents/skills/renovate-review/references/validation.md#review-only-exercise-on-2026-10-26) records a read-only review of PR #57 at head `fda7edf5dfe3b140eda53c8aaa9634607d4cd606` against base `3b4dadcb2f1ab96b103dcf0df96546507caec365`. Current CI passed, but policy required trusted command approval. The review made no live writes. Automatic discovery in a fresh agent session and agent-driven approval or merge remain unverified. This packaging changes no runtime behavior or authorization and requires no separate plan amendment.


## CI Terraform verification public trust anchor

The post-merge [release suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40318456820) at `65ae7a4af61cd5f3d37f2ea761fd9a1f73abdcd2` passed 13 of 14 scenarios with no skips. The Terraform [publisher](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40321898850) succeeded and created the immutable release, but the harness failed before hosted verification and replay: its owner PAT could not read `CSM_CI_TERRAFORM_PROVIDER_GPG_FINGERPRINT` from the testing server's `csm-ci` environment (HTTP 403). That endpoint requires Environments read permission, which the documented harness PAT does not require. This failure does not establish Terraform verification or replay success at that SHA.

The harness now pins the public testing fingerprint recorded in section 32 as its independent trust anchor. It still supplies the signer run so the verifier downloads the public key artifact and checks the full primary fingerprint, RSA signature, archives, checksums and attestations. It does not derive the expected fingerprint from that artifact or require access to privileged environment metadata. For testing-key rotation, the operator must verify the new public fingerprint through a trusted source and review the committed test anchor update; a newly downloaded signing artifact alone is not evidence for changing the anchor. Credentials and token permissions are unchanged.
## 37. Squash commit format verification and fixture correction

At signed candidate `5ca2e59eb86b8399cada78e0901a37c38a396476`, the client [initial reconciliation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40328681407) and [replay](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40328838110) succeeded. The scenario verified repair to `PR_TITLE` and `PR_BODY`, a stable managed-file pull request and head, and a replay with no settings or managed-file writes. The omission scenario then failed before dispatch: its fixture tried to set `COMMIT_OR_PR_TITLE` with `BLANK`. A restoration assertion replaced that API error in the scenario output.

A separate bounded probe on 2026-10-26 captured the testing client's repository settings, complete rulesets and immutable-release state before repeating only that two-field update. GitHub returned HTTP 422, `invalid_squash_commit_setting_combo`, and listed four accepted title/message pairs: `PR_TITLE` with `PR_BODY`, `BLANK` or `COMMIT_MESSAGES`, and `COMMIT_OR_PR_TITLE` with `COMMIT_MESSAGES`. All captured settings, rulesets and immutable-release state matched after the rejected update. No restoration write was needed. The original failed suite's in-memory baseline was not persisted, so this probe cannot establish whether that earlier suite restored its original settings exactly.

The omission fixture now uses the accepted `COMMIT_OR_PR_TITLE` and `COMMIT_MESSAGES` pair. Repository-settings scenarios and temporary server-configuration edits retain both scenario and cleanup failures and run every cleanup step. Repository-settings snapshots record baseline and restored state in the scenario logs. The snapshots contain only managed repository settings, managed ruleset definitions and immutable-release state. The complete omission, schedule and bootstrap paths and smoke still require live verification at the corrected candidate.

## E2E server configuration visibility

The post-merge [release run 40340976732](https://github.com/civitaspo/csm-ci-actions/actions/runs/40340976732) at `cf9c21199baada8326ad851e31e10e7258fedf7b` passed 12/14 scenarios. After the disabled-release scenario restored the server fixture, the following two scenarios failed in the harness with `release config for civitaspo/testing-csm-ci-client is missing`, before writing their configuration. The restore commit existed; the later GoReleaser configuration commit directly parented it. This identifies stale Contents API reads through `ref=main`, rather than a release authorization or publication failure.

`withServerConfig` now resolves `heads/main` and reads `csm-ci.yaml` at that immutable commit. After each temporary change and restoration, it uses the harness's existing bounded state polling to verify the requested content before continuing. A later scenario also resolves its own immutable content address instead of reusing a mutable-ref Contents response. Unexpected API errors still propagate, writes are not retried, and cleanup still refuses to overwrite unexpected content. If visibility expires after a successful temporary write, cleanup retains its returned blob SHA for a conditional restore, even when the read still returns the original text.

The local regression executes the disabled-release and GoReleaser configuration changes consecutively while mutable-ref Contents responses remain disabled. Another regression delays the visible branch head after both writes and checks visibility before the scenario and before return. Deadline and API-error tests exercise failure boundaries.

At signed candidate `f7d936eccb94156371f12937c3eb26ef8b7c20e3`, the full release suite passed 14/14 scenarios with no skips. The [disabled-release rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40365312004) and previously failing [none publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40365744627) and [GoReleaser publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40368307001) paths all passed in sequence. The [Terraform publication](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40370692789) and [replay verification](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40371730049) passed for all seventeen assets. The suite also exercised js-action, cargo, cargo-raw, replay, and release rejection paths; its final [tag-ruleset proof](https://api.github.com/repos/civitaspo/testing-csm-ci-client/rulesets/rule-suites/4731466970) rejected owner tag creation. This is live evidence for the corrected configuration visibility at this candidate; the later smoke result is recorded below.
## E2E server administration baseline after restoration

The repo-settings suite at signed candidate `6de1b1eeb32d45f33cf9938edee7f59573a6681d` reached the server bootstrap scenario, then failed its unchanged-administration assertion after the expected [normal-dispatch rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40362828501). The caller ran at server head `33185027978f0016c627f274c0042d2d6e2fcc7c`; all three referenced reusable workflows resolved to that candidate. The normal dispatch rejected the missing caller and skipped `Apply repository settings`.

The scenario log recorded the original server settings and an equal restored snapshot, followed immediately by a new baseline containing the preceding reconciled settings. The final observed snapshot matched the original restored state. This sequence is consistent with a stale repository GET; the underlying GitHub caching mechanism is unverified. Cleanup then restored the incorrect second baseline, so it cannot establish preservation of the original state.

The bootstrap phase now reuses the original server snapshot after the schedule phase's restoration has verified equality. Its strict administrative-state comparison, skipped-write assertions, rejection evidence and owned cleanup remain in place. This removes the redundant read that could redefine both the assertion baseline and cleanup target.

At signed candidate `f7d936eccb94156371f12937c3eb26ef8b7c20e3`, the [repo-settings suite](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40364102707) passed 1/1 scenarios with no skips. It observed drift repair, unchanged replay, schedule-mode reconciliation, managed-files-only bootstrap, and the expected normal-dispatch rejection before administration writes ([rejection run](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40365073806)). Both testing repositories' recorded settings, rulesets and immutable-release state matched their original snapshots after cleanup. The suite's other exact run URLs are in the scenario log. A later read confirmed the original settings and rulesets, and no active testing workflow or e2e lock remained. An old branch from closed [testing PR #92](https://github.com/civitaspo/testing-csm-ci-client/pull/92) predates this suite and was left untouched.

The docs-only signed head `b0c768888f8f7674aa8608332e58deacb6798eaa` passed smoke 5/5 with no skips: [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40376990679), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40376990907), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40377012077). All testing runs finished and the e2e lock was absent afterward. Only `docs/handoff.md` changed between `f7d936e` and `b0c7688`.

## Post-merge repository settings observation

The post-merge repo-settings suite at `2b0b111eab36e0aab0fcf239d638d5bddc8a6492` [failed](https://github.com/civitaspo/csm-ci-actions/actions/runs/40378375480) with `delete_branch_on_merge drift was not repaired`. Its [server schedule](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40379120296) executed that same actions SHA, detected settings drift, completed the settings PATCH, reported `settingsUpdated: 1`, enabled immutable releases, and created three rulesets. The subsequent single settings GET did not report `delete_branch_on_merge: true`. The harness then restored both repositories and logged their original settings and rulesets.

The failed GET did not log its response values or request identity. These observations do not establish whether the mismatch was delayed read visibility, another settings change, or a persistent write problem. The settings assertion now uses the existing bounded polling helper to require all seven expected settings together, recording only their mismatched expected and actual values. Persistent mismatches still fail at the ten-minute deadline; API errors propagate. Both client and server schedule paths check the settings. A live retry must inspect these observations before attributing the original failure to read visibility.

Local regression coverage checks delayed convergence, each of the seven persistent mismatches and its timeout evidence, and propagation of HTTP 403, 404, and 422. Isolated mutation checks remove each field comparison and accept a mismatched observation; all eight are rejected by these tests. Independent Sol review found no remaining actionable findings. At merged SHA `160764df879cfb864aae1677e1a639aeaad3872d`, the post-merge [repo-settings CI suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40390468062) and [smoke CI suite](https://github.com/civitaspo/csm-ci-actions/actions/runs/40391468215) passed. These successful retries do not establish the cause of the earlier single-GET failure.

## 38. Repository feature settings runtime candidate

The runtime implementation for [issue #66](https://github.com/civitaspo/csm-ci-actions/issues/66) follows the specification merged in [PR 82](https://github.com/civitaspo/csm-ci-actions/pull/82). Global `repo_settings.settings` now accepts optional boolean `has_wiki`, `has_projects`, and `allow_update_branch`. The existing target-scoped administration REST path reports each configured drift, rejects missing configured fields, and reinspects state before applying. Omitted fields remain unmanaged, including when another setting requires a PATCH. Both boolean values are supported. Branch update suggestions do not change the fixed ruleset's `strict_required_status_checks_policy: false` or update branches.

At signed candidate `2d96cbf2cab65cc6c1779d69c9c0fc89f35cc7a5`, local verification passed all 1,175 tests, typecheck, build, clean-dist, jactionlint, and actions-lock verification with the pinned tool versions. All 21 isolated mutations were killed by test failures, with a 20-second per-mutant bound and the original sources preserved. The mutations covered each field's boolean validation, optionality, omitted-value preservation, false-value handling, desired value, and configured-field visibility rejection. Independent review against the issue and approved specification found no actionable code findings.

The repository-settings fixture configures all three fields. At that same signed candidate, the complete repo-settings suite passed 1/1 scenarios with zero skips. It verified [initial reconciliation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40391813910), unchanged replay, omitted-field preservation, schedule reconciliation, and managed-files-only bootstrap. Both testing repositories reported `has_wiki: false`, `has_projects: false`, and `allow_update_branch: true`. The expected [normal-dispatch rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40393079314) reported that the server caller was not distributed and skipped administration writes.

Cleanup restored both repositories to `has_wiki: true`, `has_projects: true`, and `allow_update_branch: false`. Their recorded merge settings, rulesets, and immutable-release state matched the original snapshots. The suite retained the disabled controlled-merges stop and the fixed merge-policy checks. The suite recorded baseline, observed, and restored snapshots. Its eleven server runs were [40391813910](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40391813910), [40392072482](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392072482), [40392203696](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392203696), [40392300012](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392300012), [40392415551](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392415551), [40392538358](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392538358), [40392661716](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392661716), [40392776589](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392776589), [40392883910](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392883910), [40392989556](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40392989556), [40393079314](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40393079314).

Smoke at the same candidate passed 5/5 scenarios with zero skips: [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40393282000), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40393280603), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40393303560). After the final smoke, a fresh read-only check found no e2e lock or active testing workflow. Post-merge CI e2e remains required after an authorized merge. These results establish no production rollout.

## 39. Sponsorship runtime candidate

The runtime for [issue #67](https://github.com/civitaspo/csm-ci-actions/issues/67) implements the contract from [PR 89](https://github.com/civitaspo/csm-ci-actions/pull/89). Optional global `sponsorships` configuration manages the Sponsor button through the existing target administration token. Explicit recipients generate the entire `.github/FUNDING.yml` through the existing signed managed-file PR flow, including when the button is disabled. Omitted recipients preserve existing funding content. Generated ownership rejects an inline producer at the same destination and participates in combined path and size checks. General Server-source additional files remain pending issue #78.

Focused local verification passed 434 tests across configuration, sponsorships, repository administration, managed files, action modes and ownership cleanup, plus typecheck, build, jactionlint and action-lock verification. All 29 isolated rejection and cleanup-ownership mutations failed their behavioral tests within a 20-second per-mutant bound. The full unrelated test suite was omitted for that initial candidate. The live results for the integrated candidate follow below.

Funding delivery on default still requires its normal protected review and merge and exact content verification. A successful toggle or pending funding PR does not establish completion. No App permission change, credential change, or production rollout is claimed here.

Independent review identified that funding commits exceed the old single-path cleanup ownership allowlist. Sponsorship scenarios now pass their explicit funding destination to ownership verification, while other scenarios retain the original allowlist. Behavioral tests reject unknown and empty change sets and cover both-file and funding-only diffs. Three additional isolated mutants prove these checks and the original cleanup failure. Independent Sol medium review found no remaining actionable findings after the correction.

The integrated candidate removes an invalid live collision attempt: the harness validates temporary Server configuration before writing it, so a conflicting funding producer is rejected locally before workflow dispatch. Table-driven configuration tests and isolated mutations cover that rejection; no remote collision result is claimed.

At signed integrated candidate `83d3502d0f6582c6cbbb30c888d697d195a2ef49`, the complete local repo-settings suite passed 4/4 scenarios with zero skips. The existing Server App read and changed `hasSponsorshipsEnabled` in the testing client, with readback for both values. Generated funding content used the signed managed-file PR path. Exact repeats reused the PR and unchanged head. The runs were:

| Scenario | Initial run | Exact repeat | Generated funding PR |
|---|---|---|---|
| `enabled: true` | [40396389370](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40396389370) | [40396523405](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40396523405) | [#766](https://github.com/civitaspo/testing-csm-ci-client/pull/766) |
| `enabled: false` | [40396665288](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40396665288) | [40396797512](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40396797512) | [#767](https://github.com/civitaspo/testing-csm-ci-client/pull/767) |
| `managed-files-only` | [40396943966](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40396943966) | [40397049187](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397049187) | [#768](https://github.com/civitaspo/testing-csm-ci-client/pull/768) |

The harness closed these three funding PRs without merging them. The bootstrap scenario proposed funding content without setting inspection or administration tokens. The existing reconciliation scenario also passed settings and ruleset repair, unchanged replay, schedule preservation of the disabled stop, and bootstrap rejection before administration writes. Its runs were [40397181063](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397181063), [40397303466](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397303466), [40397403789](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397403789), [40397509427](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397509427), [40397668487](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397668487), [40397774572](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397774572), [40397879652](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397879652), [40397992639](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40397992639), [40398101281](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398101281), [40398200082](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398200082), and [40398290004](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398290004). Cleanup restored the sponsorship setting and both repositories' recorded settings, rulesets, and immutable-release state to their original snapshots.

Smoke at the same candidate passed 5/5 scenarios with zero skips: [client App scope](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40398453261), [human-label rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398456266), [Server and approver permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398452434), [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398453944), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40398453078), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40398479592).

These suite runs established candidate behavior before the separate protected-delivery probe below. Changed-recipient updates remain unverified. The plan excludes live changed-content resets of an existing managed branch; local tests retain that coverage. Affected post-merge CI e2e and production deployment remain pending.


### Protected funding delivery and restoration

A separate funding-only probe completed at signed candidate `ead53c278a7e0fab0b52a1b1723ab807081ba3db`, with no skipped probe stages. Every recorded client and server reusable workflow resolved to that exact actions SHA. The [initial proposal](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40404867308) and [identical repeat](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40404969974) used Server configuration commit `6378294297de460b6bc041dd69cf79e2d99f7fa6`. They produced and reused [funding PR #788](https://github.com/civitaspo/testing-csm-ci-client/pull/788) at unchanged GitHub-verified Server head `1c3a8fa7efe9abeab517a4a08e23dc7e6f34058e`.

The native [push CI run 40404936454](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40404936454) passed `status-check` on that exact head. The trusted operator's [/approve](https://github.com/civitaspo/testing-csm-ci-client/pull/788#issuecomment-6427851948) passed through [client](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40405266068) and [server](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40405291276) workflows, resulting in [approver approval](https://github.com/civitaspo/testing-csm-ci-client/pull/788#pullrequestreview-5659379197) and a successful [csm-ci/policy check](https://github.com/civitaspo/testing-csm-ci-client/runs/121860389414). The [/merge](https://github.com/civitaspo/testing-csm-ci-client/pull/788#issuecomment-6427882624) passed through [client](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40405496083) and [server](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40405521802) workflows. The Server App [merged it](https://github.com/civitaspo/testing-csm-ci-client/pull/788#issuecomment-6427898808) through the active protections as `461f11712ff7cf11940d40a68ffafdb65af65bb5`.

At that immutable merged commit, `.github/FUNDING.yml` contained exactly `github: ["civitaspo"]` followed by one newline, blob `81f37fe0fb0f16a3596b9b0554220b1880127038`. The later [no-op reconciliation](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40405758338) skipped managed-file apply, created no PR, and left default at the same merge commit. This establishes default-branch funding delivery separately from the Sponsor button setting.

Funding was absent before the probe. A separate signed restoration head `af5d3930c8150bb71cfe1c84d635c3ab12972ddb` in [PR #789](https://github.com/civitaspo/testing-csm-ci-client/pull/789) deleted only that funding file. Its native [push CI](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40405963445), [/approve](https://github.com/civitaspo/testing-csm-ci-client/pull/789#issuecomment-6427963342), and [/merge](https://github.com/civitaspo/testing-csm-ci-client/pull/789#issuecomment-6427990604) passed the same gates. Server [approval](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40406106819) and [merge](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40406303629) workflows produced the [restoration receipt](https://github.com/civitaspo/testing-csm-ci-client/pull/789#issuecomment-6428004777). The Server App merged it as `43137b63a3ff48cad0765328baca9cc429b94032`, where funding was absent again.

An earlier interrupted attempt left [PR #786](https://github.com/civitaspo/testing-csm-ci-client/pull/786) and [PR #787](https://github.com/civitaspo/testing-csm-ci-client/pull/787) closed and unmerged. Their exact-owned branch cleanup preceded the fresh probe; they establish no changed-recipient acceptance result. Final restoration removed only temporary ruleset IDs `25914749` and `25914751` and restored the original settings and rulesets, preserving `25798106` and `25785295`. The temporary Server configuration was restored to blob `17d693c818a9eb068b304df72011de6494cf1755`. The durable testing-client CI fixture installed through [PR #785](https://github.com/civitaspo/testing-csm-ci-client/pull/785) remains on default. Final verification confirmed funding absence, no open probe PRs or active runs, conditional cleanup of owned branches, and release of the e2e lock after restoration. These testing-repository results establish no production rollout.

## CI aggregation live verification

At signed candidate `10f3b59d81f520b3bc5a64ef0d3434b7d5609dba`, an isolated testing-client fixture exercised the candidate PR entry and aggregator with deterministic leaf jobs. The new-branch [push run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40424410152) and [successful PR run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40424675930) passed. In the [failure run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40425142607), English and runtime initially failed. Rerunning only English succeeded while the outer check remained failed; rerunning runtime then made the outer check succeed. GitHub represented the unchanged runtime job in attempt 2 with a new job ID and attempt number, but the original execution times and all steps remained identical. GitHub rejected a rerun of the original attempt's job ID; the selected runtime rerun used the corresponding current-attempt job ID.

The [cancellation run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40425774323) cancelled the running English job and did not report a successful outer check. The [documentation-only run](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40426095734) passed with the workflow check skipped. These isolated cases verify aggregation and selected reruns; they do not replace verification of the actual candidate PR's checks. Funding-only path selection remains covered locally, not by this live experiment.

Smoke at the same candidate passed 5/5 scenarios with zero skips: [client App scope](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40410198659), [Server and approver permissions](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40410198075), [human-label rejection](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40410200694), [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40410198438), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40410197836), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40410216510). The four fixture PRs were closed unmerged, owned refs were deleted with exact SHA leases, and final checks confirmed the original testing-repository settings, rulesets, default commits, and funding state. All related runs finished before the e2e lock was released.

## 40. Semantic release pull request title verification

For [issue #69](https://github.com/civitaspo/csm-ci-actions/issues/69), the local `release-pr` suite passed 5/5 scenarios with zero skips at signed candidate `71101b83a7dd396d7f8266d39b74281831a3ac77`, based on `2687e1712e6c4d0ee5995990c4600e75c9b2baae`. Explicit preparation created [PR #771](https://github.com/civitaspo/testing-csm-ci-client/pull/771) with the exact title `chore(release): v1.1.1793047934169`. After the scenario replaced that title with the old route-prefixed form, [repeated preparation](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40399628209) and [server application](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40399667605) restored the semantic title while retaining the PR number and generated head. The suite also passed fixed-manifest preparation, [push-based version inference](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40399792687), invalid-version rejection, and non-default-branch dispatch suppression.

At the same candidate, `securefix` passed 14/14 scenarios with zero skips. The [fresh route request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40400750723) and [retry](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40400904011) verified creation and metadata repair for an ordinary route, whose title retains its route prefix. The suite also covered PR-mode writes and the existing artifact, path, size, event, base-branch, workflow-change, version-only, and default-branch restrictions. Smoke passed 5/5 with zero skips, including [server check](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40401392822), [client request](https://github.com/civitaspo/testing-csm-ci-client/actions/runs/40401392507), and [server intake](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40401414254).

These preparation scenarios close their generated PRs without merging them. A protected release PR merge and the resulting default-branch commit subject remain unverified for this candidate, pending a separate probe. Post-merge CI suites remain required after an authorized merge. These results establish no production rollout.
