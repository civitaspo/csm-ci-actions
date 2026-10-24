# Release attestation spike

The spike passed in [testing server run 40117137591](https://github.com/civitaspo/testing-csm-ci-server/actions/runs/40117137591), using [workflow commit 68f07a4](https://github.com/civitaspo/testing-csm-ci-server/blob/68f07a4/.github/workflows/csm-ci-attestation-spike.yml). The subject was a fixed text file, not a release build.

## Storage and permissions

[Attestation 59447241](https://github.com/civitaspo/testing-csm-ci-server/attestations/59447241) is stored in the server repository that started the workflow. The subject SHA256 is `f370b9e8e347243f189c46574296ac6de6134e284f9034e141312f587a63ce2c`. A client asset can therefore be verified by owner even though the attestation lives in a different repository.

The signing job used only `contents: read`, `id-token: write`, and `attestations: write` on its workflow token. It declared no environment or secrets and did not mint a Server App token. No additional App permission is needed for this storage choice.

The probe pinned `actions/attest` v3 at `f057fd524d485ac48d9b534c235aad15b5bb303f`. That version supports custom predicates with the permissions above. The [action documentation](https://github.com/actions/attest/tree/f057fd524d485ac48d9b534c235aad15b5bb303f) describes the server repository storage and local bundle output. Updating the action needs a permission review; v4 also documents artifact-metadata permission.

## Predicate

Type: `https://github.com/civitaspo/csm-ci-actions/attestation/release/v1`.

```json
{
  "client_repository": "civitaspo/testing-csm-ci-client",
  "merge_sha": "aaeadfc638a025d96b4e9bd2ab0a7f88e4d2e8e0",
  "tag": "v0.0.0-spike"
}
```

These fields bind the asset digest to its client, merge commit, and tag. They must come from the validated plan job, never from a client-provided artifact. The signing job must not execute client code. No tag or release was created by this probe.

## Verification

The following passed on the hosted runner. Replace the signer workflow with the final reusable publish workflow when that is implemented.

```sh
gh attestation verify subject.txt \
  --owner civitaspo \
  --signer-workflow civitaspo/testing-csm-ci-server/.github/workflows/csm-ci-attestation-spike.yml \
  --predicate-type https://github.com/civitaspo/csm-ci-actions/attestation/release/v1 \
  --deny-self-hosted-runners --format json > verified.json

jq -e 'any(.[].verificationResult.statement;
  .predicate.client_repository == "civitaspo/testing-csm-ci-client" and
  .predicate.merge_sha == "aaeadfc638a025d96b4e9bd2ab0a7f88e4d2e8e0" and
  .predicate.tag == "v0.0.0-spike")' verified.json
```

The signature verifier checks the digest and signer identity. The separate field check is necessary: owner and workflow alone do not identify a client repository. The same run confirmed that a wrong client predicate does not match, and that changing the subject content makes verification fail because no attestation matches the new digest.

A local verification attempt could not initialize a Sigstore verifier. The successful verification evidence is the hosted runner, not the local machine. This spike does not yet verify the final reusable workflow identity, immutable release upload, or any build type. Those remain release implementation e2e gates.
