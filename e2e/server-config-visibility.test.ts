import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fakeFetch } from "../src/lib/testing.ts";
import { github } from "../src/lib/github.ts";
import { configureRelease, SERVER, withServerConfig, withoutReleaseOperation } from "./harness.ts";

const original = readFileSync(new URL("./fixtures/testing-csm-ci-server/csm-ci.yaml", import.meta.url), "utf8");
const disabled = withoutReleaseOperation(original);

function configApi(staleHeadReads: number | number[] = 0, onHeadRead: (written: boolean) => void = () => {}) {
  const commits = new Map([["commit-0", original]]);
  const contentRefs: string[] = [];
  const writes: string[] = [];
  let head = "commit-0";
  let previousHead = head;
  let visibleHead = head;
  let remainingStaleReads = 0;
  let mutableContent = original;
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/repos/${SERVER}/git/ref/heads%2Fmain`) {
      onHeadRead(writes.length > 0);
      visibleHead = remainingStaleReads-- > 0 ? previousHead : head;
      return Response.json({ object: { sha: visibleHead } });
    }
    if (url.pathname !== `/repos/${SERVER}/contents/csm-ci.yaml`) throw new Error(`unexpected request: ${url.pathname}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      const text = Buffer.from(body.content, "base64").toString("utf8");
      expect(body.sha).toBe(`blob-${head}`);
      writes.push(text);
      previousHead = head;
      head = `commit-${writes.length}`;
      commits.set(head, text);
      remainingStaleReads = typeof staleHeadReads === "number" ? staleHeadReads : staleHeadReads[writes.length - 1] ?? 0;
      if (text === disabled) mutableContent = disabled;
      return Response.json({ content: { sha: `blob-${head}` }, commit: { sha: head } });
    }
    const ref = url.searchParams.get("ref") ?? "main";
    contentRefs.push(ref);
    const text = ref === "main" ? mutableContent : commits.get(ref);
    if (text === undefined) throw new Error(`unknown commit: ${ref}`);
    return Response.json({ type: "file", sha: `blob-${ref === "main" ? head : ref}`, content: Buffer.from(text).toString("base64") });
  }, { preconnect: () => undefined });
  return { ctx: { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined }, writes, contentRefs,
    visibleText: () => commits.get(visibleHead) };
}

test("consecutive server config scenarios use immutable contents despite a stale disabled main response", async () => {
  const { ctx, writes, contentRefs } = configApi();
  await withServerConfig(ctx, withoutReleaseOperation, async () => "disabled");
  await withServerConfig(ctx, configureRelease("goreleaser"), async () => "goreleaser");
  expect(writes).toEqual([disabled, original, configureRelease("goreleaser")(original), original]);
  expect(contentRefs).not.toContain("main");
});

test("server config waits for changed and restored content to become visible", async () => {
  const { ctx, writes, visibleText } = configApi(1);
  await withServerConfig(ctx, withoutReleaseOperation, async () => {
    expect(visibleText()).toBe(disabled);
  });
  expect(visibleText()).toBe(original);
  expect(writes).toEqual([disabled, original]);
}, 20_000);


test("server config visibility polling has a deadline and restores the successful write without running the scenario", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let ran = false;
  try {
    const { ctx, writes } = configApi([Infinity, 0], (written) => { if (written) now += 11 * 60_000; });
    await expect(withServerConfig(ctx, withoutReleaseOperation, async () => { ran = true; }))
      .rejects.toThrow("timed out waiting for server fixture content visibility");
    expect(ran).toBe(false);
    expect(writes).toEqual([disabled, original]);
  } finally {
    clock.mockRestore();
  }
});

test.each([403, 404, 422])("server config propagates HTTP %i during pinned content reads", async (status) => {
  let writes = 0;
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "PUT") writes++;
    if (url.pathname.endsWith("/git/ref/heads%2Fmain")) return Response.json({ object: { sha: "head" } });
    return Response.json({ message: "config read failed" }, { status });
  }, { preconnect: () => undefined });
  const ctx = { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined };
  await expect(withServerConfig(ctx, withoutReleaseOperation, async () => {})).rejects.toThrow("config read failed");
  expect(writes).toBe(0);
});


test("server config rejects a write response without content identity and still restores visible changed content", async () => {
  const file = (text: string) => ({ type: "file", sha: "blob", content: Buffer.from(text).toString("base64") });
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${SERVER}/git/ref/heads%2Fmain`, body: { object: { sha: "head" } } },
    { method: "GET", path: `/repos/${SERVER}/contents/csm-ci.yaml`, body: file(original), then: [file(disabled), file(original)] },
    { method: "PUT", path: `/repos/${SERVER}/contents/csm-ci.yaml`, body: { content: null } },
  ]);
  const ctx = { gh: github("test", fetch, { backoffMs: [] }), urls: [], untrusted: undefined };
  await expect(withServerConfig(ctx, withoutReleaseOperation, async () => {})).rejects.toThrow("server fixture write returned no content SHA");
  expect(fetch.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
});
