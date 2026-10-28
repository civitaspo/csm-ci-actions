---
name: csm-ci-setup
description: Guide the operator through registering and installing the csm-ci GitHub Apps and storing their credentials for one server repository and its client repositories. Use when asked to set up csm-ci, add a client repository, or rebuild a testing environment.
---

# Set up csm-ci Apps and credentials

Names of Apps, environments, variables and secrets come only from the [Naming list](../../../docs/design.md#naming-list). For a test setup, prefix App names with `testing-`. Follow [docs/setup.md](../../../docs/setup.md) for the surrounding steps.

Agents never create, read, register, revoke or change private keys, PATs or App permissions. The operator performs every step below that touches a key or a permission. The agent prints the exact page and values, waits for the operator, and then verifies with metadata-only checks (secret and variable names, installation repositories).

## Collect

Ask once for the owner, the App name prefix, the server repository and the client repositories. Check `gh auth status` and that each repository exists.

## Environment

In the server repository, create environment `csm-ci` limited to deployments from `main` (custom branch policy `main`, `protected_branches: false`).

## Apps

For each App, the operator opens `https://github.com/settings/apps/new?name=<prefix>csm-ci-<role>&url=https://github.com/<owner>/<server>&public=false&webhook_active=false&<permission>=<level>...`, confirms the repository permissions are exactly those listed, leaves the webhook inactive and "Only on this account" selected, creates the App, generates a private key, and copies the Client ID and App ID. Then the operator installs it on exactly the listed repositories at `https://github.com/apps/<name>/installations/new`.

| Role | Query parameters | Install on |
|---|---|---|
| `server` | `contents=write pull_requests=write issues=write checks=write actions=read workflows=write administration=write attestations=write` | server and every client |
| `client` | `issues=write` | server only |
| `approver` | `pull_requests=write contents=write` | every client |

## Credentials

The operator stores them with `gh variable set` and `gh secret set` (key file on stdin):

- Server repository, environment `csm-ci`: `CSM_CI_SERVER_APP_CLIENT_ID`, `CSM_CI_SERVER_APP_PRIVATE_KEY`, `CSM_CI_APPROVER_APP_CLIENT_ID`, `CSM_CI_APPROVER_APP_PRIVATE_KEY`.
- Each client repository: `CSM_CI_CLIENT_APP_CLIENT_ID`, `CSM_CI_CLIENT_APP_PRIVATE_KEY`, `CSM_CI_SERVER_REPOSITORY` (`<owner>/<server>`).

Afterwards the operator deletes the downloaded `.pem` files.

## Bot user IDs

For `csm-ci.yaml`, print `gh api "users/<prefix>csm-ci-<role>%5Bbot%5D" --jq .id` for `client`, `server` and `approver`, and the server App ID from its settings page: `apps: { client_bot_id, server_app_id, server_bot_id }`, plus the approver bot ID.
