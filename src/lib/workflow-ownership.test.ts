import { expect, test } from "bun:test";
import { digest } from "./generated-workflows.ts";
import { github } from "./github.ts";
import { applyManagedFiles, inspectManagedFiles } from "./managed-files.ts";
import { GENERATED_MARKER, inspectGeneratedWorkflows, ownershipBody, parseOwnership, recoverWorkflowOwnership, type GeneratedRecord } from "./workflow-ownership.ts";

const defaultSha = "a".repeat(40), originalHead = "b".repeat(40), mergedSha = "c".repeat(40), olderHead = "d".repeat(40), olderMerge = "e".repeat(40), pendingSha = "f".repeat(40);
const path = ".github/workflows/csm-ci-approve.yml", mergePath = ".github/workflows/csm-ci-merge.yml";
const release = { version: "v1.2.3", sha: "1".repeat(40) };
const record: GeneratedRecord = { repositoryId: 123, release, files: { [path]: digest("old") } };
const message = (value: GeneratedRecord) => `Sync managed files\n\n${ownershipBody(value)}`;
const base = { repository: "owner/client", repositoryId: 123, defaultBranch: "trunk", defaultSha, serverBotId: 900 };
const generated = { release, files: { [path]: "new" }, adoption: {} };
const pull = (head = originalHead, merge = mergedSha, number = 80) => ({ number, user: { id: 900 }, merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: merge, head: { ref: "csm-ci/repo-settings", sha: head, repo: { id: 123 } }, base: { ref: "trunk", repo: { id: 123 } } });

