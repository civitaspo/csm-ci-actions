import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import picomatch from "picomatch";
import { z } from "zod";
import type { SecurefixRoute } from "./config.ts";
import { Rejection } from "./request.ts";
import { splitRepository } from "./github.ts";

export const SECUREFIX_ARTIFACT = "securefix";
export const MAX_SECUREFIX_FILES = 512;
export const MAX_SECUREFIX_FILE_SIZE = 8 * 1024 * 1024;
export const MAX_SECUREFIX_TOTAL_SIZE = 10 * 1024 * 1024;
export const MAX_SECUREFIX_MANIFEST_SIZE = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION_LINE = /^\s*"?version"?\s*[=:]/u;
const ManifestEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("write"), path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(SHA256) }),
  z.strictObject({ kind: z.literal("delete"), path: z.string() }),
]);
export const SecurefixManifestSchema = z.strictObject({
  version: z.literal(1),
  repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/).transform((value) => value.toLowerCase()),
  run_id: z.number().int().positive(),
  head_sha: z.string().regex(SHA),
  message: z.string().min(1).max(500),
  files: z.array(ManifestEntry),
});
export type SecurefixManifest = z.infer<typeof SecurefixManifestSchema>;
export type SecurefixChange =
  | { kind: "write"; path: string; content: Buffer }
  | { kind: "delete"; path: string };

const SECUREFIX_CLIENT_EVENTS = new Set(["pull_request", "push", "workflow_dispatch"]);

// Decides, before anything is packaged, whether this job may request securefix and which head the
// server must bind the run to. The server re-checks all of it (plan S1); this only fails early.
export function securefixClientContext(input: { eventName: string; event: unknown; repository: string; sha: string; serverRepository: string }): { headSha: string; server: { owner: string; repo: string } } {
  if (!SECUREFIX_CLIENT_EVENTS.has(input.eventName)) throw new Rejection(`securefix client runs only on pull_request, push or workflow_dispatch, not ${input.eventName}`);
  const server = (() => {
    try {
      return splitRepository(input.serverRepository);
    } catch {
      throw new Rejection(`server-repository ${JSON.stringify(input.serverRepository)} is not owner/repo`);
    }
  })();
  if (input.eventName !== "pull_request") return { headSha: input.sha, server };
  const pull = z.object({ pull_request: z.object({ head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/u), repo: z.object({ full_name: z.string() }).nullable() }) }) }).safeParse(input.event);
  if (!pull.success) throw new Rejection("securefix client could not read the pull request head from the event");
  if (pull.data.pull_request.head.repo?.full_name.toLowerCase() !== input.repository.toLowerCase()) throw new Rejection("securefix client does not accept pull requests from forks");
  return { headSha: pull.data.pull_request.head.sha, server };
}

