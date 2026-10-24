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
  privateRepository: false,
  release: { build_type: "none" },
  makeLatest: true,
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

describe("publishRelease", () => {
  test("rejects a manifest that differs from the build outputs before API writes", async () => {
    await assets();
    const fetch = fakeFetch([]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: [{ name: "app.txt", sha256: "0".repeat(64) }],
      directory,
    })).rejects.toThrow("release asset manifest does not match the build outputs");
    expect(fetch.calls).toEqual([]);
  });

  test("propagates release lookup failures that do not mean missing", async () => {
    await assets();
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", status: 500, body: { message: "server error" } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("server error");
  });

  test("rejects an existing release owned by another bot", async () => {
    await assets();
    const fetch = fakeFetch([
      { method: "GET", path: "/repos/owner/repo/releases/tags/v1.2.3", body: { id: 7, tag_name: "v1.2.3", author: { id: 4000 } } },
    ]);
    await expect(publishRelease(github("t", fetch), {
      plan,
      expectedAssets: (await prepareAssets(directory)).map(({ name, sha256 }) => ({ name, sha256 })),
      directory,
    })).rejects.toThrow("release v1.2.3 was not created by the Server bot");
  });
});