function fixture(options: {
  pulls?: object[]; messages?: Record<string, string>; contents?: Record<string, Record<string, string>>;
  signature?: boolean; graphqlSignature?: boolean; githubSignature?: boolean; author?: number; committer?: string;
  mode?: string; truncated?: boolean; encoding?: string; malformedBlob?: boolean; invalidUtf8?: boolean; missingHead?: boolean;
  comparison?: (base: string, head: string) => string | undefined; duplicatePage?: boolean;
  pending?: boolean; pendingChanges?: string[]; headRecord?: GeneratedRecord; moveDefault?: boolean; moveDefaultAt?: number; loseHistoryAt?: number; movePending?: boolean; pendingPullNumberChanges?: boolean;
  beforeRequest?: (request: { pathname: string; body: unknown }) => void;
} = {}) {
  const requests: { pathname: string; body: unknown }[] = [];
  let branch = options.pending ? pendingSha : null;
  let pendingMessage = message(options.headRecord ?? { ...record, files: { [path]: digest("new") } });
  let contents: Record<string, Record<string, string>> = { [defaultSha]: { [path]: "old" }, [originalHead]: { [path]: "old" }, [olderHead]: { [path]: "old" }, [pendingSha]: { [path]: "new" }, ...options.contents };
  let defaultReads = 0;
  let closedReads = 0, branchReads = 0, openReads = 0;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const pathname = decodeURIComponent(url.pathname);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    const request = { pathname, body };
    requests.push(request);
    options.beforeRequest?.(request);
    if (pathname === "/repos/owner/client") return response({ id: 123, default_branch: "trunk" });
    if (pathname.endsWith("/git/ref/heads/trunk")) { defaultReads++; return response({ object: { sha: (options.moveDefault || options.moveDefaultAt !== undefined) && defaultReads >= (options.moveDefaultAt ?? 2) ? olderMerge : defaultSha } }); }
    if (pathname.endsWith("/git/ref/heads/csm-ci/repo-settings")) { branchReads++; if (options.movePending && branchReads >= 2) branch = pendingSha; return branch ? response({ object: { sha: branch } }) : response({ message: "Not Found" }, 404); }
    if (pathname.endsWith("/git/refs")) { branch = defaultSha; return response({}); }
    if (pathname.endsWith("/pulls") && (init?.method ?? "GET") === "GET") {
      if (url.searchParams.get("state") === "open") { openReads++; return response(options.pending ? [{ number: options.pendingPullNumberChanges && openReads >= 2 ? 91 : 90, title: "chore(repo-settings): sync managed files", body: options.pendingPullNumberChanges ? "needs metadata refresh" : `Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->\n\nStandard client workflows: ${release.version} (${release.sha}).`, base: { ref: "trunk" }, head: { sha: branch } }] : []); }
      closedReads++;
      if (options.loseHistoryAt !== undefined && closedReads >= options.loseHistoryAt) return response([]);
      if (options.duplicatePage && Number(url.searchParams.get("page") ?? 1) > 2) return response({ message: "pagination requested a repeated page" }, 500);
      const pulls = options.pulls ?? [pull()];
      return response(Number(url.searchParams.get("page") ?? 1) > 1 && !options.duplicatePage ? [] : pulls);
    }
    if (pathname.endsWith("/pulls") && init?.method === "POST") return response({ number: 90 });
    if (pathname.includes("/compare/")) {
      const [ancestor, head] = pathname.split("/compare/")[1]!.split("...");
      if (head === pendingSha) return response({ ahead_by: 1, merge_base_commit: { sha: defaultSha }, commits: [{ sha: pendingSha }] });
      const mergeBase = options.comparison ? options.comparison(ancestor!, head!) : ancestor === mergedSha && head === olderMerge ? olderHead : ancestor;
      return response(mergeBase === undefined ? {} : { merge_base_commit: { sha: mergeBase } });
    }
    if (pathname.includes("/commits/")) {
      const sha = pathname.split("/commits/")[1]!;
      if (options.missingHead && sha === originalHead) return response({ message: "original head unavailable" }, 404);
      return response({ sha, parents: [{ sha: defaultSha }], author: { id: options.author ?? 900 }, committer: { login: options.committer ?? "web-flow" }, commit: { message: options.messages?.[sha] ?? (sha === pendingSha ? pendingMessage : message(record)), verification: { verified: options.signature ?? true }, tree: { sha: `tree:${sha}:0` } }, files: (options.pendingChanges ?? [path]).map((filename) => ({ filename })) });
    }
    if (pathname.includes("/git/trees/")) {
      const tree = pathname.split("/git/trees/")[1]!;
      const [, sha, level] = tree.split(":");
      const files = contents[sha!] ?? {};
      const entries = Number(level) < 2 ? Object.keys(files).length ? [{ path: level === "0" ? ".github" : "workflows", type: "tree", mode: "040000", sha: `tree:${sha}:${Number(level) + 1}` }] : [] : Object.keys(files).map((name) => ({ path: name.split("/").at(-1), type: options.mode === "160000" ? "commit" : "blob", mode: options.mode ?? "100644", sha: `blob:${sha}:${name}` }));
      return response({ truncated: options.truncated ?? false, tree: entries });
    }
    if (pathname.includes("/git/blobs/")) {
      const [, sha, name] = pathname.split("/git/blobs/")[1]!.split(":");
      return response({ encoding: options.encoding ?? "base64", content: options.malformedBlob ? "%%%" : options.invalidUtf8 ? Buffer.from([255]).toString("base64") : Buffer.from(contents[sha!]?.[name!] ?? "").toString("base64") });
    }
    if (pathname === "/graphql") {
      if (typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation")) {
        if (!("variables" in body) || typeof body.variables !== "object" || body.variables === null || !("input" in body.variables)) throw new Error("missing mutation input");
        const input = body.variables.input;
        if (typeof input !== "object" || input === null || !("fileChanges" in input) || !("message" in input)) throw new Error("missing file changes");
        const changes = input.fileChanges;
        if (typeof changes !== "object" || changes === null || !("additions" in changes) || !Array.isArray(changes.additions) || !("deletions" in changes) || !Array.isArray(changes.deletions)) throw new Error("missing change arrays");
        const next = { ...contents[defaultSha] };
        for (const addition of changes.additions) next[addition.path] = Buffer.from(addition.contents, "base64").toString("utf8");
        for (const deletion of changes.deletions) delete next[deletion.path];
        contents = { ...contents, [pendingSha]: next };
        branch = pendingSha;
        const commitMessage = input.message;
        if (typeof commitMessage !== "object" || commitMessage === null || !("headline" in commitMessage) || !("body" in commitMessage)) throw new Error("missing ownership commit body");
        pendingMessage = `${commitMessage.headline}\n\n${commitMessage.body}`;
        return response({ data: { createCommitOnBranch: { commit: { oid: pendingSha } } } });
      }
      return response({ data: { repository: { commit: { signature: { isValid: options.graphqlSignature ?? true, wasSignedByGitHub: options.githubSignature ?? true } } } } });
    }
    return response({ message: `unexpected ${pathname}` }, 404);
  }, { preconnect: globalThis.fetch.preconnect });
  return { gh: github("test", fetcher), requests, contents: () => contents, pendingMessage: () => pendingMessage };
}

