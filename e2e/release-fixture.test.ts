import { testMetadata, testIntent } from "./test-metadata.ts";
import { describe, expect, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { CLIENT, openReleasePr } from "./harness.ts";

const base = "1".repeat(40);
const head = "2".repeat(40);
const repositoryPath = `/repos/${CLIENT}`;

function releaseApi(deletionStatus: number) {
  const urls: URL[] = [];
  const api = fakeFetch([
    { method: "GET", path: `${repositoryPath}/git/ref/heads%2Frelease%2Fnext`, status: 404, body: { message: "Not Found" } },
    { method: "GET", path: `${repositoryPath}/branches/main`, body: { commit: { sha: base } } },
    { method: "POST", path: `${repositoryPath}/git/refs`, body: {} },
    { method: "GET", path: `${repositoryPath}/contents/dist%2Faction.js`, status: deletionStatus, body: { message: "deletion lookup failed", type: "file" } },
    { method: "POST", path: "/graphql", body: { data: { createCommitOnBranch: { commit: { oid: head } } } } },
    { method: "POST", path: `${repositoryPath}/pulls`, body: { number: 17 } },
    { method: "POST", path: `${repositoryPath}/issues/17/labels`, body: [] },
    { method: "GET", path: `${repositoryPath}/pulls`, body: [] },
  ]);
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
    return api(input, init);
  }, { preconnect: () => undefined });
  return { ctx: { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined, ...testMetadata }, api, urls };
}

describe("release fixture deletions", () => {
  test.each([
    { name: "present", status: 200, deletions: [{ path: "dist/action.js" }] },
    { name: "already absent", status: 404, deletions: [] },
  ])("opens the release PR when the deletion path is $name at its pinned base", async ({ status, deletions }) => {
    const { ctx, api, urls } = releaseApi(status);
    const pr = await openReleasePr(ctx, { intent: testIntent, version: "1.2.3", additions: { "dist/action.js": null, "fixture.txt": "new content" } });
    expect(pr).toMatchObject({ number: 17, head, branch: "release/next" });
    expect(urls.find((url) => url.pathname.endsWith("/contents/dist%2Faction.js"))?.searchParams.get("ref")).toBe(base);
    const mutation = api.requests.find((request) => request.path === "/graphql");
    expect(JSON.parse(mutation?.body ?? "null")).toMatchObject({ variables: { i: {
      expectedHeadOid: base,
      fileChanges: { deletions, additions: expect.arrayContaining([
        { path: ".release-version", contents: Buffer.from("1.2.3\n").toString("base64") },
        { path: "fixture.txt", contents: Buffer.from("new content").toString("base64") },
      ]) },
    } } });
  });

  test.each([403, 422, 503])("propagates deletion lookup HTTP %i without committing", async (status) => {
    const { ctx, api } = releaseApi(status);
    await expect(openReleasePr(ctx, { intent: testIntent, version: "1.2.3", additions: { "dist/action.js": null } })).rejects.toThrow("deletion lookup failed");
    expect(api.requests.some((request) => request.path === "/graphql")).toBe(false);
  });
});
