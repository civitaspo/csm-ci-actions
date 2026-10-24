import { Octokit as Core } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { type Config, parseConfig } from "./config.ts";
import { Rejection } from "./request.ts";

const Octokit = Core.plugin(restEndpointMethods, paginateRest);
export type GitHub = InstanceType<typeof Octokit>;

export function github(token: string, fetch?: typeof globalThis.fetch): GitHub {
  return new Octokit({ auth: token, userAgent: "csm-ci-actions", ...(fetch ? { request: { fetch } } : {}) });
}

export function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`${fullName} is not owner/repo`);
  return { owner, repo };
}

function status(e: unknown): number | undefined {
  return typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? e.status : undefined;
}

export async function loadConfig(gh: GitHub, repository: string, ref: string, path: string): Promise<Config> {
  const { data } = await gh.rest.repos.getContent({ ...splitRepository(repository), path, ref, mediaType: { format: "raw" } });
  if (typeof data !== "string") throw new Error(`${path} at ${repository}@${ref} is not a file`);
  return parseConfig(data);
}

// The label must still exist with the same description, so a deleted
// or edited label cannot be replayed by re-running or re-delivering the event.
export async function verifyLiveLabel(gh: GitHub, serverRepository: string, name: string, description: string): Promise<void> {
  let live: string | null;
  try {
    ({ data: { description: live } } = await gh.rest.issues.getLabel({ ...splitRepository(serverRepository), name }));
  } catch (e) {
    if (status(e) === 404) throw new Rejection(`label ${name} no longer exists`);
    throw e;
  }
  if ((live ?? "") !== description) throw new Rejection(`label ${name} description changed after the event`);
}
