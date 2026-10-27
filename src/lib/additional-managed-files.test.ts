import { describe, expect, test } from "bun:test";
import { loadAdditionalManagedFiles } from "./additional-managed-files.ts";
import { parseConfig } from "./config.ts";
import { github } from "./github.ts";
import { CONFIG_YAML, fakeFetch } from "./testing.ts";

const sha = "a".repeat(40);
function settings(files: Record<string, string>, funding = false) {
  return parseConfig(`${CONFIG_YAML}\nrepo_settings: ${JSON.stringify({ additional_managed_files: files, ...(funding ? { sponsorships: { enabled: false, github: ["user"] } } : {}) })}`).repo_settings;
}
function fixture(options: {
  root?: unknown; tree?: unknown; blob?: unknown; status?: number; bytes?: Buffer;
} = {}) {
  const fetch = fakeFetch([
    { method: "GET", path: `/repos/owner/server/commits/${sha}`, body: options.root ?? { commit: { tree: { sha: "root" } } } },
    { method: "GET", path: "/repos/owner/server/git/trees/root", body: options.tree ?? { truncated: false, tree: [{ path: "source", type: "blob", mode: "100644", sha: "blob" }] } },
    { method: "GET", path: "/repos/owner/server/git/blobs/blob", status: options.status ?? 200, body: options.blob ?? { encoding: "base64", content: (options.bytes ?? Buffer.from("\ufeffexact\r\n${{ literal }}\n")).toString("base64") } },
  ]);
  return { fetch, gh: github("config-reader", fetch, { backoffMs: [] }) };
}
const args = { repository: "owner/server", sha, settings: settings({ "target": "source" }) };
describe("Server-source additional managed files", () => {
  test("preserves BOM, CRLF and literal templates, pins reads, counts repeated source copies, and observes source-only changes", async () => {
    const first = fixture();
    const input = { ...args, settings: settings({ first: "source", second: "source" }) };
    expect(await loadAdditionalManagedFiles(first.gh, input)).toEqual({ first: "\ufeffexact\r\n${{ literal }}\n", second: "\ufeffexact\r\n${{ literal }}\n" });
    expect(await loadAdditionalManagedFiles(first.gh, input)).toEqual(await loadAdditionalManagedFiles(first.gh, input));
    expect(first.fetch.requests.filter((request) => request.path.includes("/commits/")).every((request) => request.path.endsWith(sha))).toBe(true);
    const changed = fixture({ bytes: Buffer.from("changed") });
    expect(await loadAdditionalManagedFiles(changed.gh, args)).toEqual({ target: "changed" });
  });
  test("accepts regular executable source without copying its mode and permits empty files", async () => {
    const { gh } = fixture({ tree: { tree: [{ path: "source", type: "blob", mode: "100755", sha: "blob" }] }, bytes: Buffer.alloc(0) });
    expect(await loadAdditionalManagedFiles(gh, args)).toEqual({ target: "" });
  });
  test("traverses directory trees from the repository root", async () => {
    const fetch = fakeFetch([
      { method: "GET", path: `/repos/owner/server/commits/${sha}`, body: { commit: { tree: { sha: "root" } } } },
      { method: "GET", path: "/repos/owner/server/git/trees/root", body: { tree: [{ path: "dir", type: "tree", mode: "040000", sha: "directory" }] } },
      { method: "GET", path: "/repos/owner/server/git/trees/directory", body: { tree: [{ path: "source", type: "blob", mode: "100644", sha: "blob" }] } },
      { method: "GET", path: "/repos/owner/server/git/blobs/blob", body: { encoding: "base64", content: "eA==" } },
    ]);
    expect(await loadAdditionalManagedFiles(github("reader", fetch), { ...args, settings: settings({ target: "dir/source" }) })).toEqual({ target: "x" });
  });
  test.each([
    ["missing source", { tree: { tree: [] } }, "source\" is missing"],
    ["missing commit tree SHA", { root: { commit: { tree: {} } } }, "commit has no Git tree SHA"],
    ["truncated tree", { tree: { truncated: true, tree: [] } }, "could not safely inspect a Git tree"],
    ...[
      ["symlink", "blob", "120000", "blob"], ["submodule", "commit", "160000", "blob"],
      ["directory leaf", "tree", "040000", "blob"], ["inconsistent leaf type", "tree", "100644", "blob"], ["missing blob SHA", "blob", "100644", undefined],
    ].map(([name, type, mode, objectSha]) => [name, { tree: { tree: [{ path: "source", type, mode, sha: objectSha }] } }, "is not a regular file in the Git tree"] as const),
    ["missing content", { blob: { encoding: "base64" } }, "malformed or unsupported Git blob encoding"],
    ["encoding", { blob: { encoding: "utf-8", content: "text" } }, "malformed or unsupported Git blob encoding"],
    ...["???=", "eA", "eB==", "eA== ", "é==="].map((content) => [`base64 ${content}`, { blob: { encoding: "base64", content } }, "malformed or unsupported Git blob encoding"] as const),
    ["UTF-8", { bytes: Buffer.from([0xc3, 0x28]) }, "is not UTF-8"],
    ["API error", { status: 403, blob: { message: "source API denied" } }, "source API denied"],
    ["file limit", { bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 120) }, "is larger than 8MB"],
  ] as const)("rejects %s with its message", async (_name, options, message) => {
    const { gh } = fixture(options);
    await expect(loadAdditionalManagedFiles(gh, args)).rejects.toThrow(message);
  });
  test.each([
    { type: "blob", mode: "040000", sha: "blob" },
    { type: "blob", mode: "100644", sha: "blob" }, { type: "commit", mode: "160000", sha: "blob" },
    { type: "blob", mode: "120000", sha: "blob" }, { type: "tree", mode: "040000" },
  ])("rejects non-tree ancestors %j", async (entry) => {
    const { gh } = fixture({ tree: { tree: [{ path: "source", ...entry }] } });
    await expect(loadAdditionalManagedFiles(gh, { ...args, settings: settings({ target: "source/child" }) })).rejects.toThrow('traverses a non-directory Git entry at "source"');
  });
  test("checks combined actual bytes including each repeated source copy and funding", async () => {
    const { gh } = fixture({ bytes: Buffer.alloc(5 * 1024 * 1024, 120) });
    expect(Object.keys(await loadAdditionalManagedFiles(gh, { ...args, settings: settings({ a: "source", b: "source" }) }))).toHaveLength(2);
    await expect(loadAdditionalManagedFiles(gh, { ...args, settings: settings({ a: "source", b: "source" }, true) })).rejects.toThrow("larger than 10MB in total");
  });
  test("stops reading sources as soon as combined content exceeds the limit", async () => {
    const { gh, fetch } = fixture({ bytes: Buffer.alloc(4 * 1024 * 1024, 120) });
    await expect(loadAdditionalManagedFiles(gh, { ...args, settings: settings({ a: "source", b: "source", c: "source", d: "source" }) })).rejects.toThrow("larger than 10MB in total");
    expect(fetch.requests.filter((request) => request.path.endsWith("/git/blobs/blob"))).toHaveLength(3);
  });
  test("omission and removal stop managing without source reads", async () => {
    const fetch = fakeFetch([]);
    expect(await loadAdditionalManagedFiles(github("reader", fetch), { ...args, settings: undefined })).toEqual({});
    expect(await loadAdditionalManagedFiles(github("reader", fetch), { ...args, settings: settings({}) })).toEqual({});
    expect(fetch.requests).toHaveLength(0);
  });
  test.each([{}, null, { a: "inline" }])("rejects removed key even empty or null: %j", (legacy) => {
    for (const extra of [{}, { additional_managed_files: {} }]) {
      expect(() => parseConfig(`${CONFIG_YAML}\nrepo_settings: ${JSON.stringify({ managed_files: legacy, ...extra })}`)).toThrow("commit inline contents as Server source files and replace the key with repo_settings.additional_managed_files");
    }
  });
  test.each(["", "../x", "/x", "C:/x", "a\\b", "a\nb", "a//b", "a/./b", "a/.GiT/b", "a/*", "https://example.test/file"])("rejects unsafe source %j during shared parsing", (source) => {
    expect(() => settings({ target: source })).toThrow("source must be a safe literal relative file path");
  });
});
