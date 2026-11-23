import { expect, test } from "bun:test";
import { github } from "./github.ts";
import { fakeFetch } from "./testing.ts";
import { assertManagedPullReleaseContextCurrent, revalidateManagedPullRelease, resolveManagedPullRelease } from "./managed-pull-context.ts";

const oldRelease = { version: "v1.2.3", sha: "d".repeat(40) };
const latestRelease = { version: "v1.2.4", sha: "e".repeat(40) };
// The resolver compares expiry with the real clock, so reservation times are relative to it.
const DAY = 24 * 60 * 60 * 1000;
const acceptedAt = new Date(Date.now() - DAY).toISOString();
const expiresAt = new Date(Date.parse(acceptedAt) + 7 * DAY).toISOString();
const expiredAt = new Date(Date.now() - DAY / 2).toISOString();
const payload = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  kind: "managed-files",
  repository_id: 42,
  repository: "owner/repo",
  pull_number: 12,
  pull_node_id: "PR_node",
  base_ref: "main",
  managed_ref: "csm-ci/repo-settings",
  accepted_base: "a".repeat(40),
  accepted_head: "b".repeat(40),
  configuration_sha: "c".repeat(40),
  release_version: oldRelease.version,
  release_sha: oldRelease.sha,
  manifest_digest: "f".repeat(64),
  idempotency_key: "1".repeat(64),
  accepted_at: acceptedAt,
  expires_at: expiresAt,
  ...overrides,
});

function deploymentClient(records: unknown[], status = 200, nextRecords?: unknown[]) {
  const nodesFor = (values: unknown[]) => values.map((value, index) => ({
    id: `DEP_${index + 1}`,
    databaseId: index + 1,
    task: "csm-ci:automerge",
    payload: value,
    createdAt: acceptedAt,
    creator: { __typename: "Bot", databaseId: 3000 },
    statuses: { nodes: [], pageInfo: { hasNextPage: false } },
  }));
  const response = (values: unknown[]) => ({ data: { repository: { deployments: { nodes: nodesFor(values), pageInfo: { hasNextPage: false, endCursor: null } } } } });
  const fetch = fakeFetch([{
    method: "POST",
    path: "/graphql",
    status,
    body: response(records),
    ...(nextRecords ? { then: [response(nextRecords)] } : {}),
  }]);
  return { client: github("deployments", fetch), fetch };
}

function releaseClient(options: { latest?: typeof latestRelease; pinned?: typeof oldRelease } = {}) {
  const current = options.latest ?? latestRelease;
  const pinned = options.pinned ?? oldRelease;
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: { tag_name: current.version, draft: false, prerelease: false, published_at: "2026-11-02T00:00:00Z", id: 1 } },
    { method: "GET", path: `/repos/civitaspo/csm-ci-actions/git/ref/tags%2F${current.version}`, body: { object: { type: "commit", sha: current.sha } } },
    { method: "GET", path: `/repos/civitaspo/csm-ci-actions/releases/tags/${pinned.version}`, body: { tag_name: pinned.version, draft: false, prerelease: false, published_at: "2026-11-01T00:00:00Z", id: 2 } },
    { method: "GET", path: `/repos/civitaspo/csm-ci-actions/git/ref/tags%2F${pinned.version}`, body: { object: { type: "commit", sha: pinned.sha } } },
  ]);
  return { client: github("source", fetch), fetch };
}

const facts = {
  repository: "owner/repo",
  repositoryId: 42,
  pullNumber: 12,
  pullNodeId: "PR_node",
  headSha: "b".repeat(40),
  baseRef: "main",
  serverBotId: 3000,
  headerRelease: oldRelease,
  callers: [] as const,
};
const sourceBase = { serverRepository: "owner/server", configSha: "c".repeat(40) };

test("without a reservation, only the current stable release header can resolve", async () => {
  const source = releaseClient();
  const result = await resolveManagedPullRelease({ ...sourceBase, source: source.client }, { ...facts, headerRelease: latestRelease });
  expect(result.release).toEqual(latestRelease);
  expect(source.fetch.calls).toContain("GET /repos/civitaspo/csm-ci-actions/releases/latest");
});

