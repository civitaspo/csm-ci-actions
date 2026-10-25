# Release publishing

The client calls `client-release-publish.yml` when a pull request from `release/next` is merged. The client workflow sends only the repository and pull request number. The server re-reads the pull request, merge commit and `.release-version` from GitHub before acting.

The matching repository entry must enable `release` and choose one strict build configuration:

```yaml
- name: owner/my-action
  ops: [approve, release]
  release: { build_type: js-action }
```

Use `none` for a source-only release, `js-action` to rebuild and check committed `dist/`, `goreleaser` to build GoReleaser assets without publishing or signing, or `cargo` to build binaries for a non-empty list of supported target triples. The supported Cargo targets are `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`. Configuration rejects unknown targets and duplicate targets.

Use `cargo-raw` for an installer that consumes individual executable files rather than archives:

```yaml
release:
  build_type: cargo-raw
  binary: herdr-linear-agent
  targets:
    - aarch64-apple-darwin
    - x86_64-apple-darwin
    - aarch64-unknown-linux-musl
    - x86_64-unknown-linux-musl
```

`binary` must start with an ASCII letter or digit, contain only ASCII letters, digits, underscores and hyphens, and have at most 64 characters. Choose a nonempty subset of these four targets without duplicates. Each target runs natively with Rust 1.99.1 and locked dependencies. Linux builds bind the C compiler and Cargo linker to the native musl toolchain. Before upload, the builder verifies executable format, architecture, static Linux linkage, and the reported `<binary> <version>` (with optional SemVer build metadata). Output names are `<binary>-<target>`, with no archive or version in the filename. The existing `cargo` archive builder is unchanged.

For `cargo-raw`, the publisher requires exactly the configured binaries and rejects other outputs. It creates one `<binary>-<target>.sha256` file per binary, containing its SHA256 and filename. A supplied sidecar must match the recomputed content exactly. All binaries and sidecars are included in `SHA256SUMS` and attestation. Upload the complete asset set to the draft before publishing; an immutable release cannot accept later binary uploads.

The server checks that the PR was merged by the Server bot from the same repository's `release/next` branch into the default branch. It requires `.release-version` at the merge commit to contain a semver version. The tag is `v<version>`. The Server App creates an annotated tag if it is missing. An existing tag must be an annotated tag pointing to the merge commit. The tagger fields are an identity check, not proof of who created the tag. The `release-tags` ruleset must forbid creating, updating and deleting `refs/tags/v*`, with the Server App as its only bypass. An existing release must have been created by the Server bot. Planning checks published releases with a read token; the publisher also checks drafts with its write token before creating or uploading anything, because GitHub hides drafts from read-only access. A retry reuses the same tag and release only when the merge commit and every asset digest still match. Cargo archive metadata is normalized, but client build code can still produce nondeterministic binaries; a differing rebuilt asset is rejected rather than overwritten.

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

After creating the protected annotated tag, verification tolerates short read-after-write visibility delays. A missing ref is read at most four times, waiting 250, 500 and 1,000 ms between reads. The same bounded verification applies to a 422 ref-creation race. Writes are not retried; unexpected API errors and tags with the wrong identity or target fail immediately.
