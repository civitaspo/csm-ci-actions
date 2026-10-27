# Release pull requests

Reusable client callers declare and map only `CSM_CI_CLIENT_APP_PRIVATE_KEY`. See the [secret contract and staged migration](setup.md#explicit-secret-contract-migration) for server feature credentials and compatible caller pins.

`client-release-prepare.yml` generates a release pull request from the client's default branch. It uses a [pinned and verified](#git-cliff-installation) git-cliff 2.14.2 to infer a version from Git history and generate `CHANGELOG.md`. A manual dispatch can instead supply an explicit semantic version without the `v` prefix.

The generation job checks out the triggering commit with full history and a read-only workflow token. git-cliff runs with `--no-exec`; package-manager scripts and client build scripts are not run. The release-prepare action then uses the shared [securefix client](securefix.md#client-workflow) implementation to package the edits, mint its Client App token through the official action and request the existing securefix operation. It has no environment secrets.

## git-cliff installation

The release-prepare action installs git-cliff itself. It uses no third-party installer action and does not run a downloaded install script. [`git-cliff.ts`](../src/client-release-prepare/git-cliff.ts) pins the version and, for each supported runner platform, the SHA-256 of the exact `orhun/git-cliff` release asset:

| `RUNNER_OS`/`RUNNER_ARCH` | Release asset | SHA-256 |
|---|---|---|
| `Linux`/`X64` | `git-cliff-2.14.2-x86_64-unknown-linux-musl.tar.gz` | `fa21e2fc70046fcfd0e43e5e4613873ab799aff3d9dc8559c00d31b270e417d0` |
| `Linux`/`ARM64` | `git-cliff-2.14.2-aarch64-unknown-linux-musl.tar.gz` | `4be21b21ec9699af4d330b224aeba8a41d41d8f5b351ca2da8a9ea2bdc36380f` |
| `macOS`/`X64` | `git-cliff-2.14.2-x86_64-apple-darwin.tar.gz` | `4e647d2deb152aca1e987f225cf42b080b991dd98f3bce4027ef95446d982ac3` |
| `macOS`/`ARM64` | `git-cliff-2.14.2-aarch64-apple-darwin.tar.gz` | `a0be97e237d440d34c5e508ec21d070b2c85cbb8be48a46a56f9a4e8bd247f05` |

The reusable workflow runs on `ubuntu-24.04`. The direct action also supports the other three platforms. Windows and 32-bit runners are unsupported. Windows was never documented or verified for this action, and upstream publishes no checksum or signature for its Windows archives.

The action downloads only the selected asset from the pinned release tag URL into memory. The download is limited to 64 MiB and two minutes per attempt, with at most three attempts. Like the [shared GitHub client](github-api.md), it waits 250 milliseconds and then one second before retrying. It retries only when the request fails before a response arrives, including a timeout, or when the response is HTTP 502, 503 or 504. An error while reading the response body fails without retry. The action then compares the SHA-256 to the pinned value before it writes, extracts or executes anything. The pinned digest in reviewed repository source is the trust anchor. The action never fetches an expected checksum from the release. After a match, it extracts only `git-cliff-<version>/git-cliff` into a fresh `RUNNER_TEMP` directory. That member must be a regular file, and `--version` must report exactly `git-cliff <version>`. Preparation then runs that binary by absolute path. The action does not add git-cliff to `PATH` for later steps. Extraction uses the runner's `tar`, so a direct caller must not alter `PATH` with untrusted earlier steps.

Preparation fails before generating files when the platform is unsupported, the pinned digest is missing or malformed, the download fails or returns a non-success status, the body exceeds the limit, the digest differs, the member is not a regular file, or the reported version differs.

### Update the pinned version

Renovate does not update this pin. No Renovate manager reads `git-cliff.ts`, and `renovate.json` disables `git-cliff` and `orhun/git-cliff` so the non-major automerge rule cannot apply. Update the pin by hand:

1. Wait until the GitHub release is at least 7 days old, measured from its `published_at`.
2. Review the release notes, the upstream security advisories and issues for that version, and the release workflow changes since the pinned version.
3. Download every supported asset, with its `.sha512` and `.sig` files, from the release tag. For each asset, record the following and confirm they agree:
   - the local SHA-256 and SHA-512 of the downloaded bytes;
   - the upstream `.sha512` file;
   - the asset `digest` field from the GitHub releases API;
   - a good `gpg --verify` of the `.sig` file by key `1D2D410A741137EBC544826F4A92FA17B6619297`, the key named in upstream's binary release documentation.
4. Check for GitHub artifact attestations with `gh attestation verify --repo orhun/git-cliff` or the attestations API, and check the release's `immutable` field. Verify any provenance that exists. Do not describe a release as immutable or attested without that evidence.
5. Extract each binary and confirm the reported version. Change the version and every digest in one PR. Update the table above, the tests and `docs/handoff.md` with the evidence. A human reviewer approves the PR after checking the evidence.

If release age or integrity cannot be established, do not update. An urgent update to fix a published git-cliff vulnerability may skip only the 7-day wait. It still requires every integrity step above. The PR must state the advisory and the skipped wait, and the reviewer must acknowledge both.

### Remaining risk

A pinned digest proves that the job runs the bytes reviewers pinned. It does not prove those bytes were benign. A compromised upstream build or signing key could produce a malicious asset with a valid signature and matching published checksums. The 7-day wait gives time for such a compromise to be found, but it does not guarantee detection. git-cliff 2.14.2 was not an immutable release when it was pinned and has no GitHub artifact attestation. Upstream immutable releases and build provenance are tracked in [orhun/git-cliff#1653](https://github.com/orhun/git-cliff/issues/1653). Add verification when they become available.

## Generated files

The preparation action writes `.release-version` and `CHANGELOG.md`. It updates the root version fields of the selected version files:

| File | Updated version |
|---|---|
| `package.json` | Root `version` |
| `Cargo.toml` | `version` in `[package]` |
| `Cargo.lock` | The root package entry named by `Cargo.toml` |
| `pyproject.toml` | `version` in `[project]` |
| `dbt_project.yml` | Root `version` |
| `herdr-plugin.toml` | Root-table `version` |

The action and reusable workflow accept an optional `version-files` input, a JSON array of these literal root-relative paths:

- Empty or omitted: update every existing file in the table except `herdr-plugin.toml`. `Cargo.lock` is updated only with an existing `Cargo.toml`. This is the behavior of callers that predate the input. A repository without these manifests still gets the release version and changelog.
- A list such as `["Cargo.toml","Cargo.lock","herdr-plugin.toml"]`: update exactly those files. Generation fails before any write when the input is not a JSON array of strings, or a listed path is unsupported, duplicated or absent, or `Cargo.lock` is listed without `Cargo.toml`.
- `[]`: leave every manifest and lockfile untouched and generate only `.release-version` and `CHANGELOG.md`.

The input does not run client version-sync scripts. Every listed file must be `version-only` in the server's `release-pr` route.

Version edits preserve the other file contents. Existing manifests must have an unambiguous supported root version field. Dependency versions, lockfile dependencies, and nested workspace packages are not bumped. TOML manifests containing triple-quoted strings are rejected because their contents can resemble table headers or version fields. Unsupported or ambiguous files fail generation before a request is sent. The server independently enforces the route's line-level `version-only` rule, so JSON version fields must occupy their own line.

For `herdr-plugin.toml`, the root table, before the first table header, must have exactly one single-line `version` string containing valid SemVer. Every other top-level statement must be a table header or a key/value pair, with terminated strings and balanced brackets. This check is conservative and is not a complete TOML parser. Comments, quoting, line endings, table contents and nested version fields are preserved.

For dbt, the YAML must have unique keys and one string root version containing valid SemVer. The version must occupy a single block-mapping line using `version` or `"version"` as the key and a plain, single-quoted or double-quoted value. Flow mappings, aliases, anchors, tags and escaped version text are unsupported. Validation finishes before any manifest, release version or changelog is written. Comments, quoting, line endings and nested version fields are preserved.

## Server route

Enable `securefix` for the client repository and add this route to the global securefix configuration:

```yaml
securefix:
  allow_workflow_changes: false
  routes:
    - name: release-pr
      from: default
      to: release/next
      workflow: .github/workflows/csm-ci-release-pr.yml
      paths:
        CHANGELOG.md: any
        .release-version: semver
        Cargo.toml: version-only
        Cargo.lock: version-only
        package.json: version-only
        pyproject.toml: version-only
        dbt_project.yml: version-only
```

The caller's workflow path must match this route. The server re-fetches its run and requires the run's head to equal the current default-branch head. A concurrent push can therefore make an older request fail; the newer push generates the current release PR.

All writes use securefix's bounded artifact and server-owned branch checks. The server creates or updates the single `release/next` PR, including its title and body.

For the `release-pr` route, the title preserves the prepared commit subject, `chore(release): v<version>`, without a route prefix. This applies to creation and metadata refresh, so the protected squash merge uses the same semantic subject. Other securefix routes keep their route-name prefix.

An exact repeated generation reuses the existing commit and refreshes the PR metadata. A changed generation first verifies the existing branch's server-made commits and allowed paths, then conditionally resets it to the current default branch before writing. See [securefix](securefix.md) for the write and retry contract.

If generation produces no file changes, no artifact or request is sent. This workflow only prepares a PR. Merging an approved release PR uses the separate [release publishing](release.md) workflow.

## Client caller

See [setup](setup.md) for the default-branch push and manual-dispatch caller. Pin its reusable workflow reference to a reviewed commit SHA.

## Planned standard caller generation

The [repo-settings generator](repo-settings.md#standard-client-workflows-planned) selects preparation through `securefix` and the canonical `release-pr` route, independently of publication permission. Its optional `repositories[].release_prepare.version_files` list passes the `version-files` input; omission keeps the default file set. It uses the actual default branch and retains release-commit push suppression. Manual `version` remains a dispatch input. This requires deployment of the generator runtime and a compatible intended stable release. Existing callers remain operator-maintained until their exact bytes are adopted through the reviewed migration.