test("rejects an old stable release header when no active reservation exists", async () => {
  const source = releaseClient();
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client }, facts))
    .rejects.toThrow("managed pull workflow release is not the current stable release and has no active reservation pin");
});

test("an active server-owned reservation preserves its older run pin after latest advances", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload()]);
  const result = await resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, facts);
  expect(result.release).toEqual(oldRelease);
  expect(result.reservation).toEqual({ deploymentId: 1, idempotencyKey: "1".repeat(64) });
  expect(source.fetch.calls).not.toContain("GET /repos/civitaspo/csm-ci-actions/releases/latest");
  expect(deployments.fetch.calls).toContain("POST /graphql");
});

test("rejects an active reservation whose release pin no longer resolves", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload({ release_sha: "9".repeat(40) })]);
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, facts))
    .rejects.toThrow("pinned standard workflow release version and SHA do not match");
});

test("rejects an active reservation after its expiry timestamp", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload({ expires_at: expiredAt })]);
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, facts))
    .rejects.toThrow("active managed reservation has expired");
});

test.each([
  ["repository identity", { repository: "owner/other" }],
  ["PR node id", { pull_node_id: "wrong_node" }],
  ["accepted head", { accepted_head: "9".repeat(40) }],
  ["configuration SHA", { configuration_sha: "8".repeat(40) }],
])("rejects a reservation with mismatched %s", async (_name, overrides) => {
  const source = releaseClient();
  const deployments = deploymentClient([payload(overrides)]);
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, facts))
    .rejects.toThrow("active managed reservation does not match the current pull request and configuration");
});

test("rejects duplicate active managed reservations", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload(), payload({ idempotency_key: "2".repeat(64) })]);
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, facts))
    .rejects.toThrow("managed pull has an ambiguous active reservation");
});

test("fails closed when deployments read permission is lost", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([], 403);
  await expect(resolveManagedPullRelease({ ...sourceBase, source: source.client, deployments: deployments.client }, { ...facts, headerRelease: latestRelease })).rejects.toThrow();
});

test("re-reads reservation state and rejects a replacement before final validation", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload()], 200, [payload({ idempotency_key: "2".repeat(64) })]);
  const input = { ...sourceBase, source: source.client, deployments: deployments.client };
  const initial = await resolveManagedPullRelease(input, facts);
  await expect(revalidateManagedPullRelease(input, facts, initial)).rejects.toThrow();
  expect(deployments.fetch.calls.filter((call) => call === "POST /graphql")).toHaveLength(2);
});

test("rejects when the active reservation becomes terminal before final validation", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload()], 200, []);
  const input = { ...sourceBase, source: source.client, deployments: deployments.client };
  const initial = await resolveManagedPullRelease(input, facts);
  await expect(revalidateManagedPullRelease(input, facts, initial)).rejects.toThrow(
    "managed pull workflow release is not the current stable release and has no active reservation pin",
  );
  expect(deployments.fetch.calls.filter((call) => call === "POST /graphql")).toHaveLength(2);
});

test("rejects when the active reservation expires before final validation", async () => {
  const source = releaseClient();
  const deployments = deploymentClient([payload()], 200, [payload({ expires_at: expiredAt })]);
  const input = { ...sourceBase, source: source.client, deployments: deployments.client };
  const initial = await resolveManagedPullRelease(input, facts);
  await expect(revalidateManagedPullRelease(input, facts, initial)).rejects.toThrow("active managed reservation has expired");
  expect(deployments.fetch.calls.filter((call) => call === "POST /graphql")).toHaveLength(2);
});

test.each([
  ["reservation cancelled before final validation", { release: oldRelease }],
  ["reservation deployment changed", { release: oldRelease, reservation: { deploymentId: 2, idempotencyKey: "1".repeat(64) } }],
  ["reservation key changed", { release: oldRelease, reservation: { deploymentId: 1, idempotencyKey: "2".repeat(64) } }],
  ["reservation pin changed", { release: latestRelease, reservation: { deploymentId: 1, idempotencyKey: "1".repeat(64) } }],
])("rejects when the %s", (_name, current) => {
  expect(() => assertManagedPullReleaseContextCurrent(
    { release: oldRelease, reservation: { deploymentId: 1, idempotencyKey: "1".repeat(64) } },
    current,
  )).toThrow("managed pull reservation or release pin changed during validation");
});
