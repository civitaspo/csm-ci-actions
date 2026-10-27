import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseConfig, repositoryEntry, type Config } from "../src/lib/config.ts";
import { github } from "../src/lib/github.ts";
import { fakeFetch } from "../src/lib/testing.ts";
import { CLIENT, SERVER } from "./harness.ts";
import { withRepositoryPolicy } from "./repository-policy.ts";

const fixture = readFileSync(new URL("./fixtures/testing-csm-ci-server/csm-ci.yaml", import.meta.url), "utf8");
const path = `/repos/${SERVER}/contents/csm-ci.yaml`;
function context(text = fixture) {
  const file = { type: "file", sha: "original", content: Buffer.from(text).toString("base64") };
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/${SERVER}/git/ref/heads%2Fmain`, body: { object: { sha: "head" } } },
    { method: "GET", path, body: file },
    { method: "PUT", path, body: { content: { sha: "changed" } } },
  ]);
  const gh = github("test", fetch);
  gh.hook.after("request", (_response, options) => {
    if (options.method === "PUT") {
      const { content } = z.object({ content: z.string() }).parse(options);
      file.content = content;
      file.sha = "changed";
    }
  });
  return { ctx: { gh, urls: [], untrusted: undefined }, fetch };
}

test.each([
  { sensitive_paths: { paths: [], exempt: [] } },
  { sensitive_paths: { paths: ["**"] } },
  { merge: { allow_bot_requests: false } },
] satisfies Array<Pick<Config["repositories"][number], "sensitive_paths" | "merge">>)("repository fixture exposes its complete first-match override %j", async (override) => {
  const { ctx, fetch } = context();
  let called = false;
  await withRepositoryPolicy(ctx, override, async () => {
    called = true;
    const write = fetch.requests.find((request) => request.method === "PUT");
    const { content } = z.object({ content: z.string() }).parse(JSON.parse(write?.body ?? "{}"));
    const written = parseConfig(Buffer.from(content, "base64").toString("utf8"));
    const original = parseConfig(fixture);
    const entry = repositoryEntry(original, CLIENT);
    if (!entry) throw new Error("missing original client fixture");
    expect(repositoryEntry(written, CLIENT)).toEqual({ ...entry, ...override });
    expect(written.repositories.slice(1)).toEqual(original.repositories);
    expect(written.trust).toEqual(original.trust);
  });
  expect(called).toBe(true);
});

test("repository fixture rejects a missing exact client entry before writing", async () => {
  const { ctx, fetch } = context(fixture.replace(CLIENT, "civitaspo/other-client"));
  await expect(withRepositoryPolicy(ctx, { merge: { allow_bot_requests: false } }, async () => {})).rejects.toThrow("the client fixture must have an exact repository entry");
  expect(fetch.requests.some((request) => request.method === "PUT")).toBe(false);
});
