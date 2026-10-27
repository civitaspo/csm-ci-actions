import { expect, test } from "bun:test";
import { parse } from "yaml";
import { github } from "./github.ts";
import { resolveWorkflowRelease, validateWorkflowContract } from "./workflow-release.ts";
import { STANDARD_CALLERS } from "./generated-workflows.ts";
import { fakeFetch } from "./testing.ts";

const sha = "a".repeat(40);
const tag = "b".repeat(40);
const metadata = { id: 10, tag_name: "v1.2.3", draft: false, prerelease: false, published_at: "2026-10-26T01:00:00Z" };
const read = async (path: string) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();
const lock = parse(await read(".github/workflows/actions.lock"));
const fixture = () => ({ on: { workflow_call: { secrets: { CSM_CI_CLIENT_APP_PRIVATE_KEY: { required: true } }, inputs: {} } }, permissions: {}, jobs: { request: { permissions: {}, steps: [{ uses: "$/actions/client/approve" }] } } });

test("every real client workflow and defining composite satisfies the generated caller contract", async () => {
  for (const caller of ["approve", "policy-check", "merge", "release", "release-pr"] as const) await validateWorkflowContract(parse(await read(`.github/workflows/${STANDARD_CALLERS[caller]}`)), caller, lock, read);
});

test.each([
  ["missing declaration", { on: { workflow_call: { secrets: {} } } }, "Required"],
  ["optional client secret", { on: { workflow_call: { secrets: { CSM_CI_CLIENT_APP_PRIVATE_KEY: { required: false } } } } }, "required Client App Secret declaration is missing"],
  ["additional required credential", { on: { workflow_call: { secrets: { CSM_CI_CLIENT_APP_PRIVATE_KEY: { required: true }, OTHER: { required: true } } } } }, "additional required credentials are unsupported"],
  ["required unknown input", { on: { workflow_call: { ...fixture().on.workflow_call, inputs: { other: { type: "string", required: true } } } } }, "unsupported required input other"],
  ["workflow write permissions", { permissions: { contents: "write" } }, "workflow permissions exceed caller permissions"],
  ["workflow read permissions", { permissions: { contents: "read" } }, "workflow permissions exceed caller permissions"],
  ["job write permissions", { jobs: { request: { permissions: { contents: "write" }, steps: [] } } }, "workflow permissions exceed caller permissions"],
  ["nested reusable", { jobs: { request: { uses: "other/workflow" } } }, "nested reusable workflows are unsupported"],
  ["unsupported local path", { jobs: { request: { steps: [{ uses: "$/../../action" }] } } }, "unsupported defining local composite path"],
  ["unlocked dependency", { jobs: { request: { steps: [{ uses: `owner/action@${sha}` }] } } }, "not supported by the defining action-lock"],
] satisfies [string, object, string][]) ("rejects %s", async (_name, changed, message) => {
  const operation = validateWorkflowContract({ ...fixture(), ...changed }, "approve", lock, read);
  if (message === "Required") await expect(operation).rejects.toThrow();
  else await expect(operation).rejects.toThrow(message);
});

test.each([
  ["missing version", { "version-files": { type: "string", default: "" } }, "expected record"],
  ["wrong version type", { version: { type: "number", default: "" }, "version-files": { type: "string", default: "" } }, "input version has an incompatible"],
  ["wrong version default", { version: { type: "string", default: "1.0.0" }, "version-files": { type: "string", default: "" } }, "input version has an incompatible"],
  ["required version", { version: { type: "string", default: "", required: true }, "version-files": { type: "string", default: "" } }, "input version has an incompatible"],
  ["missing version files", { version: { type: "string", default: "" } }, "expected record"],
  ["wrong version files type", { version: { type: "string", default: "" }, "version-files": { type: "boolean", default: "" } }, "input version-files has an incompatible"],
  ["wrong version files default", { version: { type: "string", default: "" }, "version-files": { type: "string", default: "[]" } }, "input version-files has an incompatible"],
  ["required version files", { version: { type: "string", default: "" }, "version-files": { type: "string", default: "", required: true } }, "input version-files has an incompatible"],
] satisfies [string, object, string][]) ("rejects preparation %s", async (_name, inputs, message) => {
  await expect(validateWorkflowContract({ ...fixture(), on: { workflow_call: { ...fixture().on.workflow_call, inputs } } }, "release-pr", lock, read)).rejects.toThrow(message);
});

test.each([
  ["leading zero", { ...metadata, tag_name: "v01.2.3" }], ["empty build identifier", { ...metadata, tag_name: "v1.2.3+a..b" }], ["trailing build identifier", { ...metadata, tag_name: "v1.2.3+a." }], ["draft", { ...metadata, draft: true }], ["prerelease", { ...metadata, prerelease: true }], ["prerelease tag", { ...metadata, tag_name: "v1.2.3-rc.1" }], ["missing tag", { ...metadata, tag_name: null }], ["unpublished", { ...metadata, published_at: null }], ["missing id", { ...metadata, id: 0 }], ["invalid date", { ...metadata, published_at: "today" }],
])("rejects %s release metadata", async (_name, body) => {
  const fetch = fakeFetch([{ method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body }]);
  await expect(resolveWorkflowRelease(github("test", fetch), [])).rejects.toThrow("standard workflows require valid published stable release metadata");
  expect(fetch.calls).toHaveLength(1);
});

