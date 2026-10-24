# AGENTS.md

Rules for anyone, human or agent, who changes this repository.

## Language

- Everything committed here is English: code, comments, docs, commit messages, PR titles and PR bodies. The repository is public and its history stays readable by anyone. CI fails on CJK characters in tracked files.
- Never commit a draft in another language and translate it later. The draft stays in the file's history. Translate before the first commit.

## Changes and merges

- Never push directly to `main`. Open a pull request and squash-merge it.
- PR titles follow Conventional Commits, for example `feat(approve): ...` or `fix(e2e): ...`.
- PR bodies use the sections Why, What changed, Scope, Tradeoffs, Blast Radius and Verification. Drop a section that has nothing to say.
- Sign commits.
- Merge only when CI (`status-check`) is green. An agent merges only when the user said so for that PR.

## Before opening a pull request

Run these and make them pass:

```sh
mise install
bun install --frozen-lockfile --ignore-scripts
bun run typecheck && bun test && bun run build
test -z "$(git status --porcelain dist/)"   # dist/ is committed and must match the build
mise exec -- jactionlint
```

## Specification and documents

- [docs/first-release-plan.md](docs/first-release-plan.md) is the specification for the first release. Do not add features it does not describe. Change the plan in its own PR first.
- [docs/handoff.md](docs/handoff.md) records the verified GitHub behavior, the testing environment and the working process. Read it before changing anything.
- Each operation has a page, such as [docs/approve.md](docs/approve.md). Keep it in sync with the code.
- Names of Apps, environments, variables and secrets come only from the plan's "Naming list".

## Quality bar

- Every rejection rule has a row in a table-driven test that also checks the error message.
- Mutation-check the rules: remove each rule and confirm a test fails.
- Never swallow API errors. Branch only on the status that means "missing" (404 or 422) and rethrow everything else.
- Verify assumptions about GitHub against real runs in the testing repositories, and record the run URLs. Do not rely on documentation alone.
- Before a pull request, get an independent review of the diff against the specification.
- Run the e2e scenarios for the feature you changed: `GH_TOKEN=$(gh auth token) bun e2e/run.ts --ref <head sha> --feature <name>`. A lock serializes runs. If you kill a run, delete the `e2e-lock` label and close leftover `e2e-*` pull requests in the testing client.

## Secrets

- Strong credentials live only in the server repository's `csm-ci` environment. Client repositories hold only the Client App key.
- Agents never create, read, register or change private keys, PATs or GitHub App permissions. Ask the user.
