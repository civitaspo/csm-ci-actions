import { expect, test } from "bun:test";
import { GENERATED_HEADER } from "./generated-workflows.ts";
import { github } from "./github.ts";
import { applyManagedFiles, inspectManagedFiles } from "./managed-files.ts";

const defaultSha = "a".repeat(40), movedSha = "e".repeat(40), pendingSha = "f".repeat(40);
const approve = ".github/workflows/csm-ci-approve.yml", merge = ".github/workflows/csm-ci-merge.yml";
const release = { version: "v1.2.3", sha: "1".repeat(40) };
const header = `${GENERATED_HEADER}v1.0.0 (${"2".repeat(40)}).\n`;
const desired = `${GENERATED_HEADER}${release.version} (${release.sha}).\nnew\n`;
const base = { repository: "owner/client", defaultBranch: "trunk", serverBotId: 900 };
const generated = { release, files: { [approve]: desired } };
const isMutation = (body: unknown) => typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation");

function fixture(options: {
  contents?: Record<string, string>; pending?: Record<string, string>; pendingChanges?: string[];
  moveDefaultAt?: number; movePending?: boolean; pendingPullNumberChanges?: boolean; changeDefaultAt?: { read: number; contents: Record<string, string> };
} = {}) {
  const requests: { pathname: string; body: unknown }[] = [];
  let branch = options.pending ? pendingSha : null;
  let contents: Record<string, Record<string, string>> = { [defaultSha]: options.contents ?? { [approve]: header }, [movedSha]: {}, [pendingSha]: options.pending ?? {} };
  let defaultReads = 0, branchReads = 0, openReads = 0, defaultTreeReads = 0;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const pathname = decodeURIComponent(url.pathname);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ pathname, body });
    if (pathname.endsWith("/git/ref/heads/trunk")) { defaultReads++; return response({ object: { sha: options.moveDefaultAt !== undefined && defaultReads >= options.moveDefaultAt ? movedSha : defaultSha } }); }
    if (pathname.endsWith("/git/ref/heads/csm-ci/repo-settings")) { branchReads++; if (options.movePending && branchReads >= 2) branch = pendingSha; return branch ? response({ object: { sha: branch } }) : response({ message: "Not Found" }, 404); }
    if (pathname.endsWith("/git/refs")) { branch = defaultSha; return response({}); }
    if (pathname.endsWith("/pulls") && (init?.method ?? "GET") === "GET") {
      openReads++;
      return response(options.pending ? [{ number: options.pendingPullNumberChanges && openReads >= 2 ? 91 : 90, title: "chore(repo-settings): sync managed files", body: options.pendingPullNumberChanges ? "needs metadata refresh" : `Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->\n\nStandard client workflows: ${release.version} (${release.sha}).`, base: { ref: "trunk" }, head: { sha: branch } }] : []);
    }
    if (pathname.endsWith("/pulls") && init?.method === "POST") return response({ number: 90 });
    if (pathname.includes("/compare/")) return response({ ahead_by: 1, merge_base_commit: { sha: defaultSha }, commits: [{ sha: pendingSha }] });
    if (pathname.includes("/commits/")) {
      const sha = pathname.split("/commits/")[1]!;
      return response({ sha, parents: [{ sha: defaultSha }], author: { id: 900 }, committer: { login: "web-flow" }, commit: { message: "chore(repo-settings): sync managed files", verification: { verified: true }, tree: { sha: `tree:${sha}:0` } }, files: (options.pendingChanges ?? [approve]).map((filename) => ({ filename })) });
    }
    if (pathname.includes("/git/trees/")) {
      const [, sha, level] = pathname.split("/git/trees/")[1]!.split(":");
      if (sha === defaultSha && level === "2" && options.changeDefaultAt && ++defaultTreeReads >= options.changeDefaultAt.read) contents = { ...contents, [defaultSha]: options.changeDefaultAt.contents };
      const files = contents[sha!] ?? {};
      const entries = Number(level) < 2 ? Object.keys(files).length ? [{ path: level === "0" ? ".github" : "workflows", type: "tree", mode: "040000", sha: `tree:${sha}:${Number(level) + 1}` }] : [] : Object.keys(files).map((name) => ({ path: name.split("/").at(-1), type: "blob", mode: "100644", sha: `blob:${sha}:${name}` }));
      return response({ truncated: false, tree: entries });
    }
    if (pathname.includes("/git/blobs/")) {
      const [, sha, name] = pathname.split("/git/blobs/")[1]!.split(":");
      return response({ encoding: "base64", content: Buffer.from(contents[sha!]?.[name!] ?? "").toString("base64") });
    }
    if (pathname === "/graphql") {
      if (isMutation(body)) {
        const input = (body as { variables: { input: { fileChanges: { additions: { path: string; contents: string }[]; deletions: { path: string }[] } } } }).variables.input;
        const next = { ...contents[defaultSha] };
        for (const addition of input.fileChanges.additions) next[addition.path] = Buffer.from(addition.contents, "base64").toString("utf8");
        for (const deletion of input.fileChanges.deletions) delete next[deletion.path];
        contents = { ...contents, [pendingSha]: next };
        branch = pendingSha;
        return response({ data: { createCommitOnBranch: { commit: { oid: pendingSha } } } });
      }
      return response({ data: { repository: { commit: { signature: { isValid: true, wasSignedByGitHub: true } } } } });
    }
    return response({ message: `unexpected ${pathname}` }, 404);
  }, { preconnect: globalThis.fetch.preconnect });
  return { gh: github("test", fetcher), requests, contents: () => contents };
}

