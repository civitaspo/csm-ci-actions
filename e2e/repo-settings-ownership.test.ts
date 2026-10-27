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
  { name: "written generated caller", status: "modified", head: "# Generated by csm-ci from v1.2.3 (x).\nname: a\n", owned: true },
  { name: "written file without the header", status: "modified", head: "name: custom\n", owned: false },
  { name: "written file with the header on a later line", status: "modified", head: "name: a\n# Generated by csm-ci from v1.2.3 (x).\n", owned: false },
  { name: "invalid GraphQL signature", status: "modified", head: "# Generated by csm-ci from v1.2.3 (x).\n", signature: false, owned: false },
  { name: "deleted generated caller", status: "removed", parent: "# Generated by csm-ci from v1.2.3 (x).\n", owned: true },
  { name: "deleted file without the header", status: "removed", parent: "name: custom\n", owned: false },
  { name: "claimed deletion still present", status: "removed", parent: "# Generated by csm-ci from v1.2.3 (x).\n", head: "# Generated by csm-ci from v1.2.3 (x).\n", owned: false },
] satisfies { name: string; status: string; head?: string; parent?: string; signature?: boolean; owned: boolean }[])("cleanup recognizes $name", async (options) => {
  const sha = "a".repeat(40), parentSha = "b".repeat(40);
  const path = ".github/workflows/csm-ci-custom.yml";
  const signed = { author: { id: SERVER_BOT_ID }, committer: { login: "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } };
  const commit = (ref: string) => ({ ...signed, parents: [{ sha: parentSha }], commit: { ...signed.commit, message: "chore(repo-settings): sync managed files", tree: { sha: ref } } });
  const treeRoutes = (ref: string, content: string | undefined) => [
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}`, body: { tree: [{ path: ".github", type: "tree", mode: "040000", sha: `${ref}-github` }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}-github`, body: { tree: [{ path: "workflows", type: "tree", mode: "040000", sha: `${ref}-workflows` }] } },
    { method: "GET", path: `/repos/${CLIENT}/git/trees/${ref}-workflows`, body: { tree: content === undefined ? [] : [{ path: "csm-ci-custom.yml", type: "blob", mode: "100644", sha: `${ref}-blob` }] } },
    ...(content === undefined ? [] : [{ method: "GET", path: `/repos/${CLIENT}/git/blobs/${ref}-blob`, body: { encoding: "base64", content: Buffer.from(content).toString("base64") } }]),
  ];
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${CLIENT}/git/ref/heads%2Fcsm-ci%2Frepo-settings`, body: { object: { sha } } },
    { method: "GET", path: `/repos/${CLIENT}/commits/${sha}`, body: { ...commit(sha), files: [{ filename: path, status: options.status }] }, then: [commit(sha)] },
    { method: "GET", path: `/repos/${CLIENT}/commits/${parentSha}`, body: commit(parentSha) },
    { method: "POST", path: "/graphql", body: { data: { repository: { commit: { signature: { isValid: options.signature ?? true, wasSignedByGitHub: true } } } } } },
    { method: "GET", path: `/repos/${CLIENT}/pulls`, body: [{ number: 1, body: "<!-- csm-ci:repo-settings:managed-files -->", head: { sha } }] },
    ...treeRoutes(sha, options.head),
    ...treeRoutes(parentSha, options.parent),
  ]);
  expect(await ownedManagedHead({ gh: github("read", fetch) })).toEqual(options.owned ? { sha, pull: { number: 1, headSha: sha } } : undefined);
});
