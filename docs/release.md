# Release publishing

The client calls `client-release.yml` when a pull request from `release/next` is merged. The client workflow sends only the repository and pull request number. The server re-reads the pull request, merge commit and `.release-version` from GitHub before acting.

The matching repository entry must enable `release` and choose one strict build configuration:

```yaml
- name: owner/my-action
  ops: [approve, release]
  release: { build_type: js-action }
```

Use `none` for a source-only release, `js-action` to rebuild and check committed `dist/`, `goreleaser` to build GoReleaser assets without publishing or signing, or `cargo` to build binaries for a non-empty list of supported target triples. The supported Cargo targets are `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`. Configuration rejects unknown targets and duplicate targets.

The server checks that the PR was merged by the Server bot from the same repository's `release/next` branch into the default branch. It requires `.release-version` at the merge commit to contain a semver version. The tag is `v<version>`. The Server App creates an annotated tag if it is missing. An existing tag must be an annotated tag pointing to the merge commit. The tagger fields are an identity check, not proof of who created the tag. The `release-tags` ruleset must forbid creating, updating and deleting `refs/tags/v*`, with the Server App as its only bypass. An existing release must have been created by the Server bot. A retry with the same tag and merge commit is idempotent.

The plan job checks out the merge commit with a contents:read token and archives tracked source. The build job receives only that source archive. It has `permissions: {}`, no environment, no secrets and no cache. Build outputs go under `assets/`. JavaScript releases install with the frozen lockfile and ignored lifecycle scripts, rebuild, and fail if committed `dist/` changes. GoReleaser skips publish, sign and announce; only archive artifacts listed in `dist/artifacts.json` are staged, excluding its binaries and internal metadata. Cargo installs the selected target and uses only target triples mapped to fixed GitHub-hosted runner labels.

The publish job validates flat regular-file build outputs, creates `SHA256SUMS`, and attaches an attestation to every asset. The [attestation spike record](release-attestation.md) passed in [testing server run 40117137591](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117137591). The predicate type is `https://github.com/civitaspo/csm-ci-actions/attestation/release/v1` and includes `client_repository`, `merge_sha` and `tag`. The publisher creates or resumes a draft with generated notes, uploads assets without overwriting, confirms that the remote asset names and SHA256 digests match exactly, then publishes. It re-fetches the release and tag and requires an immutable release, the exact asset set and the merge commit as the tag target. The plan job receives a Server App contents:write token only when it must create the protected release tag. Only the publish job has OIDC and attestation permissions; it receives a separate Server App contents:write token for release creation and publication.

To verify a released asset, run this from a checkout that contains the downloaded asset:

```sh
gh attestation verify <asset> \
  --owner <server-owner> \
  --signer-workflow <server-owner>/<server-repo>/.github/workflows/server.yml \
  --predicate-type https://github.com/civitaspo/csm-ci-actions/attestation/release/v1 \
  --deny-self-hosted-runners --format json > verified.json

jq -e 'any(.[].verificationResult.statement;
  .predicate.client_repository == "<client-owner>/<client-repo>" and
  .predicate.merge_sha == "<merge-sha>" and
  .predicate.tag == "v<version>")' verified.json
```
