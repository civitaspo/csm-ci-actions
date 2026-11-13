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
| `deployments-token` | Yes | None | Server repository token with `deployments:read` for `prepare` or `deployments:write` for a prepared acceptance or authorized cancellation. |
| `notification-token` | No | None | Target-scoped Server App token with `issues:write` and `pull_requests:write`; required only for an accept path that writes a receipt. |
| `acceptance-write-token` | No | None | Client-repository-scoped Server App token with `contents:write` and `pull_requests:write`; minted only after `prepare` returns `accept` and used only to disarm native auto-merge. GitHub does not scope this token to one pull request. |
| `display-commit-token` | No | None | Server-scoped `contents:write` token for the optional reservation display commit. |
| `display-deployments-token` | No | None | Client-scoped `deployments:write` token for the optional display projection. |
| `repository` | Yes | None | Client repository as `owner/repo`. |
| `args` | Yes | None | JSON intake request numbers, such as `{"pull_number":123,"comment_id":456}`. |

## Outputs

| Output | Value |
|---|---|
| `acceptance-kind` | Read-only preparation result: `accept`, `cancel`, `replay`, `conflict`, `external-merge`, or `external-merge-replay`. |
| `reservation-id` | Deployment ID when a reservation is returned. |

The preparation result controls token minting only. The `accept` call repeats the full command, identity, repository, pull request, replay, and head checks before any write. It does not trust the preparation output as authorization. A valid cancellation is authorized against the current reservation during read-only preparation and revalidated before a write. An invalid cancellation and a previously recorded external-merge replay receive no client-repository write token. An active-reservation conflict, valid cancellation, or existing reservation replay may receive the client-scoped notification token (`issues:write` and `pull_requests:write`) needed for its receipt. Only a fresh `accept` receives the separate client-scoped acceptance token (`contents:write` and `pull_requests:write`) used to disable native auto-merge. The optional client-scoped deployments token is separately minted only for `accept`, `cancel`, or `replay` to synchronize the display projection; a conflict does not receive it.

## Workflow order

The server workflow is the source of truth for token scopes and conditions. Its merge path has this order:

1. Mint read-only client and server deployment tokens.
2. Run `prepare` with those tokens. It validates the exact comment and merger, reads existing reservations, and authorizes a cancellation before returning `cancel`.
3. Only when `acceptance-kind` is `accept`, mint a client token with only `contents:write` and `pull_requests:write`. When the result is `accept`, `cancel`, or `replay`, mint a separate client-repository token with only `deployments:write` for the display projection. When the result is `accept` or an authorized `cancel`, mint a server-repository token with only `deployments:write`.
4. Mint notification and optional display tokens only for preparation outcomes that need them.
5. Run `accept` for valid preparation results. The action repeats validation and applies the requested reservation operation; new acceptances disarm native auto-merge before creating a reservation.

Keep the conditions and token permissions in [server.yml](../../../.github/workflows/server.yml) synchronized with this contract. Invalid requests fail during `prepare` and mint neither client write token. A cancellation-shaped command may receive the separate notification token, but only an authorized cancellation receives the server Deployment token; `cancel` revalidates ownership and reservation state before any write and never receives the client-scoped acceptance token. If the pull request changes between the two calls, `accept` revalidates the current pull request and checks it again after disabling auto-merge. A newer head may be accepted when it passes the fresh checks, even when the prepare stage observed an older head.
