import { parse } from "yaml";
import { z } from "zod";
import { type GitHub } from "./github.ts";
import { Rejection } from "./request.ts";
import { ReleasedRevision, STANDARD_CALLERS, type Caller } from "./generated-workflows.ts";

const address = { owner: "civitaspo", repo: "csm-ci-actions" };
const shaPattern = /^[a-f0-9]{40}$/u;
const ReleaseMetadata = z.object({ tag_name: ReleasedRevision.shape.version, draft: z.literal(false), prerelease: z.literal(false), published_at: z.string().datetime(), id: z.number().int().positive() });
const ObjectReference = z.object({ type: z.enum(["commit", "tag"]), sha: z.string().regex(shaPattern) });
const RecordValue = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> { return RecordValue.parse(value); }

export async function resolveWorkflowRelease(gh: GitHub, callers: readonly Caller[]): Promise<ReleasedRevision> {
  const { data } = await gh.rest.repos.getLatestRelease(address);
  const release = ReleaseMetadata.safeParse(data);
  if (!release.success) throw new Rejection("standard workflows require valid published stable release metadata");
  const { data: ref } = await gh.rest.git.getRef({ ...address, ref: `tags/${release.data.tag_name}` });
  let target = ObjectReference.safeParse(ref.object);
  const seen = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (!target.success) throw new Rejection("standard workflows release tag must resolve to a full commit SHA");
    if (target.data.type === "commit") break;
    if (depth >= 8) throw new Rejection("standard workflows release tag chain exceeds eight tags");
    if (seen.has(target.data.sha)) throw new Rejection("standard workflows release tag chain contains a cycle");
    seen.add(target.data.sha);
    const { data: tag } = await gh.rest.git.getTag({ ...address, tag_sha: target.data.sha });
    target = ObjectReference.safeParse(tag.object);
  }
  if (!target.success) throw new Rejection("standard workflows release tag must resolve to a full commit SHA");
  const revision = ReleasedRevision.parse({ version: release.data.tag_name, sha: target.data.sha });
  const read = (path: string) => readReleasedFile(gh, path, revision.sha);
  if (callers.length > 0) {
    const lock = parse(await read(".github/workflows/actions.lock"));
    for (const caller of new Set(callers)) {
      const path = `.github/workflows/${STANDARD_CALLERS[caller]}`;
      try {
        await validateWorkflowContract(parse(await read(path)), caller, lock, read);
      } catch (error) {
        throw new Rejection(`released workflow ${path} is incompatible: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return revision;
}

async function readReleasedFile(gh: GitHub, path: string, sha: string): Promise<string> {
  const { data } = await gh.rest.repos.getContent({ ...address, path, ref: sha });
  if (Array.isArray(data) || !("content" in data) || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") throw new Rejection(`released file ${path} is not a regular base64 file`);
  const encoded = data.content.replaceAll("\n", "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Rejection(`released file ${path} has malformed base64`);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Rejection(`released file ${path} is not UTF-8`); }
}

export async function validateWorkflowContract(value: unknown, caller: Caller, lockValue: unknown, read: (path: string) => Promise<string>): Promise<void> {
  const workflow = object(value);
  const call = object(object(workflow.on).workflow_call);
  const secrets = object(call.secrets);
  if (object(secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY).required !== true) throw new Error("required Client App Secret declaration is missing");
  for (const [name, declaration] of Object.entries(secrets)) {
    if (name !== "CSM_CI_CLIENT_APP_PRIVATE_KEY" && object(declaration).required === true) throw new Error("additional required credentials are unsupported");
  }
  const inputs = call.inputs === undefined ? {} : object(call.inputs);
  const expected: Record<string, { type: string; default: string | boolean }> = caller === "release-pr" ? { version: { type: "string", default: "" }, "version-files": { type: "string", default: "" } } : {};
  for (const [name, required] of Object.entries(expected)) {
    const declaration = object(inputs[name]);
    if (declaration.type !== required.type || declaration.default !== required.default || declaration.required === true) throw new Error(`input ${name} has an incompatible type, default, or requirement`);
  }
  for (const [name, declaration] of Object.entries(inputs)) {
    if (!Object.hasOwn(expected, name) && object(declaration).required === true) throw new Error(`unsupported required input ${name}`);
  }
  const checkPermissions = (value: unknown) => {
    for (const [name, permission] of Object.entries(object(value ?? {}))) {
      if (caller !== "release-pr" || name !== "contents" || permission !== "read") throw new Error("workflow permissions exceed caller permissions");
    }
  };
  checkPermissions(workflow.permissions);
  const lock = object(lockValue);
  if (lock.version !== "v0.0.3") throw new Error("unsupported defining action-lock version");
  const workflowPath = `.github/workflows/${STANDARD_CALLERS[caller]}`;
  const locked = z.array(z.string()).parse(object(lock.workflows)[workflowPath]);
  const dependencies = object(lock.dependencies);
  const seen = new Set<string>();
  const visit = async (steps: unknown) => {
    for (const stepValue of z.array(z.unknown()).parse(steps)) {
      const step = object(stepValue);
      if (step.uses === undefined) continue;
      const uses = z.string().parse(step.uses);
      if (uses.startsWith("$/")) {
        const local = uses.slice(2);
        if (!/^actions\/client\/[a-z-]+$/u.test(local)) throw new Error("unsupported defining local composite path");
        if (seen.has(local)) throw new Error("defining local composite cycle");
        seen.add(local);
        const action = object(parse(await read(`${local}/action.yml`)));
        const runs = object(action.runs);
        if (runs.using !== "composite") throw new Error("defining local action is not composite");
        await visit(runs.steps);
        seen.delete(local);
      } else {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u.test(uses) || !locked.includes(uses)) throw new Error(`dependency ${uses} is not supported by the defining action-lock`);
        const dependency = object(dependencies[uses]);
        if (dependency.commit !== `sha1-${uses.split("@")[1]}` || typeof dependency.owner_id !== "number" || typeof dependency.repo_id !== "number") throw new Error(`dependency ${uses} has invalid defining action-lock metadata`);
      }
    }
  };
  for (const jobValue of Object.values(object(workflow.jobs))) {
    const job = object(jobValue);
    checkPermissions(job.permissions);
    if (job.uses !== undefined) throw new Error("nested reusable workflows are unsupported");
    await visit(job.steps);
  }
}