test.each([
  ["short SHA", { type: "commit", sha: "abc123" }], ["tree", { type: "tree", sha }], ["blob", { type: "blob", sha }], ["missing object", {}],
])("rejects %s tag target", async (_name, target) => {
  const fetch = fakeFetch([{ method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: metadata }, { method: "GET", path: "/repos/civitaspo/csm-ci-actions/git/ref/tags%2Fv1.2.3", body: { object: target } }]);
  await expect(resolveWorkflowRelease(github("test", fetch), [])).rejects.toThrow("standard workflows release tag must resolve to a full commit SHA");
});

test.each([404, 403, 500])("propagates release lookup failure %s without fallback", async (status) => {
  const fetch = fakeFetch([{ method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", status, body: { message: "release lookup failed" } }]);
  await expect(resolveWorkflowRelease(github("test", fetch), [])).rejects.toThrow("release lookup failed");
  expect(fetch.calls).toEqual(["GET /repos/civitaspo/csm-ci-actions/releases/latest"]);
});

test("dereferences annotated tags and resolves only the selected latest release", async () => {
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: metadata, then: [{ ...metadata, tag_name: "v9.9.9" }] },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: tag } } },
    { method: "GET", path: `/repos/civitaspo/csm-ci-actions/git/tags/${tag}`, body: { object: { type: "commit", sha } } },
  ]);
  expect(await resolveWorkflowRelease(github("test", fetch), [])).toEqual({ version: "v1.2.3", sha });
  expect(fetch.calls).toHaveLength(3);
});

test.each(["cycle", "depth"])("rejects annotated tag %s", async (kind) => {
  const tags = Array.from({ length: 9 }, (_, n) => n.toString().repeat(40));
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: metadata },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/git/ref/tags%2Fv1.2.3", body: { object: { type: "tag", sha: tags[0] } } },
    ...tags.slice(0, 8).map((value, index) => ({ method: "GET", path: `/repos/civitaspo/csm-ci-actions/git/tags/${value}`, body: { object: { type: "tag", sha: kind === "cycle" ? tags[0] : tags[index + 1] } } })),
  ]);
  await expect(resolveWorkflowRelease(github("test", fetch), [])).rejects.toThrow(kind === "cycle" ? "standard workflows release tag chain contains a cycle" : "standard workflows release tag chain exceeds eight tags");
});

test.each([
  ["version", { ...lock, version: "v0.0.1" }, "unsupported defining action-lock version"],
  ["empty dependencies", { ...lock, workflows: { ".github/workflows/client-approve.yml": [] } }, "not supported by the defining action-lock"],
  ["wrong commit", { ...lock, dependencies: Object.fromEntries(Object.entries(lock.dependencies).map(([name, info]) => [name, { ...Object(info), commit: `sha1-${sha}` }])) }, "invalid defining action-lock metadata"],
])("rejects lock %s", async (_name, changed, message) => {
  await expect(validateWorkflowContract(fixture(), "approve", changed, read)).rejects.toThrow(message);
});

test("one released SHA supplies the union of callers and every defining file", async () => {
  const paths = [".github/workflows/actions.lock", ...Object.values(STANDARD_CALLERS).map((file) => `.github/workflows/${file}`), ...["approve", "policy-check", "merge", "release-publish", "release-prepare"].map((name) => `actions/client/${name}/action.yml`)];
  const fileRoutes = await Promise.all(paths.map(async (path) => ({ method: "GET", path: `/repos/civitaspo/csm-ci-actions/contents/${encodeURIComponent(path)}`, body: { type: "file", encoding: "base64", content: Buffer.from(await read(path)).toString("base64") } })));
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: metadata, then: [{ ...metadata, tag_name: "v9.9.9" }] },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/git/ref/tags%2Fv1.2.3", body: { object: { type: "commit", sha } } },
    ...fileRoutes,
  ]);
  expect(await resolveWorkflowRelease(github("test", fetch), ["approve", "policy-check", "merge", "release", "release-pr", "approve"])).toEqual({ version: "v1.2.3", sha });
  expect(fetch.calls.filter((call) => call.endsWith("/releases/latest"))).toHaveLength(1);
  expect(fetch.calls.filter((call) => call.endsWith("%2Fclient-approve.yml"))).toHaveLength(1);
});

test.each([
  ["missing workflow", undefined, 404, "Not Found"],
  ["not a file", { type: "dir" }, 200, "not a regular base64 file"],
  ["bad encoding", { type: "file", encoding: "utf8", content: "" }, 200, "not a regular base64 file"],
  ["bad base64", { type: "file", encoding: "base64", content: "%%%" }, 200, "malformed base64"],
  ["invalid UTF8", { type: "file", encoding: "base64", content: Buffer.from([255]).toString("base64") }, 200, "UTF-8"],
])("fails closed for released %s", async (_name, body, status, message) => {
  const fetch = fakeFetch([
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/releases/latest", body: metadata },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/git/ref/tags%2Fv1.2.3", body: { object: { type: "commit", sha } } },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/contents/.github%2Fworkflows%2Factions.lock", body: { type: "file", encoding: "base64", content: Buffer.from(await read(".github/workflows/actions.lock")).toString("base64") } },
    { method: "GET", path: "/repos/civitaspo/csm-ci-actions/contents/.github%2Fworkflows%2Fclient-approve.yml", body: body ?? { message: "Not Found" }, status },
  ]);
  await expect(resolveWorkflowRelease(github("test", fetch), ["approve"])).rejects.toThrow(message);
});
