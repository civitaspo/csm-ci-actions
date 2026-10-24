# Merge

`/merge` asks csm-ci to squash-merge the current head of an open pull request. The command takes no argument. It is accepted only from an account listed in `trust.mergers`, or from a bot listed in `trust.bot_mergers` when that bot authored the pull request and every commit.

The server checks the pull request state and the S3 trust rules before waiting. Every poll re-reads the pull request and command comment, evaluates the configured policies against current GitHub state, checks that the latest review from the configured approver is an approval for the pinned head, and verifies each configured required check by name and GitHub App ID. A moved head, invalidated comment, or failed trust check aborts the request. Readiness polling runs every 30 seconds until `merge.deadline_minutes` expires.

The server mints its write token only after readiness succeeds. It revalidates readiness before calling GitHub's squash merge endpoint with the pinned head SHA. HTTP 405, 422, and 503 responses are retried only after another complete validation. HTTP 409 fails immediately. A successful response must report `merged: true`.

The squash commit uses the pull request title and body. Duplicate `Co-authored-by` lines in the body are removed. The server posts a receipt containing `<!-- csm-ci:merge:<comment_id> -->` when the operation completes after the write token has been minted. A receipt authored by the Server bot prevents replay.

The client workflow listens for newly created issue comments and requests work only for pull requests from commenters with OWNER, MEMBER, or COLLABORATOR association whose body is exactly `/merge`. The server independently verifies the comment author by immutable ID and bot or user type.

`bun e2e/run.ts --ref <sha> --feature merge` exercises the merge scenarios against the testing repositories.
