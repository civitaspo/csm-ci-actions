import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "../lib/github.ts";
import { fakeFetch } from "../lib/testing.ts";
import { prepareAssets } from "./assets.ts";
import { publishRelease } from "./publish.ts";

const mergeSha = "0123456789abcdef0123456789abcdef01234567";
const plan = {
  repository: "owner/repo",
  pullNumber: 12,
  mergeSha,
  tag: "v1.2.3",
  version: "1.2.3",
  serverBotId: 3000,
  serverBotLogin: "server[bot]",
  tagExists: false,
  privateRepository: false,
  release: { build_type: "none" },
  prerelease: false,
};

let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

async function assets(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), "csm-release-publish-"));
  await writeFile(join(directory, "app.txt"), "release asset\n");
}

function fakeFetchWithMissingTagRef(routes: Parameters<typeof fakeFetch>[0], missingCall: number) {
  const base = fakeFetch(routes);
  let tagRefCalls = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/repos/owner/repo/git/ref/tags%2Fv1.2.3" && ++tagRefCalls === missingCall) {
      base.calls.push(`${method} ${url.pathname}`);
      base.requests.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return base(input, init);
  };
  return Object.assign(fetch, { calls: base.calls, requests: base.requests }) as typeof globalThis.fetch & { calls: string[]; requests: typeof base.requests };
}

