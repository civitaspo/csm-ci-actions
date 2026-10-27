import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseConfig } from "../src/lib/config.ts";
import { github } from "../src/lib/github.ts";
import { SERVER } from "./harness.ts";
import { withTestBotConfigured } from "./merge.ts";
import { withRepositoryPolicy } from "./repository-policy.ts";

const original = readFileSync(new URL("./fixtures/testing-csm-ci-server/csm-ci.yaml", import.meta.url), "utf8");
test.each([false, true])("nested Bot policy fixture restores original bytes after failure=%s with stale mutable content", async (fail) => {
  let text = original;
  let writes = 0;
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/repos/${SERVER}/git/ref/heads%2Fmain`) return Response.json({ object: { sha: `head-${writes}` } });
    if (url.pathname !== `/repos/${SERVER}/contents/csm-ci.yaml`) throw new Error(`unexpected request: ${url.pathname}`);
    if (init?.method === "PUT") {
      const body = z.object({ sha: z.string(), content: z.string() }).parse(JSON.parse(String(init.body)));
      expect(body.sha).toBe(`blob-${writes}`);
      text = Buffer.from(body.content, "base64").toString("utf8");
      writes += 1;
      return Response.json({ content: { sha: `blob-${writes}` } });
    }
    const content = url.searchParams.get("ref") === "main" ? original : text;
    return Response.json({ type: "file", sha: `blob-${writes}`, content: Buffer.from(content).toString("base64") });
  }, { preconnect() {} });
  const ctx = { gh: github("test", fetch), urls: [], untrusted: undefined };
  const run = withTestBotConfigured(ctx, async () => {
    await withRepositoryPolicy(ctx, { sensitive_paths: { paths: [] }, merge: { allow_bot_requests: true } }, async () => {
      expect(parseConfig(text).trust.bot_mergers).toContainEqual({ id: 347402450, login: "testing-csm-ci-untrusted-committer[bot]" });
      if (fail) throw new Error("scenario failed");
    });
    expect(parseConfig(text).trust.bot_mergers).toHaveLength(1);
  });
  if (fail) await expect(run).rejects.toThrow("scenario failed");
  else await run;
  expect(writes).toBe(4);
  expect(text).toBe(original);
});
