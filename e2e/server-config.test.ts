import { describe, expect, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { CONFIG_YAML, fakeFetch } from "../src/lib/testing.ts";
import { type Ctx, SERVER, withServerConfig } from "./harness.ts";

const changed = `${CONFIG_YAML}\n# temporary fixture\n`;
function fixture(restoredText = changed) {
  const file = (sha: string, text: string) => ({ type: "file", sha, content: Buffer.from(text).toString("base64") });
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${SERVER}/git/ref/heads%2Fmain`, body: { object: { sha: "head" } } },
    { method: "GET", path: `/repos/${SERVER}/contents/csm-ci.yaml`, body: file("original", CONFIG_YAML), then: [file("changed", changed), file("latest", restoredText), file("restored", CONFIG_YAML)] },
    { method: "PUT", path: `/repos/${SERVER}/contents/csm-ci.yaml`, body: { content: { sha: "changed" } } },
  ]);
  const ctx: Ctx = { gh: github("test", fetch), urls: [], untrusted: undefined };
  return { ctx, fetch };
}

describe("temporary server configuration cleanup", () => {
  test("restores the original bytes with the latest lease and returns the scenario result", async () => {
    const { ctx, fetch } = fixture();
    expect(await withServerConfig(ctx, () => changed, async () => "scenario result")).toBe("scenario result");
    const writes = fetch.requests.filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toMatchObject({ sha: "original", content: Buffer.from(changed).toString("base64") });
    expect(JSON.parse(writes[1]?.body ?? "{}")).toMatchObject({ sha: "latest", content: Buffer.from(CONFIG_YAML).toString("base64") });
  });

  test("does not write when the requested configuration is unchanged", async () => {
    const { ctx, fetch } = fixture();
    expect(await withServerConfig(ctx, (text) => text, async () => "unchanged result")).toBe("unchanged result");
    expect(fetch.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test.each(["read", "write"])("preserves the scenario error and HTTP status when restoration %s fails", async (failure) => {
    const { ctx } = fixture();
    let reads = 0;
    let writes = 0;
    ctx.gh.hook.before("request", (options) => {
      if (options.method === "GET" && options.url.includes("/contents/")) reads += 1;
      if (options.method === "PUT") writes += 1;
      if ((failure === "read" && reads === 3) || (failure === "write" && options.method === "PUT" && writes === 2)) {
        throw new Error(`config restoration ${failure} failed`);
      }
    });
    const primary = Object.assign(new Error("primary scenario failure"), { status: 422 });
    await expect(withServerConfig(ctx, () => changed, async () => { throw primary; })).rejects.toThrow(
      `primary scenario failure (HTTP 422); config restoration ${failure} failed`,
    );
  });

  test("preserves the scenario error and refuses to overwrite an unexpected external edit", async () => {
    const { ctx, fetch } = fixture(`${CONFIG_YAML}\n# another operator\n`);
    await expect(withServerConfig(ctx, () => changed, async () => { throw new Error("scenario failed"); })).rejects.toThrow(
      "scenario failed; server fixture changed unexpectedly during e2e; refusing to overwrite it",
    );
    expect(fetch.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("keeps an original fixture already restored by another actor", async () => {
    const { ctx, fetch } = fixture(CONFIG_YAML);
    await withServerConfig(ctx, () => changed, async () => {});
    expect(fetch.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });
});