export async function buildSecurefixArtifact(input: { workspace: string; repository: string; runId: number; headSha: string; message: string }): Promise<{ path: string; hasChanges: boolean }> {
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: input.workspace });
  const records = status.toString("utf8").split("\0").filter(Boolean);
  if (records.length > MAX_SECUREFIX_FILES) throw new Rejection(`securefix has more than ${MAX_SECUREFIX_FILES} changed files`);
  const changes: SecurefixChange[] = [];
  const entries: z.infer<typeof ManifestEntry>[] = [];
  let total = 0;
  for (const record of records) {
    const kind = record.slice(0, 2);
    const path = record.slice(3);
    validateSecurefixPath(path);
    if (kind.includes("U")) throw new Rejection(`securefix cannot package unresolved path ${JSON.stringify(path)}`);
    const index = execFileSync("git", ["ls-files", "--stage", "-z", "--", path], { cwd: input.workspace }).toString("utf8");
    const head = execFileSync("git", ["ls-tree", "-z", "HEAD", "--", path], { cwd: input.workspace }).toString("utf8");
    const modes = [index, head].flatMap((value) => value.split("\0").filter(Boolean).map((entry) => entry.split(" ", 1)[0]));
    if (modes.includes("160000")) throw new Rejection(`securefix does not allow submodule ${JSON.stringify(path)}`);
    if (modes.includes("120000")) throw new Rejection(`securefix does not allow symlink ${JSON.stringify(path)}`);
    if (kind.includes("D")) {
      entries.push({ kind: "delete", path });
      changes.push({ kind: "delete", path });
      continue;
    }
    await assertNoSymlinkParents(input.workspace, path);
    const absolutePath = join(input.workspace, path);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new Rejection(`securefix does not allow symlink ${JSON.stringify(path)}`);
    if (!info.isFile()) throw new Rejection(`securefix path ${JSON.stringify(path)} is not a regular file`);
    if (info.size > MAX_SECUREFIX_FILE_SIZE) throw new Rejection(`securefix file ${JSON.stringify(path)} is larger than 8MB`);
    const content = await readFile(absolutePath);
    total += content.byteLength;
    if (total > MAX_SECUREFIX_TOTAL_SIZE) throw new Rejection("securefix files are larger than 10MB in total");
    entries.push({ kind: "write", path, size: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") });
    changes.push({ kind: "write", path, content });
  }
  validateEntries(entries);
  if (total > MAX_SECUREFIX_TOTAL_SIZE) throw new Rejection("securefix files are larger than 10MB in total");
  if (changes.length === 0) return { path: "", hasChanges: false };
  const output = await mkdtemp(join(tmpdir(), `csm-ci-securefix-${input.runId}-`));
  await mkdir(join(output, "files"));
  for (const [index, change] of changes.entries()) {
    if (change.kind === "write") await writeFile(join(output, "files", String(index).padStart(4, "0")), change.content, { flag: "wx" });
  }
  await writeFile(join(output, "manifest.json"), JSON.stringify({
    version: 1,
    repository: input.repository.toLowerCase(),
    run_id: input.runId,
    head_sha: input.headSha,
    message: input.message,
    files: entries,
  } satisfies SecurefixManifest), { flag: "wx" });
  const manifestInfo = await lstat(join(output, "manifest.json"));
  if (manifestInfo.size > MAX_SECUREFIX_MANIFEST_SIZE) throw new Rejection("securefix manifest is larger than 1MB");
  return { path: output, hasChanges: true };
}

export const SecurefixRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  event: z.string(),
  head_branch: z.string(),
  head_sha: z.string(),
  path: z.string(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string() }),
  head_repository: z.object({ id: z.number().int().positive(), full_name: z.string() }).nullable(),
  pull_requests: z.array(z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    base: z.object({ ref: z.string(), sha: z.string() }),
  })),
});
export type SecurefixRun = z.infer<typeof SecurefixRunSchema>;

export function parseSecurefixManifest(value: unknown, expected: { repository: string; runId: number; headSha: string }): SecurefixManifest {
  const manifest = SecurefixManifestSchema.parse(value);
  if (manifest.repository !== expected.repository.toLowerCase()) throw new Rejection("securefix metadata repository does not match the workflow run");
  if (manifest.run_id !== expected.runId) throw new Rejection("securefix metadata run does not match the requested workflow run");
  if (manifest.head_sha !== expected.headSha) throw new Rejection("securefix metadata head does not match the workflow run");
  if (manifest.message.toLowerCase().includes("csm-ci-")) throw new Rejection("securefix commit message must not contain csm-ci-");
  validateEntries(manifest.files);
  return manifest;
}

export function validateEntries(files: readonly z.infer<typeof ManifestEntry>[]): void {
  if (files.length > MAX_SECUREFIX_FILES) throw new Rejection(`securefix has more than ${MAX_SECUREFIX_FILES} changed files`);
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    validateSecurefixPath(file.path);
    if (paths.has(file.path)) throw new Rejection(`securefix contains duplicate path ${JSON.stringify(file.path)}`);
    paths.add(file.path);
    if (file.kind === "write") {
      if (file.size > MAX_SECUREFIX_FILE_SIZE) throw new Rejection(`securefix file ${JSON.stringify(file.path)} is larger than 8MB`);
      total += file.size;
    }
  }
  if (total > MAX_SECUREFIX_TOTAL_SIZE) throw new Rejection("securefix files are larger than 10MB in total");
}

