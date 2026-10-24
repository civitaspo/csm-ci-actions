import { describe, expect, test } from "bun:test";
import { github } from "../lib/github.ts";
import { fakeFetch } from "../lib/testing.ts";
import { ensureReleaseTag } from "./tag.ts";

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
  release: { build_type: "none" as const },
  prerelease: false,
};
const tag = {
  tag: "v1.2.3",
  tagger: { name: "server[bot]", email: "3000+server[bot]@users.noreply.github.com" },
  object: { type: "commit", sha: mergeSha },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ensureReleaseTag", () => {
  test("creates an annotated tag and verifies the resulting ref", async () => {
    let refReads = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/git/ref/tags%2Fv1.2.3")) {
        refReads += 1;
        return refReads === 1
          ? response({ message: "Not Found" }, 404)
          : response({ object: { type: "tag", sha: "tag-sha" } });
      }
      if (method === "POST" && url.pathname.endsWith("/git/tags")) return response({ sha: "tag-sha" }, 201);
      if (method === "POST" && url.pathname.endsWith("/git/refs")) return response({ ref: "refs/tags/v1.2.3" }, 201);
      if (method === "GET" && url.pathname.endsWith("/git/tags/tag-sha")) return response(tag);
      return response({ message: `Unexpected ${method} ${url.pathname}` }, 500);
    };
    await expect(ensureReleaseTag(github("token", fetch as typeof globalThis.fetch), plan)).resolves.toEqual(plan);
    expect(refReads).toBe(2);
  });

  test("returns without writing when the verified tag already exists", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: "tag-sha" } } },
      { method: "GET", path: "/repos/owner/repo/git/tags/tag-sha", body: tag },
    ]);
    await expect(ensureReleaseTag(github("token", fetch), plan)).resolves.toEqual(plan);
    expect(fetch.requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  test("treats a 422 ref race as success only after verifying the tag", async () => {
    let refReads = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/git/ref/tags%2Fv1.2.3")) {
        refReads += 1;
        return refReads === 1
          ? response({ message: "Not Found" }, 404)
          : response({ object: { type: "tag", sha: "tag-sha" } });
      }
      if (method === "POST" && url.pathname.endsWith("/git/tags")) return response({ sha: "tag-sha" }, 201);
      if (method === "POST" && url.pathname.endsWith("/git/refs")) return response({ message: "Reference already exists" }, 422);
      if (method === "GET" && url.pathname.endsWith("/git/tags/tag-sha")) return response(tag);
      return response({ message: `Unexpected ${method} ${url.pathname}` }, 500);
    };
    await expect(ensureReleaseTag(github("token", fetch as typeof globalThis.fetch), plan)).resolves.toEqual(plan);
    expect(refReads).toBe(2);
  });

  test("rejects when the created ref is missing after a successful write", async () => {
    let refReads = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/git/ref/tags%2Fv1.2.3")) {
        refReads += 1;
        return response({ message: "Not Found" }, 404);
      }
      if (method === "POST" && url.pathname.endsWith("/git/tags")) return response({ sha: "tag-sha" }, 201);
      if (method === "POST" && url.pathname.endsWith("/git/refs")) return response({ ref: "refs/tags/v1.2.3" }, 201);
      return response({ message: `Unexpected ${method} ${url.pathname}` }, 500);
    };
    await expect(ensureReleaseTag(github("token", fetch as typeof globalThis.fetch), plan)).rejects.toThrow("tag v1.2.3 was not created");
    expect(refReads).toBe(2);
  });

  test("propagates a ref creation API failure", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/git/ref/tags%2Fv1.2.3", status: 404, body: { message: "Not Found" } },
      { method: "POST", path: "/repos/owner/repo/git/tags", status: 201, body: { sha: "tag-sha" } },
      { method: "POST", path: "/repos/owner/repo/git/refs", status: 503, body: { message: "temporary outage" } },
    ]);
    await expect(ensureReleaseTag(github("token", fetch), plan)).rejects.toThrow("temporary outage");
  });
});
