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