export function validateSecurefixPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Rejection(`securefix path ${JSON.stringify(path)} is absolute or contains a control character`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) throw new Rejection(`securefix path ${JSON.stringify(path)} contains ..`);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) throw new Rejection(`securefix path ${JSON.stringify(path)} contains a .git segment`);
  if (segments.some((segment) => segment === "" || segment === ".")) throw new Rejection(`securefix path ${JSON.stringify(path)} is not normalized`);
}

export async function readSecurefixArtifact(root: string, expected: { repository: string; runId: number; headSha: string }): Promise<{ manifest: SecurefixManifest; changes: SecurefixChange[] }> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Rejection("securefix artifact root is not a regular directory");
  const manifestPath = join(root, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_SECUREFIX_MANIFEST_SIZE) {
    throw new Rejection("securefix manifest is not a regular file under 1MB");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Rejection("securefix manifest is not valid JSON");
    throw error;
  }
  const manifest = parseSecurefixManifest(raw, expected);
  const actualFiles = await listRegularFiles(root);
  const expectedFiles = new Set(["manifest.json"]);
  const changes: SecurefixChange[] = [];
  let total = 0;
  for (const [index, entry] of manifest.files.entries()) {
    if (entry.kind === "delete") {
      changes.push(entry);
      continue;
    }
    const name = `files/${String(index).padStart(4, "0")}`;
    expectedFiles.add(name);
    const path = join(root, "files", String(index).padStart(4, "0"));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Rejection(`securefix payload for ${JSON.stringify(entry.path)} is not a regular file`);
    if (info.size !== entry.size) throw new Rejection(`securefix payload size does not match metadata for ${JSON.stringify(entry.path)}`);
    const content = await readFile(path);
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256) {
      throw new Rejection(`securefix payload digest does not match metadata for ${JSON.stringify(entry.path)}`);
    }
    total += content.byteLength;
    changes.push({ kind: "write", path: entry.path, content });
  }
  if (total > MAX_SECUREFIX_TOTAL_SIZE) throw new Rejection("securefix payloads are larger than 10MB in total");
  if (actualFiles.some((path) => !expectedFiles.has(path)) || [...expectedFiles].some((path) => !actualFiles.includes(path))) {
    throw new Rejection("securefix artifact contains files that are not listed in its manifest");
  }
  return { manifest, changes };
}

async function assertNoSymlinkParents(root: string, path: string): Promise<void> {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = join(root, ...parts.slice(0, i));
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Rejection(`securefix path ${JSON.stringify(path)} has an unsafe parent directory`);
  }
}

async function listRegularFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Rejection(`securefix artifact contains symlink ${JSON.stringify(path)}`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Rejection(`securefix artifact contains unsupported entry ${JSON.stringify(path)}`);
  }
  return files;
}

export function validateSecurefixRun(run: SecurefixRun, expectedRunId: number, repository: string): void {
  if (run.id !== expectedRunId) throw new Rejection("workflow run id does not match the request");
  if (run.run_attempt !== 1) throw new Rejection(`workflow run attempt is ${run.run_attempt}; retries are not accepted`);
  if (!SHA.test(run.head_sha)) throw new Rejection("workflow run has an invalid head sha");
  if (run.repository.full_name.toLowerCase() !== repository.toLowerCase() || run.head_repository?.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Rejection("securefix workflow run is not from the same repository");
  }
  if (run.event === "pull_request_target") throw new Rejection("securefix rejects pull_request_target runs");
  if (run.event === "pull_request" && run.pull_requests.length !== 1) throw new Rejection("securefix PR run must map to exactly one pull request");
  if (run.event === "pull_request" && run.pull_requests[0]?.head.ref !== run.head_branch) {
    throw new Rejection("securefix workflow branch does not match the pull request head");
  }
  if (run.event !== "pull_request" && run.event !== "push" && run.event !== "workflow_dispatch") {
    throw new Rejection(`securefix does not accept ${run.event} events`);
  }
}