const validTagRoutes = [
  { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: "tag-sha" } } },
  { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: { tag: "v1.2.3", tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" }, object: { type: "commit", sha: mergeSha } } },
];

describe("publishRelease", () => {
  test.each([
    { name: "a manifest with too few entries", assets: (digest: string) => [{ name: "SHA256SUMS", sha256: digest }], message: "release asset manifest does not match the build outputs" },
    { name: "a same-length manifest with a different digest", assets: (digest: string) => [{ name: "app.txt", sha256: "0".repeat(64) }, { name: "SHA256SUMS", sha256: digest }], message: "release asset manifest does not match the build outputs" },
  ])("rejects $name before API writes", async ({ assets: manifest }) => {
    await assets();
    const actual = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const manifestEntries = manifest(actual[1]?.sha256 ?? "");
    const fetch = fakeFetch([]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: manifestEntries,
      directory,
    })).rejects.toThrow("release asset manifest does not match the build outputs");
    expect(fetch.calls).toEqual([]);
  });

  test("rejects duplicate manifest names before API calls", async () => {
    await assets();
    const digest = (await prepareAssets(directory))[0]?.sha256 ?? "";
    const fetch = fakeFetch([]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: [{ name: "app.txt", sha256: digest }, { name: "app.txt", sha256: digest }],
      directory,
    })).rejects.toThrow("manifest contains duplicate names");
    expect(fetch.calls).toEqual([]);
  });

  test("checks the tag before creating a draft", async () => {
    await assets();
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: "tag-sha" } } },
      { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: { tag: "v1.2.3", tagger: { name: "alice", email: "alice@example.com" }, object: { type: "commit", sha: mergeSha } } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("tag v1.2.3 was not created by the Server bot");
    expect(fetch.calls).toHaveLength(2);
  });

  test("rejects duplicate names in an existing draft before publishing", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const digest = expected[0]?.sha256 ?? "";
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: [
        { name: "app.txt", digest: `sha256:${digest}` },
        { name: "app.txt", digest: `sha256:${digest}` },
      ] },
      { method: "POST", path: "/repos/owner/repo/releases/7/assets", body: { id: 9, name: "SHA256SUMS", digest: "sha256:bad" } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow("duplicate asset names");
    expect(fetch.requests.map(({ method }) => method)).not.toContain("PATCH");
  });

  test("propagates release lookup failures that do not mean missing", async () => {
    await assets();
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 500, body: { message: "server error" } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("server error");
  });

  test("propagates failures from draft lookup instead of treating them as no draft", async () => {
    await assets();
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", status: 403, body: { message: "Resource not accessible by integration" } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("Resource not accessible by integration");
    expect(fetch.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  test("rejects an existing release owned by another bot", async () => {
    await assets();
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 4000 } } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("release v1.2.3 was not created by the Server bot");
  });

  test.each([
    { name: "a foreign draft", drafts: [{ id: 7, tag_name: "v1.2.3", author: { id: 4000 }, draft: true }], message: "release v1.2.3 was not created by the Server bot" },
    { name: "multiple matching drafts", drafts: [
      { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true },
      { id: 8, tag_name: "v1.2.3", author: { id: 3000 }, draft: true },
    ], message: "release v1.2.3 has multiple drafts" },
  ])("rejects $name found only in the releases list before writing assets", async ({ drafts, message }) => {
    await assets();
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: drafts },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow(message);
    expect(fetch.requests.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
  });

  test("resumes a Server draft visible only in the releases list", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const complete = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [{ id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false }] },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: complete },
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: "tag-sha" } } },
      { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: { tag: "v1.2.3", tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" }, object: { type: "commit", sha: mergeSha } } },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: complete },
    ]);
    await publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory });
    expect(fetch.requests.some(({ method, path }) => method === "POST" && path.includes("/assets"))).toBe(false);
    expect(fetch.requests.some(({ method, path }) => method === "PATCH" && path.endsWith("/releases/7"))).toBe(true);
  });

  test("creates a draft, uploads the exact assets, then publishes it", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const remote = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [], then: [[{ tag_name: "v2.0.0", draft: false }]] },
      { method: "POST", path: "/repos/owner/repo/releases", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: [], then: [remote, remote] },
      { method: "POST", path: "/repos/owner/repo/releases/7/assets", body: { id: 9, name: "asset", digest: "sha256:unused" } },
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
    ]);
    await publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory });
    expect(fetch.requests.filter(({ method, path }) => method === "POST" && path.includes("/assets"))).toHaveLength(2);
    expect(fetch.requests.find(({ method, path }) => method === "POST" && path === "/repos/owner/repo/releases")?.body).toContain('"draft":true');
    expect(fetch.requests.some(({ method, path }) => method === "PATCH" && path === "/repos/owner/repo/releases/7")).toBe(true);
    expect(fetch.requests.find(({ method, path }) => method === "PATCH" && path.endsWith("/releases/7"))?.body).toContain('"make_latest":"false"');
  });

  test("resumes a partial draft without replacing matching assets", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const partial = expected.slice(0, 1).map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const complete = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: partial, then: [complete, complete] },
      { method: "POST", path: "/repos/owner/repo/releases/7/assets", body: { id: 9, name: "asset", digest: "sha256:unused" } },
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
    ]);
    await publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory });
    expect(fetch.requests.filter(({ method, path }) => method === "POST" && path.includes("/assets"))).toHaveLength(1);
  });

  test("rejects an update that leaves the release as a draft", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const remote = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow("release v1.2.3 is still a draft after publishing");
    expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(true);
  });

  test.each([
    { phase: "before publishing", missingCall: 2, message: "tag v1.2.3 is missing or points to a different commit" },
    { phase: "after publishing", missingCall: 3, message: "tag v1.2.3 is missing after release" },
  ])("rejects when the tag disappears $phase", async ({ missingCall, message, phase }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const remote = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const routes = [
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
    ];
    const fetch = fakeFetchWithMissingTagRef(routes, missingCall);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    if (phase === "before publishing") expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(false);
    if (phase === "after publishing") expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(true);
  });

  test("rejects a published release that is still a draft on re-fetch", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: true } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow("release v1.2.3 is not published");
    expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  test("accepts an already published immutable release with the exact assets", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const remote = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
    ]);
    await publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory });
    expect(fetch.requests.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
  });

  test.each([
    { name: "invalid plan shape", plan: { ...plan, unexpected: true }, expectedAssets: [], message: "Unrecognized key" },
    { name: "invalid asset digest", plan, expectedAssets: [{ name: "app.txt", sha256: "bad" }], message: "Invalid" },
  ])("rejects $name before API writes", async ({ plan: testPlan, expectedAssets, message }) => {
    await assets();
    const fetch = fakeFetch([]);
    await expect(publishRelease(github("t", fetch), { plan: testPlan, expectedAssets, directory })).rejects.toThrow(message);
    expect(fetch.calls).toEqual([]);
  });

  test.each([
    { name: "release points at another tag", release: { id: 7, tag_name: "v9.9.9", author: { id: 3000 }, draft: true, immutable: false }, message: "points to tag v9.9.9" },
    { name: "release response has an unexpected tag", release: { id: 7, tag_name: "v9.9.9", author: { id: 3000 }, draft: true, immutable: false }, message: "points to tag v9.9.9" },
  ])("rejects when $name before asset writes", async ({ release, message }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const fetch = fakeFetch([...validTagRoutes, { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: release }]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    expect(fetch.requests.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
  });

  test.each([
    { name: "an existing asset has a different digest", asset: { name: "app.txt", digest: `sha256:${"0".repeat(64)}` }, message: "already exists with a different or unavailable digest" },
    { name: "an existing asset has no digest", asset: { name: "app.txt" }, message: "already exists with a different or unavailable digest" },
  ])("does not overwrite when $name", async ({ asset, message }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: [asset] },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    expect(fetch.requests.some(({ method, path }) => method === "POST" && path.includes("/assets"))).toBe(false);
    expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  test.each([
    { name: "an uploaded asset is absent from the final listing", variant: "missing", message: "expected exactly" },
    { name: "an uploaded asset has a changed digest", variant: "changed", message: "unexpected digest" },
    { name: "the final listing contains duplicate names", variant: "duplicate", message: "duplicate asset names" },
  ] as const)("keeps the release as a draft when $name", async ({ variant, message }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const complete = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const finalAssets = variant === "missing" ? complete.slice(0, -1) : variant === "changed" ? complete.map((asset, index) => index === 0 ? { ...asset, digest: `sha256:${"0".repeat(64)}` } : asset) : [complete[0], complete[0]];
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "POST", path: "/repos/owner/repo/releases", body: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: [], then: [finalAssets] },
      { method: "POST", path: "/repos/owner/repo/releases/7/assets", body: { id: 9, name: "asset", digest: "sha256:unused" } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    expect(fetch.requests.some(({ method }) => method === "PATCH")).toBe(false);
  });

  test.each([
    { name: "creation returns a non-recoverable API error", status: 500, message: "server error" },
    { name: "creation races but the release is still missing", status: 422, message: "Validation Failed" },
  ])("propagates when $name", async ({ status, message }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "POST", path: "/repos/owner/repo/releases", status, body: { message } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    expect(fetch.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  test("creates prerelease drafts without making them latest", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const prereleasePlan = { ...plan, tag: "v1.2.3-beta.1", version: "1.2.3-beta.1", prerelease: true };
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3-beta.1", body: { object: { type: "tag", sha: "tag-sha" } } },
      { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: { tag: "v1.2.3-beta.1", tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" }, object: { type: "commit", sha: mergeSha } } },
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3-beta.1", status: 404, body: { message: "Not Found" } },
      { method: "GET", path: "/repos/owner/repo/releases", body: [] },
      { method: "POST", path: "/repos/owner/repo/releases", status: 500, body: { message: "stop after inspecting request" } },
    ]);
    await expect(publishRelease(github("t", fetch), { plan: prereleasePlan, expectedAssets: expected, directory })).rejects.toThrow("stop after inspecting request");
    const body = JSON.parse(fetch.requests.find(({ method, path }) => method === "POST" && path === "/repos/owner/repo/releases")?.body ?? "{}");
    expect(body).toMatchObject({ draft: true, prerelease: true, make_latest: "false" });
  });

  test("publishes prereleases without marking them latest", async () => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const remote = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const prereleasePlan = { ...plan, tag: "v1.2.3-beta.1", version: "1.2.3-beta.1", prerelease: true };
    const prereleaseTagRoutes = [
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3-beta.1", body: { object: { type: "tag", sha: "tag-sha" } } },
      { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: { tag: "v1.2.3-beta.1", tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" }, object: { type: "commit", sha: mergeSha } } },
    ];
    const fetch = fakeFetch([
      ...prereleaseTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3-beta.1", body: { id: 7, tag_name: "v1.2.3-beta.1", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3-beta.1", body: { id: 7, tag_name: "v1.2.3-beta.1", author: { id: 3000 }, draft: true, immutable: false } },
      { method: "PATCH", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3-beta.1", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: { id: 7, tag_name: "v1.2.3-beta.1", author: { id: 3000 }, draft: false, immutable: true } },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
    ]);
    await publishRelease(github("t", fetch), { plan: prereleasePlan, expectedAssets: expected, directory });
    expect(fetch.requests.find(({ method }) => method === "PATCH")?.body).toContain('"make_latest":"false"');
    expect(fetch.requests.some(({ method, path }) => method === "GET" && path === "/repos/owner/repo/releases")).toBe(false);
  });

  test.each([
    { name: "a published release is mutable", release: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: false }, message: "not immutable", assets: "exact" },
    { name: "a published release is missing an asset", release: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true }, message: "expected exactly", assets: "empty" },
    { name: "a published release has an unexpected digest", release: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true }, message: "unexpected digest", assets: "bad" },
    { name: "a published release contains duplicate assets", release: { id: 7, tag_name: "v1.2.3", author: { id: 3000 }, draft: false, immutable: true }, message: "duplicate asset names", assets: "duplicate" },
  ] as const)("rejects when $name", async ({ release, message, assets: variant }) => {
    await assets();
    const expected = (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 }));
    const correct = expected.map(({ name, sha256 }) => ({ name, digest: `sha256:${sha256}` }));
    const remote = variant === "exact" ? correct : variant === "empty" ? [] : variant === "bad" ? correct.map((asset, index) => index === 0 ? { ...asset, digest: `sha256:${"0".repeat(64)}` } : asset) : [correct[0], correct[0]];
    const fetch = fakeFetch([
      ...validTagRoutes,
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: release },
      { method: "GET", path: "/repos/owner/repo/releases/7", body: release },
      { method: "GET", path: "/repos/owner/repo/releases/7/assets", body: remote },
    ]);
    await expect(publishRelease(github("t", fetch), { plan, expectedAssets: expected, directory })).rejects.toThrow(message);
    expect(fetch.requests.some(({ method }) => method === "POST" || method === "PATCH")).toBe(false);
  });
});