test.each([
  ["replaces a differing custom selected caller", { [approve]: "name: custom\n" }, generated.files, [approve], []],
  ["replaces a header file at a selected path", { [approve]: `${header}old\n` }, generated.files, [approve], []],
  ["makes no change when the selected caller is equal", { [approve]: desired }, generated.files, [], []],
  ["deletes a header file at an unselected standard path", { [merge]: header }, {}, [merge], [merge]],
  ["deletes a header file at a non-standard path", { ".github/workflows/old.yml": header, ".github/workflows/old.yaml": header }, {}, [".github/workflows/old.yaml", ".github/workflows/old.yml"], [".github/workflows/old.yaml", ".github/workflows/old.yml"]],
  ["preserves a custom unselected caller", { [merge]: "name: custom\n" }, {}, [], []],
  ["preserves a file with the header only on a later line", { ".github/workflows/later.yml": `name: later\n${header}` }, {}, [], []],
  ["preserves a header file that is not a workflow file", { ".github/workflows/notes.txt": header }, {}, [], []],
  ["writes an absent selected caller", {}, generated.files, [approve], []],
] satisfies [string, Record<string, string>, Record<string, string>, string[], string[]][])("%s", async (_name, contents, files, changedPaths, deletions) => {
  const result = await inspectManagedFiles(fixture({ contents }).gh, { ...base, files: {}, generated: { release, files } });
  expect(result.changedPaths.sort()).toEqual(changedPaths);
  expect(result.deletions ?? []).toEqual(deletions);
  expect(result.status).toBe(changedPaths.length === 0 ? "already-applied" : "ready");
});

test.each([
  ["selected caller", { [approve]: header }, generated.files, approve],
  ["header deletion", { [merge]: header }, {}, merge],
] satisfies [string, Record<string, string>, Record<string, string>, string][])("rejects an additional file colliding with a generated %s", async (_name, contents, files, path) => {
  await expect(inspectManagedFiles(fixture({ contents }).gh, { ...base, files: { [path]: "additional\n" }, generated: { release, files } })).rejects.toThrow(`managed files contain duplicate producer destination "${path}"`);
});

test("an additional file may manage an unselected path without the header", async () => {
  const result = await inspectManagedFiles(fixture({ contents: { [merge]: "name: custom\n" } }).gh, { ...base, files: { [merge]: "operator\n" }, generated: { release, files: {} } });
  expect(result.deletions).toEqual([]);
  expect(result.changedPaths).toEqual([merge]);
});

test("last caller deletion uses an expected-head commit without a body and leaves an unchanged repeat alone", async () => {
  const f = fixture({ contents: { [approve]: header } });
  const input = { ...base, files: {}, generated: { release, files: {} }, writeToken: "test", writeClient: f.gh };
  expect(await applyManagedFiles(f.gh, input)).toEqual({ status: "applied", commit: pendingSha, pullRequest: 90 });
  expect(f.contents()[pendingSha]).toEqual({});
  const mutations = f.requests.filter(({ body }) => isMutation(body));
  expect(mutations).toHaveLength(1);
  expect(mutations[0]!.body).toMatchObject({ variables: { input: { expectedHeadOid: defaultSha, message: { headline: "chore(repo-settings): sync managed files" }, fileChanges: { additions: [], deletions: [{ path: approve }] } } } });
  expect(JSON.stringify(mutations[0]!.body)).not.toContain('"body"');
  const repeated = fixture({ contents: { [approve]: header }, pending: {} });
  expect(await applyManagedFiles(repeated.gh, { ...input, writeClient: repeated.gh })).toEqual({ status: "already-applied", commit: pendingSha, pullRequest: 90 });
  expect(repeated.requests.filter(({ body }) => isMutation(body))).toEqual([]);
});

test("a pending branch with the generated content is reused", async () => {
  const f = fixture({ contents: { [approve]: "name: custom\n" }, pending: { [approve]: desired } });
  const result = await inspectManagedFiles(f.gh, { ...base, files: {}, generated });
  expect(result.status).toBe("already-applied");
  expect(result.branchNeedsWrite).toBe(false);
});

test("pending full history still rejects removed additional paths", async () => {
  const f = fixture({ pending: { [approve]: desired }, pendingChanges: [approve, "removed-additional.txt"] });
  await expect(inspectManagedFiles(f.gh, { ...base, files: {}, generated })).rejects.toThrow('managed files branch changed unmanaged path "removed-additional.txt"');
});

test("pending history allows a generated deletion path", async () => {
  const f = fixture({ contents: { [merge]: header }, pending: {}, pendingChanges: [merge] });
  expect((await inspectManagedFiles(f.gh, { ...base, files: {}, generated: { release, files: {} } })).status).toBe("already-applied");
});

test.each([
  ["default branch", { moveDefaultAt: 2 }],
  ["pending branch", { movePending: true }],
  ["pending PR binding", { pending: { [approve]: desired }, pendingPullNumberChanges: true }],
])("revalidates concurrent %s movement before any write", async (_name, options) => {
  const f = fixture(options);
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows state changed before managed file write");
  expect(f.requests.filter(({ pathname, body }) => pathname.endsWith("/git/refs") || isMutation(body))).toEqual([]);
});

test("revalidates default again immediately before signed commit creation", async () => {
  const f = fixture({ moveDefaultAt: 4 });
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows default branch moved before commit creation");
  expect(f.requests.filter(({ body }) => isMutation(body))).toEqual([]);
});

test("revalidates header deletions again before signed commit creation", async () => {
  const f = fixture({ contents: { [merge]: header }, changeDefaultAt: { read: 3, contents: { [merge]: "name: custom\n" } } });
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated: { release, files: {} }, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows deletions changed before commit creation");
  expect(f.requests.filter(({ body }) => isMutation(body))).toEqual([]);
});
