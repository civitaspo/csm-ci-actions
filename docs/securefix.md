# Securefix

Securefix packages generated working-tree changes from a client workflow, then asks the server to validate and write those changes. The artifact is the only client-supplied content the server applies; the request label contains the workflow run id, and the server fetches run and artifact metadata from GitHub.

## Client workflow

Run `civitaspo/csm-ci-actions/actions/securefix-client@<ref>` in the job that generates the changes. It reads the client repository worktree, rejects unsafe paths, symlinks, submodules, non-regular files, and files over 8 MB; it also enforces a 512-file limit and 10 MB total. It creates a strict manifest with repository, run id, head SHA, commit message, file sizes and SHA-256 digests, then uploads the artifact with the official `actions/upload-artifact` action under the name `securefix`.

Call `civitaspo/csm-ci-actions/.github/workflows/client-securefix.yml@<ref>` from a dependent job after the packaging job. The reusable workflow has access to the same caller run id, mints the Client App token for the server repository, and sends the `securefix` request. A workflow run has a separate runner per job, so the package action must run after generation in the client job; the reusable request workflow does not attempt to read that job's workspace. Use `secrets: inherit` on the reusable-workflow job so it can access the Client App key.

The reusable workflow accepts `pull_request`, `push`, and `workflow_dispatch` runs; fork pull requests are skipped. Server-side binding remains authoritative. PR mode requires exactly one open, ready PR from the same repository to the default branch. Route mode requires a configured workflow path and source branch.

## Server configuration

`securefix` settings are global. A repository must also list `securefix` in its `ops`:

```yaml
securefix:
  allow_workflow_changes: false
  routes:
    - name: release-pr
      from: default
      to: release/next
      workflow: .github/workflows/release-pr.yml
      paths:
        CHANGELOG.md: any
        .release-version: semver
        package.json: version-only
repositories:
  - name: owner/repository
    ops: [securefix]
```

The route workflow path must be under `.github/workflows/`; it is matched against the workflow run path. `from: default` means the repository's current default branch. Each route writes only to its configured `to` branch, and each artifact path must match a route rule. `any` permits any safe file contents; `semver` permits only `.release-version` with a semantic version; `version-only` permits changes only on version lines in that file. A route cannot write to the default branch or to its source branch.

Set `allow_workflow_changes: true` only when the server should mint `workflows: write` for an otherwise valid artifact that changes `.github/workflows/**`. Workflow changes are rejected when the setting is false.

## Validation and retry behavior

The server accepts only the first attempt of a same-repository run and rejects `pull_request_target`. It requires exactly one `securefix` artifact and rejects it if expired. The official download action fetches the verified artifact ID with a two-minute timeout and extracts into a 12 MiB temporary filesystem capped at 1,024 inodes; this bounds expanded archive bytes and entry count before the manifest is read. The server then checks the manifest and extracted payload again, including path safety, symlinks, sizes, digest, and metadata bindings. The message cannot contain `csm-ci-`.

For PR mode, the run must map to exactly one open, ready PR, the branch must have exactly one open PR, the PR base must be the default branch, and the current head must still equal the run head. The server writes with GraphQL `createCommitOnBranch(expectedHeadOid=run.head_sha)` so a concurrent branch update fails. A retry succeeds only when the branch head is a GitHub-verified server commit whose parent is the run head and whose changed file contents match the artifact.

Route mode validates the source head and every existing route-branch commit against the configured path rules. It creates or updates one open PR from the route branch to its source branch, setting a server-owned title and body. An executable bit cannot be set by `createCommitOnBranch`; creating a new executable file is unsupported.

Requests use the existing per-request concurrency key. Separate securefix runs can proceed independently; expected-head and Git lease checks reject competing writes. A repository-wide concurrency group would let GitHub replace an unrelated pending request. The server passes the caller's `config-path` to every securefix stage.
