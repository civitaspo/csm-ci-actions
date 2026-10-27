# Release pull requests

`client-release-prepare.yml` generates a release pull request from the client's default branch. It uses git-cliff 2.14.2 to infer a version from Git history and generate `CHANGELOG.md`. A manual dispatch can instead supply an explicit semantic version without the `v` prefix.

The generation job checks out the triggering commit with full history and a read-only workflow token. git-cliff runs with `--no-exec`; package-manager scripts and client build scripts are not run. The release-prepare action then uses the shared [securefix client](securefix.md#client-workflow) implementation to package the edits, mint its Client App token through the official action and request the existing securefix operation. It has no environment secrets.

## Generated files

The preparation action writes `.release-version` and `CHANGELOG.md`. It updates existing root version fields in `package.json`, `Cargo.toml` (`[package]`), `pyproject.toml` (`[project]`), and `dbt_project.yml` (root `version`). When Cargo has a lockfile, it updates only the root package's version in `Cargo.lock`. A repository without these manifests still gets the release version and changelog.

For repositories whose release version comes only from `.release-version`, pass `update-root-version: false` to the action or reusable workflow. Preparation then leaves every manifest and lockfile untouched and generates only `.release-version` and `CHANGELOG.md`. Omitted or `true` preserves the default manifest updates. This option does not run client version-sync scripts.

Version edits preserve the other file contents. Existing manifests must have an unambiguous supported root version field. Dependency versions, lockfile dependencies, and nested workspace packages are not bumped. TOML manifests containing triple-quoted strings are rejected because their contents can resemble table headers or version fields. Unsupported or ambiguous files fail generation before a request is sent. The server independently enforces the route's line-level `version-only` rule, so JSON version fields must occupy their own line.

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

The [repo-settings generator](repo-settings.md#standard-client-workflows-planned) selects preparation through `securefix` and the canonical `release-pr` route, independently of publication permission. Its planned `repositories[].release_prepare.update_root_version` boolean defaults to `true` and passes the existing `update-root-version` input. It uses the actual default branch and retains release-commit push suppression. Manual `version` remains a dispatch input. This requires the separate generator deployment and a compatible intended stable release. Existing callers remain operator-maintained until their exact bytes are adopted through the reviewed migration.