export function bindSecurefixPullRequest(run: SecurefixRun, defaultBranch: string, pull: {
  number: number; state: string; draft?: boolean; base: { ref: string; sha: string }; head: { ref: string; sha: string; repo: { full_name: string } | null };
}, openPullsFromHead: number, repository: string): void {
  const listed = run.pull_requests[0];
  if (run.event !== "pull_request" || !listed) throw new Rejection("securefix PR mode requires a pull_request workflow run");
  if (listed.number !== pull.number || pull.state !== "open" || pull.draft === true) throw new Rejection("securefix workflow is not bound to an open, ready pull request");
  if (pull.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()) throw new Rejection("securefix does not accept fork pull requests");
  if (pull.head.ref !== run.head_branch) throw new Rejection("securefix PR head branch does not match the workflow run");
  if (pull.base.ref !== defaultBranch || listed.base.ref !== defaultBranch) throw new Rejection("securefix PR must target the default branch");
  if (openPullsFromHead !== 1) throw new Rejection("securefix PR head has more than one open pull request");
}

export function findSecurefixRoute(routes: readonly SecurefixRoute[], run: SecurefixRun, defaultBranch: string): SecurefixRoute {
  const workflowPath = run.path.split("@", 1)[0];
  const matches = routes.filter((route) => workflowPath === route.workflow);
  if (matches.length !== 1) throw new Rejection("workflow run does not match exactly one securefix route");
  const route = matches[0];
  if (!route) throw new Rejection("workflow run does not match exactly one securefix route");
  const from = route.from === "default" ? defaultBranch : route.from;
  if (run.event !== "push" && run.event !== "workflow_dispatch") throw new Rejection("securefix route requires push or workflow_dispatch");
  if (run.head_branch !== from) throw new Rejection(`securefix route expected branch ${from}, got ${run.head_branch}`);
  return route;
}

export function validateSecurefixRouteHead(run: SecurefixRun, route: SecurefixRoute, defaultBranch: string, currentDefaultSha: string): void {
  const from = route.from === "default" ? defaultBranch : route.from;
  if (run.head_branch !== from || run.head_sha !== currentDefaultSha) throw new Rejection("securefix route head is not the current head of its source branch");
}

export function validateRouteChanges(route: SecurefixRoute, changes: readonly SecurefixChange[], original: ReadonlyMap<string, Buffer | null>): void {
  for (const change of changes) {
    validateSecurefixPath(change.path);
    const rule = Object.entries(route.paths).find(([pattern]) => picomatch.isMatch(change.path, pattern, { dot: true }))?.[1];
    if (!rule) throw new Rejection(`securefix route does not allow path ${JSON.stringify(change.path)}`);
    if (rule === "semver") {
      if (change.kind !== "write" || change.path !== ".release-version" || !isSemver(change.content.toString("utf8").trim())) {
        throw new Rejection(".release-version must contain a semantic version");
      }
    }
    if (rule === "version-only") {
      if (change.kind !== "write") throw new Rejection(`securefix route requires a version line change for ${JSON.stringify(change.path)}`);
      const before = original.get(change.path);
      if (before === undefined || before === null) throw new Rejection(`securefix route cannot find the original file ${JSON.stringify(change.path)}`);
      if (!versionLinesOnly(before.toString("utf8"), change.content.toString("utf8"))) {
        throw new Rejection(`securefix route allows only version lines in ${JSON.stringify(change.path)}`);
      }
    }
  }
}

export function validateSecurefixRouteCommitFile(
  route: SecurefixRoute,
  file: { filename: string; status: string; previous_filename?: string },
  before: Buffer | null,
  after: Buffer | null,
): void {
  if (file.status === "removed") {
    validateRouteChanges(route, [{ kind: "delete", path: file.filename }], new Map());
    return;
  }
  if (file.status === "renamed") {
    const previous = file.previous_filename;
    if (!previous) throw new Rejection("securefix route rename has no previous filename");
    validateRouteChanges(route, [{ kind: "delete", path: previous }], new Map());
  }
  if (!after) throw new Rejection(`securefix route commit has no content for ${JSON.stringify(file.filename)}`);
  validateRouteChanges(route, [{ kind: "write", path: file.filename, content: after }], new Map([[file.filename, before]]));
}

function versionLinesOnly(before: string, after: string): boolean {
  const nonVersionLines = (text: string) => text.split("\n").filter((line) => !VERSION_LINE.test(line));
  return JSON.stringify(nonVersionLines(before)) === JSON.stringify(nonVersionLines(after));
}

function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.test(value);
}
