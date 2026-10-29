# Changelog

All notable changes to this project are documented in this file.

## [0.5.0] - 2026-10-29

### 🚀 Features

- *(e2e)* Add cooperative cancellation ([#201](https://github.com/civitaspo/csm-ci-actions/pull/201))
- *(e2e)* Link pull request in run summary ([#204](https://github.com/civitaspo/csm-ci-actions/pull/204))
- *(merge)* Implement automerge reservations ([#199](https://github.com/civitaspo/csm-ci-actions/pull/199))

### 🐛 Bug Fixes

- *(e2e)* Associate deployments with pull request heads ([#202](https://github.com/civitaspo/csm-ci-actions/pull/202))
- *(e2e)* Clarify pull request summary ([#205](https://github.com/civitaspo/csm-ci-actions/pull/205))

### 📚 Documentation

- *(e2e)* Verify affected suites on pull requests ([#200](https://github.com/civitaspo/csm-ci-actions/pull/200))
- *(merge)* Specify csm-ci automerge ([#198](https://github.com/civitaspo/csm-ci-actions/pull/198))

### ⚙️ Miscellaneous Tasks

- *(repo-settings)* Sync managed files ([#192](https://github.com/civitaspo/csm-ci-actions/pull/192))

## [0.4.0] - 2026-10-28

### 🚀 Features

- *(e2e)* Run live e2e from a /e2e pull request comment
- *(merge)* Prefer platform auto-merge with a self-merge fallback
- *(e2e)* Run the PR's own harness for the owner's verified commits
- *(github)* Log rate-limit usage per client when each job exits
- *(setup)* Title server runs with the request label and description

### 🐛 Bug Fixes

- *(policy)* Serialize approve and policy-check publication per pull request
- *(e2e)* Grant PR write and comment the run URL when /e2e starts
- *(e2e)* Run /e2e logic in TypeScript and give its job the e2e environment

### 🚜 Refactor

- *(release)* Replace the Python release helpers with TypeScript

### 📚 Documentation

- Replace the first-release plan with a design document
- Link csm-ci-server migration records at a fixed commit
- *(agents)* Record lessons from the issue batch rollout
- Drop the cutover runbook and handoff log
- *(merge)* Derive the readiness poll interval from the deadline
- Fold production recovery into break glass
- *(merge)* Prefer platform auto-merge with a self-merge fallback
- *(e2e)* Allow the /e2e command to run the PR's harness

### ⚡ Performance

- *(e2e)* Run several features under one lock and derive the merge poll interval

### ⚙️ Miscellaneous Tasks

- *(scripts)* Replace the setup wizard with a skill and port the e2e mutation script to TypeScript
- *(dist)* Mark dist as generated in pull request diffs
- *(deps)* Update jdx/mise-action action to v5.2.4
- *(deps)* Update actions/attest action to v3.2.0
- *(deps)* Update actions/download-artifact action to v8.0.2
- *(deps)* Update dependency bun to v1.4.4
- *(deps)* Update dependency go to v1.27.3
- *(deps)* Update github artifact actions (major)
- *(deps)* Update actions/attest action to v4
- *(deps)* Update dependency ubuntu to v26
- *(deps)* Update civitaspo/csm-ci-actions action to v0.3.1

## [0.3.1] - 2026-10-27

### 🐛 Bug Fixes

- *(server)* Let /approve run while /merge waits on the same pull request
- *(securefix)* Keep route and managed-file pull requests open when their branch is rebuilt
- *(merge)* End the squash commit title with the pull request number

### 📚 Documentation

- *(handoff)* Record stacked verification, v0.2.0 and the caller rollout

### ⚙️ Miscellaneous Tasks

- *(repo-settings)* Sync managed files
- *(changelog)* Define the CHANGELOG format with cliff.toml

## [0.3.0] - 2026-10-27

### 🚀 Features

- *(repo-settings)* Generate standard client workflows from enabled ops
- *(e2e)* Explain test PR intent with descriptions and case labels
- *(release-pr)* Replace update-root-version with explicit version files

### 🐛 Bug Fixes

- *(repo-settings)* Keep generated callers stable under client autofix
- *(repo-settings)* Annotate generated callers for jactionlint
- *(repo-settings)* Regenerate standard callers on every run

### 🚜 Refactor

- *(repo-settings)* Select reconciliation targets explicitly instead of modes

## [0.2.0] - 2026-10-27

### 🚀 Features

- *(release)* Preserve dbt package root versions
- *(release)* Preserve raw Rust binary contracts
- *(release)* Preserve Terraform Registry signing
- *(skills)* Package the Renovate review procedure
- *(repo-settings)* Manage sponsorships and funding recipients
- *(repo-settings)* Load additional managed files from Server repository files
- *(policy)* Add repository policy overrides
- *(policy-check)* Report rejection reasons and resolve comments after passing
- *(policy)* Remove repository-name protection

### 🐛 Bug Fixes

- *(release)* Lock dependencies in shared release workflows
- *(client)* Lock all shared request workflows
- *(merge)* Forward bot requests on their own pull requests
- *(e2e)* Preserve release verification across fixture types
- *(merge)* Allow explicitly approved workflow changes
- *(e2e)* Pin the public Terraform verification fingerprint
- *(policy)* Skip checks for closed pull requests
- *(repo-settings)* Enforce PR squash title and description
- *(e2e)* Wait for repository settings to converge
- *(repo-settings)* Reconcile wiki, projects, and branch updates
- *(release-pr)* Preserve semantic pull request titles
- *(notifications)* Restore context and run links in approval and merge comments
- *(repo-settings)* Use a Conventional Commit title for managed-file pull requests

### 🚜 Refactor

- *(ci)* Aggregate checks through reusable workflows
- *(workflows)* Declare explicit secret contracts

### 📚 Documentation

- *(plan)* Preserve dbt package release versions
- *(release)* Specify raw Cargo binary publication
- *(plan)* Support lockfile-enforced release callers
- *(plan)* Cover all locked client workflows
- *(release)* Specify Terraform provider signing
- *(plan)* Permit bot merge requests on their own pull requests
- Define the development workflow and troubleshooting checks
- *(repo-settings)* Define squash commit message reconciliation
- *(renovate)* Define supervised agent review procedure
- *(repo-settings)* Specify repository feature settings
- *(merge)* Permit workflow writes on the final merge token
- *(policy)* Specify failure reports and resolved recovery
- *(policy)* Specify repository overrides and protected migration
- *(repo-settings)* Specify sponsorship configuration and funding ownership
- *(repo-settings)* Specify Server-source managed files and migration
- *(workflows)* Define explicit secret contracts
- *(repo-settings)* Specify generated client workflow ownership
- *(plan)* Define the repository-owned git-cliff installer

### 🧪 Testing

- *(merge)* Exercise native bot comment requests

### ⚙️ Miscellaneous Tasks

- *(merge)* Update the actions caller and Renovate requests
- *(renovate)* Disable Dependency Dashboard

### 🛡️ Security

- *(release-pr)* Install git-cliff from a pinned release digest

## [0.1.0] - 2026-10-25

### 🚀 Features

- *(policy-check)* Enforce head-bound sensitive path policies ([#8](https://github.com/civitaspo/csm-ci-actions/pull/8))
- *(merge)* Squash approved pull requests with current policy checks ([#9](https://github.com/civitaspo/csm-ci-actions/pull/9))
- *(securefix)* Apply bounded generated changes through server validation ([#11](https://github.com/civitaspo/csm-ci-actions/pull/11))
- *(release)* Publish immutable releases with verified attestations ([#14](https://github.com/civitaspo/csm-ci-actions/pull/14))
- *(release-pr)* Prepare releases through securefix ([#21](https://github.com/civitaspo/csm-ci-actions/pull/21))
- *(repo-settings)* Reconcile repository settings and managed files ([#23](https://github.com/civitaspo/csm-ci-actions/pull/23))
- *(securefix)* Make the client a single action ([#29](https://github.com/civitaspo/csm-ci-actions/pull/29))
- *(ci)* Prepare actions releases through csm-ci

### 🐛 Bug Fixes

- *(github)* Bound request timeouts and retry safe reads ([#6](https://github.com/civitaspo/csm-ci-actions/pull/6))
- *(e2e)* Accept shared loader rejection for edited merge comments ([#10](https://github.com/civitaspo/csm-ci-actions/pull/10))
- *(release)* Tolerate tag visibility delays ([#17](https://github.com/civitaspo/csm-ci-actions/pull/17))
- *(repo-settings)* Address the final whole-diff review ([#26](https://github.com/civitaspo/csm-ci-actions/pull/26))
- *(repo-settings)* Enforce bootstrap boundaries and history proofs ([#32](https://github.com/civitaspo/csm-ci-actions/pull/32))
- *(repo-settings)* Allow the configured actions repository as a client ([#35](https://github.com/civitaspo/csm-ci-actions/pull/35))

### 🚜 Refactor

- *(actions)* Align public interfaces with planned layout ([#30](https://github.com/civitaspo/csm-ci-actions/pull/30))

### 📚 Documentation

- *(handoff)* Point at the rebuilt history ([#1](https://github.com/civitaspo/csm-ci-actions/pull/1))
- *(handoff)* Add e2e parallelism and API timeouts as next work ([#5](https://github.com/civitaspo/csm-ci-actions/pull/5))
- *(release)* Record verified attestation contract ([#13](https://github.com/civitaspo/csm-ci-actions/pull/13))
- *(plan)* Record Phase 6 repo-settings decisions ([#22](https://github.com/civitaspo/csm-ci-actions/pull/22))
- *(cutover)* Add the production cutover runbook ([#24](https://github.com/civitaspo/csm-ci-actions/pull/24))
- *(handoff)* Add the final report through Phase 7 ([#25](https://github.com/civitaspo/csm-ci-actions/pull/25))
- *(plan)* Make the securefix client a single action ([#27](https://github.com/civitaspo/csm-ci-actions/pull/27))
- *(plan)* Lay out actions by side and split client actions by use ([#28](https://github.com/civitaspo/csm-ci-actions/pull/28))
- *(plan)* Define managed-files-only bootstrap mode ([#31](https://github.com/civitaspo/csm-ci-actions/pull/31))
- Document client and server action usage ([#33](https://github.com/civitaspo/csm-ci-actions/pull/33))
- *(plan)* Include the actions repository in production management ([#34](https://github.com/civitaspo/csm-ci-actions/pull/34))

### 🧪 Testing

- *(e2e)* Run correlated feature scenarios in parallel ([#7](https://github.com/civitaspo/csm-ci-actions/pull/7))

### ⚙️ Miscellaneous Tasks

- *(ci)* Bootstrap managed client callers ([#36](https://github.com/civitaspo/csm-ci-actions/pull/36))

<!-- generated by git-cliff -->
