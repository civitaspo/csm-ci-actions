import { ownedManagedHead } from "./repo-settings.ts";
import { CLIENT, SERVER_BOT_ID } from "./harness.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { github } from "../src/lib/github.ts";
import { describe, expect, test } from "bun:test";
import { parseCreatedRulesets, rulesetCleanupPlan } from "./repo-settings-ownership.ts";

describe("created repo-settings ruleset records", () => {
  test("collects validated records from prefixed workflow log lines", () => {
    const parsed = parseCreatedRulesets(
      "2026-10-25T00:00:00Z INFO created-repo-settings-ruleset {\"repository\":\"owner/repo\",\"id\":17,\"name\":\"integrity\"}",
      "owner/repo",
    );
    expect(parsed).toEqual({ rulesets: [{ repository: "owner/repo", id: 17, name: "integrity" }], errors: [] });
  });

  test("ignores a receipt marker embedded in unrelated log text", () => {
    const parsed = parseCreatedRulesets(
      `unrelated text created-repo-settings-ruleset {"repository":"owner/repo","id":17,"name":"integrity"}`,
      "owner/repo",
    );
    expect(parsed).toEqual({ rulesets: [], errors: [] });
  });

  test("keeps earlier IDs when a later record is malformed", () => {
    const parsed = parseCreatedRulesets(
      [
        "created-repo-settings-ruleset {\"repository\":\"owner/repo\",\"id\":17,\"name\":\"integrity\"}",
        "created-repo-settings-ruleset {broken}",
      ].join("\n"),
      "owner/repo",
    );
    expect(parsed.rulesets.map(({ id }) => id)).toEqual([17]);
    expect(parsed.errors).toEqual(["invalid created ruleset record in owner/repo"]);
  });

  test.each([
    ["malformed JSON", "{broken}", "invalid created ruleset record in owner/repo"],
    ["another repository", "{\"repository\":\"owner/other\",\"id\":17,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an invalid identifier", "{\"repository\":\"owner/repo\",\"id\":0,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an unsafe identifier", "{\"repository\":\"owner/repo\",\"id\":9007199254740992,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
    ["an empty name", "{\"repository\":\"owner/repo\",\"id\":17,\"name\":\"\"}", "created ruleset record does not match owner/repo"],
    ["a missing repository", "{\"id\":17,\"name\":\"integrity\"}", "created ruleset record does not match owner/repo"],
  ])("rejects records for %s", (_name, json, message) => {
    expect(parseCreatedRulesets("created-repo-settings-ruleset " + json, "owner/repo").errors).toEqual([message]);
  });

  test("reports malformed JSON receipt lines", () => {
    expect(parseCreatedRulesets("created-repo-settings-ruleset {broken}", "owner/repo").errors)
      .toEqual(["invalid created ruleset record in owner/repo"]);
  });
});

describe("ruleset restoration ownership", () => {
  test.each([19, 20])("deletes only run-created IDs and explains refusing unknown ruleset %s", (unknownId) => {
    expect(rulesetCleanupPlan(
      [{ id: 2 }, { id: 17 }, { id: 18 }, { id: unknownId }],
      new Set([2]),
      new Set([17, 18]),
    )).toEqual({ deleteIds: [17, 18], errors: [`ruleset ${unknownId} was not created by this e2e run; refusing deletion`] });
  });
});

describe("managed funding branch cleanup ownership", () => {
  const fundingPaths = ["e2e/repo-settings-managed.txt", ".github/FUNDING.yml"];
  test.each([
    ["both configured files", fundingPaths, fundingPaths, true],
    ["funding-only diff", [".github/FUNDING.yml"], fundingPaths, true],
    ["legacy single file", ["e2e/repo-settings-managed.txt"], undefined, true],
    ["funding outside sponsorship scenario", [".github/FUNDING.yml"], undefined, false],
    ["unknown file", [...fundingPaths, "unrelated.txt"], fundingPaths, false],
    ["empty diff", [], fundingPaths, false],
  ] satisfies [string, string[], string[] | undefined, boolean][])("checks %s", async (_name, files, allowed, owned) => {
    const sha = "a".repeat(40);
    const fetch = fakeFetch([
      { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fcsm-ci%2Frepo-settings`, body: { object: { sha } } },
      { method: "GET", path: `/repos/${CLIENT}/commits/${sha}`, body: { author: { id: SERVER_BOT_ID }, commit: { message: "Sync managed files", verification: { verified: true, reason: "valid" } }, files: files.map((filename) => ({ filename })) } },
      { method: "GET", path: `/repos/${CLIENT}/pulls`, body: [{ number: 1, body: "<!-- csm-ci:repo-settings:managed-files -->", head: { sha } }] },
    ]);
    expect(await ownedManagedHead({ gh: github("read", fetch) }, CLIENT, allowed)).toEqual(owned ? { sha, pull: { number: 1, headSha: sha } } : undefined);
  });

  test.each([
    ["current subject", "chore(repo-settings): sync managed files", true],
    ["legacy subject", "Sync managed files", true],
    ["other subject", "chore: unrelated", false],
  ] as const)("checks a branch commit with the %s", async (_name, message, owned) => {
    const sha = "a".repeat(40);
    const fetch = fakeFetch([
      { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fcsm-ci%2Frepo-settings`, body: { object: { sha } } },
      { method: "GET", path: `/repos/${CLIENT}/commits/${sha}`, body: { author: { id: SERVER_BOT_ID }, commit: { message, verification: { verified: true, reason: "valid" } }, files: [{ filename: "e2e/repo-settings-managed.txt" }] } },
      { method: "GET", path: `/repos/${CLIENT}/pulls`, body: [{ number: 1, body: "<!-- csm-ci:repo-settings:managed-files -->", head: { sha } }] },
    ]);
    expect(await ownedManagedHead({ gh: github("read", fetch) }, CLIENT)).toEqual(owned ? { sha, pull: { number: 1, headSha: sha } } : undefined);
  });
});

test.each([
  ["valid generated record", 123, true, "generated", true],
  ["copied repository record", 124, true, "generated", false],
  ["invalid GraphQL signature", 123, false, "generated", false],
  ["changed generated bytes", 123, true, "custom", false],
] as const)("cleanup checks %s", async (_name, repositoryId, valid, content, owned) => {
  const { digest } = await import("../src/lib/generated-workflows.ts");
  const { ownershipBody } = await import("../src/lib/workflow-ownership.ts");
  const sha = "a".repeat(40);
  const path = ".github/workflows/csm-ci-approve.yml";
  const record = { repositoryId, release: { version: "v1.2.3", sha }, files: { [path]: digest("generated") } };
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fcsm-ci%2Frepo-settings`, body: { object: { sha } } },
    { method: "GET", path: `/repos/${CLIENT}`, body: { id: 123 } },
    { method: "GET", path: `/repos/${CLIENT}/commits/${sha}`, body: { author: { id: SERVER_BOT_ID }, committer: { login: "web-flow" }, commit: { message: `Sync managed files\n\n${ownershipBody(record)}`, verification: { verified: true, reason: "valid" }, tree: { sha: "root" } }, files: [{ filename: path }] } },
    { method: "POST", path: "/graphql", body: { data: { repository: { commit: { signature: { isValid: valid, wasSignedByGitHub: true } } } } } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/root`, body: { tree: [{ path: ".github", type: "tree", mode: "040000", sha: "github" }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/github`, body: { tree: [{ path: "workflows", type: "tree", mode: "040000", sha: "workflows" }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/workflows`, body: { tree: [{ path: "csm-ci-approve.yml", type: "blob", mode: "100644", sha: "blob" }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/blobs/blob`, body: { encoding: "base64", content: Buffer.from(content).toString("base64") } },
    { method: "GET", path: `/repos/${CLIENT}/pulls`, body: [{ number: 1, body: "<!-- csm-ci:repo-settings:managed-files -->", head: { sha } }] },
  ]);
  expect(await ownedManagedHead({ gh: github("read", fetch) })).toEqual(owned ? { sha, pull: { number: 1, headSha: sha } } : undefined);
});

test.each([
  { name: "last generated caller removal", owned: true },
  { name: "removal retaining another caller", retained: true, owned: true },
  { name: "unowned removal", noPrior: true, owned: false },
  { name: "legacy prior without a record", legacy: true, owned: false },
  { name: "prior record omitting removed path", omitted: true, owned: false },
  { name: "customized default bytes", before: "custom", owned: false },
  { name: "absent default file", before: null, owned: false },
  { name: "claimed removal still present", after: "old", owned: false },
  { name: "modified path absent from pending record", status: "modified", owned: false },
  { name: "invalid prior signature", signature: false, error: "original managed head is not GitHub-signed" },
  { name: "prior record from another repository", repositoryId: 124, error: "ownership repository ID does not match" },
  { name: "prior original tree mismatch", original: "copied", error: "original head tree does not bind" },
] satisfies { name: string; retained?: boolean; noPrior?: boolean; legacy?: boolean; omitted?: boolean; before?: string | null; after?: string; status?: string; signature?: boolean; repositoryId?: number; original?: string; owned?: boolean; error?: string }[])("cleanup authenticates $name", async (options) => {
  const { digest } = await import("../src/lib/generated-workflows.ts");
  const { ownershipBody } = await import("../src/lib/workflow-ownership.ts");
  const sha = "a".repeat(40), defaultSha = "b".repeat(40), originalSha = "c".repeat(40);
  const path = ".github/workflows/csm-ci-approve.yml", retainedPath = ".github/workflows/csm-ci-merge.yml";
  const release = { version: "v1.2.3", sha };
  const pending = { repositoryId: 123, release, files: options.retained ? { [retainedPath]: digest("retained") } : {} };
  const prior = { repositoryId: options.repositoryId ?? 123, release, files: options.omitted ? {} : { [path]: digest("old") } };
  const pendingFiles = { ...(options.after ? { [path]: options.after } : {}), ...(options.retained ? { [retainedPath]: "retained" } : {}) };
  const before = options.before === undefined ? "old" : options.before;
  const signed = { author: { id: SERVER_BOT_ID }, committer: { login: "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } };
  const commit = (ref: string, message: string) => ({ ...signed, commit: { ...signed.commit, message, tree: { sha: ref } } });
  const pulls = options.noPrior ? [] : [{ number: 2, user: { id: SERVER_BOT_ID }, merged_at: "2026-10-27T00:00:00Z", merge_commit_sha: defaultSha, head: { ref: "csm-ci/repo-settings", repo: { id: 123 }, sha: originalSha }, base: { repo: { id: 123 } } }];
  const treeRoutes = (ref: string, files: Record<string, string>) => [
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}`, body: { tree: [{ path: ".github", type: "tree", mode: "040000", sha: `${ref}-github` }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}-github`, body: { tree: [{ path: "workflows", type: "tree", mode: "040000", sha: `${ref}-workflows` }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}-workflows`, body: { tree: Object.keys(files).map((path) => ({ path: path.split("/").at(-1), type: "blob", mode: "100644", sha: `${ref}-${path.split("/").at(-1)}` })) } },
    ...Object.entries(files).map(([path, content]) => ({ method: "GET", path: `/repos/${CLIENT}/git/blobs/${ref}-${path.split("/").at(-1)}`, body: { encoding: "base64", content: Buffer.from(content).toString("base64") } })),
  ];
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fcsm-ci%2Frepo-settings`, body: { object: { sha } } },
    { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fmain`, body: { object: { sha: defaultSha } } },
    { method: "GET", path: `/repos/${CLIENT}`, body: { id: 123, default_branch: "main" } },
    { method: "GET", path: `/repos/${CLIENT}/commits/${sha}`, body: { ...commit(sha, `Sync managed files\n\n${ownershipBody(pending)}`), files: [{ filename: path, status: options.status ?? "removed" }] } },
    { method: "GET", path: `/repos/${CLIENT}/commits/${defaultSha}`, body: commit(defaultSha, "squash") },
    { method: "GET", path: `/repos/${CLIENT}/commits/${originalSha}`, body: commit(originalSha, options.legacy ? "Sync managed files" : `Sync managed files\n\n${ownershipBody(prior)}`) },
    { method: "POST", path: "/graphql", body: { data: { repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } } }, then: [{ data: { repository: { commit: { signature: { isValid: options.signature ?? true, wasSignedByGitHub: true } } } } }] },
    { method: "GET", path: `/repos/${CLIENT}/pulls`, body: pulls, then: [[{ number: 1, body: "<!-- csm-ci:repo-settings:managed-files -->", head: { sha } }]] },
    ...treeRoutes(sha, pendingFiles),
    ...treeRoutes(defaultSha, before === null ? {} : { [path]: before }),
    ...treeRoutes(originalSha, { [path]: options.original ?? "old" }),
  ]);
  const result = ownedManagedHead({ gh: github("read", fetch) });
  if (options.error) await expect(result).rejects.toThrow(options.error);
  else expect(await result).toEqual(options.owned ? { sha, pull: { number: 1, headSha: sha } } : undefined);
});
