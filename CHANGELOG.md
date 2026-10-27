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

### 🚜 Refactor

- *(ci)* Aggregate checks through reusable workflows
- *(workflows)* Declare explicit secret contracts

### 🧪 Testing

- *(merge)* Exercise native bot comment requests

### ⚙️ Miscellaneous Tasks

- *(merge)* Update the actions caller and Renovate requests
- *(renovate)* Disable Dependency Dashboard
- *(release)* V0.2.0

### 💼 Other

- *(release-pr)* Install git-cliff from a pinned release digest
## [0.1.0] - 2026-10-25

### 🚀 Features

- *(policy-check)* Enforce head-bound sensitive path policies (#8)
- *(merge)* Squash approved pull requests with current policy checks (#9)
- *(securefix)* Apply bounded generated changes through server validation (#11)
- *(release)* Publish immutable releases with verified attestations (#14)
- *(release-pr)* Prepare releases through securefix (#21)
- *(repo-settings)* Reconcile repository settings and managed files (#23)
- *(securefix)* Make the client a single action (#29)
- *(ci)* Prepare actions releases through csm-ci

### 🐛 Bug Fixes

- *(github)* Bound request timeouts and retry safe reads (#6)
- *(e2e)* Accept shared loader rejection for edited merge comments (#10)
- *(release)* Tolerate tag visibility delays (#17)
- *(repo-settings)* Address the final whole-diff review (#26)
- *(repo-settings)* Enforce bootstrap boundaries and history proofs (#32)
- *(repo-settings)* Allow the configured actions repository as a client (#35)

### 📚 Documentation

- *(handoff)* Point at the rebuilt history (#1)
- *(handoff)* Add e2e parallelism and API timeouts as next work (#5)
- *(release)* Record verified attestation contract (#13)
- *(plan)* Record Phase 6 repo-settings decisions (#22)
- *(cutover)* Add the production cutover runbook (#24)
- *(handoff)* Add the final report through Phase 7 (#25)
- *(plan)* Make the securefix client a single action (#27)
- *(plan)* Lay out actions by side and split client actions by use (#28)
- *(plan)* Define managed-files-only bootstrap mode (#31)
- Document client and server action usage (#33)
- *(plan)* Include the actions repository in production management (#34)

### 🚜 Refactor

- *(actions)* Align public interfaces with planned layout (#30)

### 🧪 Testing

- *(e2e)* Run correlated feature scenarios in parallel (#7)

### ⚙️ Miscellaneous Tasks

- *(ci)* Bootstrap managed client callers (#36)
- *(release)* V0.1.0
