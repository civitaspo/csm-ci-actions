# csm-ci merge

Validate a `/merge` or `/merge cancel` comment and create, replay, or cancel its durable reservation. The server workflow calls the action twice for a new merge request: a read-only `prepare` call, then a revalidating `accept` call after it conditionally mints the narrowly scoped write tokens.

See [merge behavior](../../../docs/merge.md) for authorization, auto-merge disarming, reservation, and receipt rules. This action is a trusted workflow component, not a standalone event handler.

## Inputs

| Input | Required | Default | Value |
|---|---:|---|---|
| `mode` | Yes | None | `prepare` validates without writes; `accept` repeats validation and performs the request. |
| `github-token` | No | `${{ github.token }}` | Server repository token with `contents:read` for `csm-ci.yaml`. |
| `config-path` | No | `csm-ci.yaml` | Config path in the server repository. |
| `server-token` | Yes | None | Target-scoped Server App token with contents, pull requests, checks, and issues read access. |
| `deployments-token` | Yes | None | Server repository token with `deployments:read` for `prepare` or `deployments:write` for `accept`. |
| `notification-token` | No | None | Target-scoped Server App token with `issues:write` and `pull_requests:write`; required only for an accept path that writes a receipt. |
| `acceptance-write-token` | No | None | Target-scoped Server App token with only `pull_requests:write`; minted only after `prepare` returns `accept` and used only to disarm native auto-merge. |
| `display-commit-token` | No | None | Server-scoped `contents:write` token for the optional reservation display commit. |
| `display-deployments-token` | No | None | Client-scoped `deployments:write` token for the optional display projection. |
| `repository` | Yes | None | Client repository as `owner/repo`. |
| `args` | Yes | None | JSON intake request numbers, such as `{"pull_number":123,"comment_id":456}`. |

## Outputs

| Output | Value |
|---|---|
| `acceptance-kind` | Read-only preparation result: `accept`, `cancel`, `replay`, `conflict`, `external-merge`, or `external-merge-replay`. |
| `reservation-id` | Deployment ID when a reservation is returned. |

The preparation result controls token minting only. The `accept` call repeats the full command, identity, repository, pull request, replay, and head checks before any write. It does not trust the preparation output as authorization. A valid cancellation, replay, active-reservation conflict, or previously recorded external merge does not receive the acceptance write token.

## Workflow order

The server workflow is the source of truth for token scopes and conditions. Its merge path has this order:

1. Mint read-only client and server deployment tokens.
2. Run `prepare` with those tokens. It validates the exact comment and merger and reads existing reservations.
3. Only when `acceptance-kind` is `accept`, mint a client token with only `pull_requests:write` and a server deployment token with only `deployments:write`.
4. Mint notification and optional display tokens only for preparation outcomes that need them.
5. Run `accept` for valid preparation results. The action repeats validation and then disarms native auto-merge before creating a reservation.

Keep the conditions and token permissions in [server.yml](../../../.github/workflows/server.yml) synchronized with this contract. Invalid non-cancellation commands fail during `prepare` and do not mint the client-scoped acceptance write token. A cancellation-shaped command may receive the separate notification token, but `cancel` revalidates ownership and reservation state before any write; it never receives the acceptance token. If the pull request changes between the two calls, `accept` fails closed before writing.