test.each([
  ["wrong repository", { ...record, repositoryId: 124 }, "generated workflows ownership repository ID does not match"],
  ["unreserved destination", { ...record, files: { "custom.yml": digest("old") } }, "generated workflows ownership record is malformed"],
  ["nonhex digest", { ...record, files: { [path]: "Z".repeat(64) } }, "generated workflows ownership record is malformed"],
  ["unknown key", { ...record, other: true }, "generated workflows ownership record is malformed"],
  ["invalid release", { ...record, release: { ...release, sha: "short" } }, "generated workflows ownership record is malformed"],
])("rejects record %s", (_name, invalid, error) => {
  expect(() => parseOwnership(`Sync managed files\n\n${GENERATED_MARKER}\n${JSON.stringify(invalid)}`, 123)).toThrow(error);
});

test.each([
  ["REST signature", { signature: false }, "original managed head is not GitHub-signed"],
  ["GraphQL signature", { graphqlSignature: false }, "original managed head is not GitHub-signed"],
  ["non-GitHub signature", { githubSignature: false }, "original managed head is not GitHub-signed"],
  ["author", { author: 800 }, "original managed head is not GitHub-signed"],
  ["committer", { committer: "other" }, "original managed head is not GitHub-signed"],
  ["unavailable head", { missingHead: true }, "original head unavailable"],
  ["tree mismatch", { contents: { [originalHead]: { [path]: "copied metadata" } } }, "original head tree does not bind"],
  ["missing tree file", { contents: { [originalHead]: {} } }, "original head tree does not bind"],
  ["symlink", { mode: "120000" }, "is not a regular file"],
  ["submodule", { mode: "160000" }, "is not a regular file"],
  ["truncated tree", { truncated: true }, "could not safely inspect a Git tree"],
  ["blob encoding", { encoding: "utf8" }, "unsupported Git blob encoding"],
  ["malformed blob", { malformedBlob: true }, "malformed base64"],
  ["invalid UTF8", { invalidUtf8: true }, "is not UTF-8"],
])("rejects ownership %s", async (_name, options, error) => {
  await expect(recoverWorkflowOwnership(fixture(options).gh, base)).rejects.toThrow(error);
});

