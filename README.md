# csm-ci-actions

Secure CI for GitHub repositories that grants no write access to the repositories themselves.

csm-ci-actions is strongly inspired by [csm-actions/securefix-action](https://github.com/csm-actions/securefix-action) and its [Client-Server Model](https://github.com/csm-actions/docs). It follows the same idea:

- Client repositories hold no powerful credential. A client workflow can only create a label in a server repository.
- One server repository holds the powerful GitHub App key. Its workflow re-reads every fact from the GitHub API, validates it, and acts on the client repository.

On top of that model, csm-ci-actions adds approve, merge, policy-check, release and repo-settings, and hardens securefix against time-of-check to time-of-use races.

The project is under construction. Phase 0 (the request round trip, the commit trust rules and the e2e harness) and Phase 1 (approve) are in place. See [docs/first-release-plan.md](docs/first-release-plan.md) for the design and the phases.

## How it works

1. A client workflow mints a Client App token for the server repository only and creates a label named `csm-ci-<op>-<random>`. The label description is a locator: `owner/repo/<pull request or run number>[/<comment id>]`.
2. The label starts the server workflow (`label: created`), which calls [`server.yml`](.github/workflows/server.yml).
3. The `intake` job rejects the label unless the Client App bot created it, it names a managed repository and an enabled op, it still exists unchanged, and the run is a first attempt.
4. The `op` job runs in the `csm-ci` environment, one at a time per pull request, with a Server App token scoped to that one repository.
5. The `cleanup` job always deletes the label.

The server never trusts the label beyond which repository and number to look at. Every decision uses facts it reads from the API itself.

GitHub requests have a timeout and bounded retries for reads. See [GitHub API requests](docs/github-api.md) for the limits and write recovery behavior.

## GitHub Apps

| App | Installed on | Repository permissions | Key stored in |
|---|---|---|---|
| `csm-ci-client` | the server repository only | Issues: write | every client repository |
| `csm-ci-server` | the server and every client repository | Contents, Pull requests, Issues, Checks, Workflows, Administration and Attestations: write. Actions: read | the server repository, environment `csm-ci` (main only) |
| `csm-ci-approver` | every client repository | Pull requests: write. Contents: write, because an App approval counts toward required approvals only with it | the server repository, environment `csm-ci` |

Each server job mints a token for one repository with only the permissions that job needs. Administration is minted only by the repo-settings job.

## Known compromises

- The Client App key is in every client repository. Anyone who can run a workflow there can create request labels. The server re-reads every fact, so a forged label gets the same result as a real one.
- The Server App key is shared by all server jobs. Narrow tokens per job are discipline, not a boundary, so a compromised job could mint an Administration token.
- Required checks produced by GitHub Actions can be changed by a pull request author with write access. The real gates are the approval and the `csm-ci/policy` check.
- Pull requests from forks are out of scope for securefix.

## Differences from securefix-action

- The same label transport, with a stricter intake: sender bot id, enabled op, live label and first attempt.
- securefix rejects a request when the branch moved after the request, and writes with an expected-head compare-and-swap.
- New operations: approve, merge, policy-check, release and repo-settings.
- The Server App bot is never a trusted committer. Its commits are trusted only through the server's own write paths.

## Setup

See [docs/setup.md](docs/setup.md).

## Development

```sh
mise install
bun install --frozen-lockfile --ignore-scripts
bun run typecheck && bun test && bun run build
```

`dist/` is committed and CI fails when it differs from the build output. The e2e scenarios run against the testing repositories with `bun e2e/run.ts --ref <sha>`, or from the `e2e` workflow.

## License

[MIT](LICENSE)