test.each([
  ["changed active file", { contents: { [defaultSha]: { [path]: "custom" } } }, generated, "was customized"],
  ["changed disabled file", { contents: { [defaultSha]: { [path]: "custom" } } }, { ...generated, files: {} }, "was customized"],
  ["adoption cannot override ownership", { contents: { [defaultSha]: { [path]: "custom" } } }, { ...generated, adoption: { [path]: digest("custom") } }, "was customized"],
  ["unowned existing file", { pulls: [] }, generated, "requires authenticated ownership or explicit first adoption"],
  ["stale adoption", { pulls: [] }, { ...generated, adoption: { [path]: digest("stale") } }, "workflow adoption digest is stale or file is absent"],
  ["absent adoption", { pulls: [], contents: { [defaultSha]: {} } }, { ...generated, adoption: { [path]: digest("old") } }, "workflow adoption digest is stale or file is absent"],
])("preserves %s", async (_name, options, selected, error) => {
  const f = fixture(options);
  await expect(inspectGeneratedWorkflows(f.gh, { ...base, generated: selected, additional: {} })).rejects.toThrow(error);
  expect(f.requests.filter(({ body }) => typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation"))).toEqual([]);
});

test.each(["active", "deletion"])("rejects additional producer collision with %s", async (kind) => {
  await expect(inspectGeneratedWorkflows(fixture().gh, { ...base, generated: kind === "active" ? generated : { ...generated, files: {} }, additional: { [path]: "new" } })).rejects.toThrow(`managed files contain duplicate producer destination "${path}"`);
});

test("unowned inactive standard paths remain available", async () => {
  const result = await inspectGeneratedWorkflows(fixture({ pulls: [] }).gh, { ...base, generated: { ...generated, files: {} }, additional: { [path]: "operator content" } });
  expect(result.deletions).toEqual([]);
});

test("first adoption uses the exact observed bytes and records only generated files", async () => {
  const f = fixture({ pulls: [] });
  const result = await inspectGeneratedWorkflows(f.gh, { ...base, generated: { ...generated, adoption: { [path]: digest("old") } }, additional: { "other.txt": "additional" } });
  expect(result.record).toEqual({ repositoryId: 123, release, files: { [path]: digest("new") } });
});

test("missing active caller is repaired; missing disabled caller needs no deletion", async () => {
  const f = fixture({ contents: { [defaultSha]: {} } });
  expect((await inspectGeneratedWorkflows(f.gh, { ...base, generated, additional: {} })).deletions).toEqual([]);
  expect((await inspectGeneratedWorkflows(f.gh, { ...base, generated: { ...generated, files: {} }, additional: {} })).deletions).toEqual([]);
});

test("newest merged record follows default ancestry even when PR numbers disagree", async () => {
  const f = fixture({ pulls: [pull(olderHead, olderMerge, 100), pull(originalHead, mergedSha, 1)], comparison: (ancestor, head) => head === olderMerge && ancestor === mergedSha ? olderHead : ancestor, messages: { [olderHead]: message({ ...record, files: { [mergePath]: digest("old merge") } }) }, contents: { [olderHead]: { [mergePath]: "old merge" } } });
  expect((await recoverWorkflowOwnership(f.gh, base)).record).toEqual(record);
});

test("newer malformed evidence cannot fall back to an older valid record or adoption", async () => {
  const f = fixture({ pulls: [pull(), pull(olderHead, olderMerge, 1)], messages: { [originalHead]: `Sync managed files\n\n${GENERATED_MARKER}\n{}` } });
  await expect(inspectGeneratedWorkflows(f.gh, { ...base, generated: { ...generated, adoption: { [path]: digest("old") } }, additional: {} })).rejects.toThrow("ownership record is malformed");
});

test("legacy newest record cannot revive earlier generation through adoption", async () => {
  const f = fixture({ pulls: [pull(), pull(olderHead, olderMerge, 1)], messages: { [originalHead]: "Sync managed files" } });
  await expect(inspectGeneratedWorkflows(f.gh, { ...base, generated: { ...generated, adoption: { [path]: digest("old") } }, additional: {} })).rejects.toThrow("requires authenticated ownership or explicit first adoption");
});

test("valid newest empty record permits re-adoption after verified removal", async () => {
  const f = fixture({ messages: { [originalHead]: message({ ...record, files: {} }) } });
  expect((await inspectGeneratedWorkflows(f.gh, { ...base, generated: { ...generated, adoption: { [path]: digest("old") } }, additional: {} })).record.files).toEqual({ [path]: digest("new") });
});

test.each([
  ["duplicate merge", [pull(), pull(olderHead, mergedSha, 2)], (ancestor: string) => ancestor, "ancestry is ambiguous"],
  ["divergent merge ancestry", [pull(), pull(olderHead, olderMerge, 2)], (ancestor: string, head: string) => head === defaultSha ? ancestor : "9".repeat(40), "ancestry is ambiguous"],
  ["incomplete ancestry", [pull()], () => undefined, "default ancestry evidence is incomplete"],
])("rejects %s", async (_name, pulls, comparison, error) => {
  await expect(recoverWorkflowOwnership(fixture({ pulls, comparison }).gh, base)).rejects.toThrow(error);
});

test("complete pagination rejects repeated pages", async () => {
  const pulls = Array.from({ length: 100 }, (_, index) => ({ ...pull(), number: index, merged_at: null }));
  await expect(recoverWorkflowOwnership(fixture({ pulls, duplicatePage: true }).gh, base)).rejects.toThrow("merged PR pagination is incomplete");
});

test.each([
  ["wrong creator", { user: { id: 1234 } }], ["wrong head repo", { head: { ...pull().head, repo: { id: 124 } } }], ["wrong base repo", { base: { ref: "trunk", repo: { id: 124 } } }], ["wrong branch", { head: { ...pull().head, ref: "custom" } }], ["unmerged", { merged_at: null }],
])("ignores unrelated merged candidate %s", async (_name, change) => {
  expect((await recoverWorkflowOwnership(fixture({ pulls: [{ ...pull(), ...change }] }).gh, base)).record).toBeNull();
});

test("pending metadata never grants deletion authority", async () => {
  const f = fixture({ pulls: [], pending: true });
  const input = { ...base, files: {}, generated: { ...generated, files: {} } };
  const result = await inspectManagedFiles(f.gh, input);
  expect(result.status).toBe("already-applied");
  expect(result.changedPaths).toEqual([]);
});

test("last caller deletion uses signed expected-head commit and preserves an unchanged repeat", async () => {
  const f = fixture();
  const input = { ...base, files: {}, generated: { ...generated, files: {} }, writeToken: "test", writeClient: f.gh };
  const result = await applyManagedFiles(f.gh, input);
  expect(result).toEqual({ status: "applied", commit: pendingSha, pullRequest: 90 });
  expect(f.contents()[pendingSha]).toEqual({});
  expect(parseOwnership(f.pendingMessage(), 123)?.files).toEqual({});
  const mutations = f.requests.filter(({ body }) => typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation"));
  expect(mutations).toHaveLength(1);
  expect(mutations[0]!.body).toMatchObject({ variables: { input: { expectedHeadOid: defaultSha, fileChanges: { additions: [], deletions: [{ path }] } } } });
  const repeated = fixture({ pending: true, contents: { [pendingSha]: {} }, headRecord: { ...record, files: {} } });
  expect(await applyManagedFiles(repeated.gh, { ...input, writeClient: repeated.gh })).toEqual({ status: "already-applied", commit: pendingSha, pullRequest: 90 });
  expect(repeated.requests.filter(({ body }) => typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation"))).toEqual([]);
});

test("pending full history still rejects removed additional paths", async () => {
  const f = fixture({ pending: true, pendingChanges: [path, "removed-additional.txt"] });
  await expect(inspectManagedFiles(f.gh, { ...base, files: {}, generated })).rejects.toThrow('managed files branch changed unmanaged path "removed-additional.txt"');
});

test("merged ownership ignores today's additional allowlist", async () => {
  const result = await inspectGeneratedWorkflows(fixture({ pendingChanges: [path, "old-additional.txt"] }).gh, { ...base, generated, additional: {} });
  expect(result.record.files).toEqual({ [path]: digest("new") });
});

test("concurrent default change fails before any privileged write", async () => {
  const f = fixture({ moveDefault: true });
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows state changed before managed file write");
  expect(f.requests.filter(({ pathname, body }) => pathname.endsWith("/git/refs") || (typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation")))).toEqual([]);
});

test.each([
  ["missing original head", { head: { ...pull().head, sha: "" } }],
  ["missing merge commit", { merge_commit_sha: null }],
])("rejects %s evidence", async (_name, changed) => {
  await expect(recoverWorkflowOwnership(fixture({ pulls: [{ ...pull(), ...changed }] }).gh, base)).rejects.toThrow("merged PR has unavailable immutable head evidence");
});

test("deleted original head never falls back to older history", async () => {
  const f = fixture({ pulls: [pull(), pull(olderHead, olderMerge, 1)], missingHead: true });
  await expect(recoverWorkflowOwnership(f.gh, base)).rejects.toThrow("original head unavailable");
  expect(f.requests.some(({ pathname }) => pathname.endsWith(`/commits/${olderHead}`))).toBe(false);
});

test("unsigned copied header and copied record on default do not establish ownership", async () => {
  const f = fixture({ pulls: [], contents: { [defaultSha]: { [path]: `# Generated by csm-ci from v1.2.3 (${release.sha}).\n${message(record)}` } } });
  await expect(inspectGeneratedWorkflows(f.gh, { ...base, generated, additional: {} })).rejects.toThrow("requires authenticated ownership or explicit first adoption");
});

test("an absent selected caller needs no adoption", async () => {
  const result = await inspectGeneratedWorkflows(fixture({ pulls: [], contents: { [defaultSha]: {} } }).gh, { ...base, generated, additional: {} });
  expect(result.record.files).toEqual({ [path]: digest("new") });
});

test("re-add after a verified deletion creates an absent caller", async () => {
  const f = fixture({ messages: { [originalHead]: message({ ...record, files: {} }) }, contents: { [defaultSha]: {}, [originalHead]: {} } });
  expect((await inspectGeneratedWorkflows(f.gh, { ...base, generated, additional: {} })).record.files).toEqual({ [path]: digest("new") });
});

test("pagination consumes complete historical pages before first adoption", async () => {
  const unrelated = Array.from({ length: 100 }, (_, number) => ({ ...pull(), number, merged_at: null }));
  const f = fixture({ pulls: unrelated });
  expect((await recoverWorkflowOwnership(f.gh, base)).record).toBeNull();
  expect(f.requests.filter(({ pathname }) => pathname.endsWith("/pulls"))).toHaveLength(2);
});

test("only default-reachable merged heads are eligible", async () => {
  const f = fixture({ comparison: () => "9".repeat(40) });
  expect((await recoverWorkflowOwnership(f.gh, base)).record).toBeNull();
});

test("matching-byte first adoption still establishes signed ownership", async () => {
  const f = fixture({ pulls: [], contents: { [defaultSha]: { [path]: "new" } } });
  const input = { ...base, files: {}, generated: { ...generated, adoption: { [path]: digest("new") } }, writeToken: "test", writeClient: f.gh };
  const result = await applyManagedFiles(f.gh, input);
  expect(result).toEqual({ status: "applied", commit: pendingSha, pullRequest: 90 });
  expect(parseOwnership(f.pendingMessage(), 123)?.files).toEqual({ [path]: digest("new") });
  expect(f.contents()[pendingSha]).toEqual({ [path]: "new" });
});

test.each([
  ["pending branch", { movePending: true }],
  ["pending PR binding", { pending: true, pendingPullNumberChanges: true }],
])("revalidates concurrent %s movement", async (_name, options) => {
  const f = fixture(options);
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows state changed before managed file write");
});

test("revalidates default again immediately before signed commit creation", async () => {
  const f = fixture({ moveDefaultAt: 4 });
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows default branch moved before commit creation");
  expect(f.requests.filter(({ body }) => typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" && body.query.startsWith("mutation"))).toEqual([]);
});

test("revalidates merged deletion proof again before signed commit creation", async () => {
  const f = fixture({ loseHistoryAt: 3 });
  await expect(applyManagedFiles(f.gh, { ...base, files: {}, generated: { ...generated, files: {} }, writeToken: "test", writeClient: f.gh })).rejects.toThrow("generated workflows ownership changed before commit creation");
});
