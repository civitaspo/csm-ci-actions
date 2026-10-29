import { z } from "zod";
import { type DeploymentStatus, ReservationPayloadSchema, type ReservationPayload, reservationState, truncateDeploymentDescription } from "./automerge.ts";
import { type GitHub, isNetworkFailure, splitRepository } from "./github.ts";

const ENVIRONMENT = "csm-ci-automerge";
const TASK = "csm-ci:automerge";
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

const Creator = z.object({ __typename: z.string(), databaseId: z.number().int().positive().optional() }).nullable();
const DeploymentNode = z.object({
  id: z.string().min(1), databaseId: z.number().int().positive(), task: z.string(), payload: z.unknown(),
  createdAt: z.iso.datetime(), creator: Creator,
});
const DeploymentPage = z.object({ repository: z.object({ deployments: z.object({ nodes: z.array(DeploymentNode), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }) });
const RestStatus = z.object({
  id: z.number().int().positive(), state: z.string(), description: z.string().nullable(), created_at: z.iso.datetime(),
  log_url: z.string().optional(), environment_url: z.string().optional(),
  creator: z.object({ id: z.number().int().positive(), type: z.string() }).nullable(),
});
const CreatedDeployment = z.object({ id: z.number().int().positive(), node_id: z.string().min(1), task: z.string(), created_at: z.iso.datetime(), creator: z.object({ id: z.number().int().positive(), type: z.string() }).nullable() });

export type ReservationRecord = {
  deploymentId: number;
  nodeId: string;
  createdAt: string;
  payload: ReservationPayload;
  statuses: DeploymentStatus[];
  state: ReturnType<typeof reservationState>;
};

type ListArgs = { server: GitHub; serverRepository: string; serverBotId: number; now: Date; limit?: number };
type CreateArgs = { server: GitHub; serverRepository: string; defaultBranch: string; serverBotId: number; payload: ReservationPayload };

const DEPLOYMENTS_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){deployments(environments:["${ENVIRONMENT}"],first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{id databaseId task payload createdAt creator{__typename ... on Bot{databaseId}}}}}}`;

export async function listReservations(args: ListArgs): Promise<ReservationRecord[]> {
  const { owner, repo } = splitRepository(args.serverRepository);
  const cutoff = args.now.getTime() - LOOKBACK_MS;
  const nodes: z.infer<typeof DeploymentNode>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response: unknown = await args.server.graphql(DEPLOYMENTS_QUERY, { owner, name: repo, cursor });
    const page = DeploymentPage.parse(response).repository.deployments;
    for (const node of page.nodes) {
      if (Date.parse(node.createdAt) < cutoff) return withStatuses(args, nodes);
      nodes.push(node);
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("GitHub returned a repeated deployment cursor");
    seen.add(cursor);
  } while (true);
  return withStatuses(args, nodes);
}

export async function findReservationsForPull(args: ListArgs & { repositoryId: number; pullNumber: number }): Promise<ReservationRecord[]> {
  const { repositoryId, pullNumber, ...listArgs } = args;
  return (await listReservations(listArgs)).filter((r) => r.payload.repository_id === repositoryId && r.payload.pull_number === pullNumber);
}

export async function createReservation(args: CreateArgs): Promise<ReservationRecord> {
  const find = () => findReservationsForPull({ server: args.server, serverRepository: args.serverRepository, serverBotId: args.serverBotId, repositoryId: args.payload.repository_id, pullNumber: args.payload.pull_number, now: new Date() });
  const existing = await find();
  const replay = existing.find((r) => r.payload.command_comment_id === args.payload.command_comment_id);
  if (replay) return replay;
  const { owner, repo } = splitRepository(args.serverRepository);
  try {
    const { data } = await args.server.rest.repos.createDeployment({ owner, repo, ref: args.defaultBranch, task: TASK, environment: ENVIRONMENT, auto_merge: false, required_contexts: [], production_environment: false, transient_environment: false, description: `${args.payload.repository}#${args.payload.pull_number}`, payload: args.payload });
    const created = CreatedDeployment.parse(data);
    if (created.task !== TASK || created.creator?.type !== "Bot" || created.creator.id !== args.serverBotId) throw new Error("created deployment identity does not match csm-ci automerge");
    return { deploymentId: created.id, nodeId: created.node_id, createdAt: created.created_at, payload: args.payload, statuses: [], state: { kind: "active" } };
  } catch (error) {
    if (!ambiguousWrite(error)) throw error;
    const created = (await find()).find((r) => r.payload.command_comment_id === args.payload.command_comment_id);
    if (created) return created;
    throw error;
  }
}

export async function createReservationStatus(args: { server: GitHub; serverRepository: string; serverBotId: number; deploymentId: number; serverRunUrl: string; pullUrl: string; state: DeploymentStatus["state"]; description: string }): Promise<void> {
  const { owner, repo } = splitRepository(args.serverRepository);
  const body = { owner, repo, deployment_id: args.deploymentId, state: args.state, description: truncateDeploymentDescription(args.description), log_url: args.serverRunUrl, environment_url: args.pullUrl, auto_inactive: false };
  try {
    await args.server.rest.repos.createDeploymentStatus(body);
  } catch (error) {
    if (!ambiguousWrite(error)) throw error;
    const raw: unknown[] = await args.server.paginate(args.server.rest.repos.listDeploymentStatuses, { owner, repo, deployment_id: args.deploymentId, per_page: 100 });
    if (raw.some((value) => {
      const status = RestStatus.safeParse(value);
      return status.success && status.data.state === args.state && status.data.description === body.description && status.data.creator?.type === "Bot" && status.data.creator.id === args.serverBotId && status.data.log_url === body.log_url && status.data.environment_url === body.environment_url;
    })) return;
    throw error;
  }
}

async function withStatuses(args: ListArgs, nodes: readonly z.infer<typeof DeploymentNode>[]): Promise<ReservationRecord[]> {
  const records: ReservationRecord[] = [];
  for (const node of nodes) {
    if (node.task !== TASK || node.creator?.__typename !== "Bot" || node.creator.databaseId !== args.serverBotId) continue;
    const payload = ReservationPayloadSchema.safeParse(node.payload);
    if (!payload.success) { console.warn(`ignoring automerge deployment ${node.databaseId} with invalid payload`); continue; }
    records.push({ deploymentId: node.databaseId, nodeId: node.id, createdAt: node.createdAt, payload: payload.data, statuses: [], state: { kind: "active" } });
  }
  const selected = args.limit === undefined ? records : records.slice(0, args.limit);
  const { owner, repo } = splitRepository(args.serverRepository);
  for (const record of selected) {
    const raw: unknown[] = await args.server.paginate(args.server.rest.repos.listDeploymentStatuses, { owner, repo, deployment_id: record.deploymentId, per_page: 100 });
    record.statuses = raw.flatMap((value) => {
      const parsed = RestStatus.safeParse(value);
      return parsed.success ? [mapStatus(parsed.data)] : [];
    });
    record.state = reservationState({ statuses: record.statuses, serverBotId: args.serverBotId });
  }
  return selected;
}

function mapStatus(s: z.infer<typeof RestStatus>): DeploymentStatus {
  const state: DeploymentStatus["state"] = s.state === "queued" ? "queued" : s.state === "success" ? "success" : s.state === "failure" ? "failure" : s.state === "inactive" ? "inactive" : "error";
  const creator = s.creator?.type === "Bot" ? { type: "Bot" as const, databaseId: s.creator.id } : { type: "Other" as const };
  return { id: s.id, state, description: s.description, createdAt: s.created_at, creator };
}

function ambiguousWrite(error: unknown): boolean {
  if (isNetworkFailure(error) || error instanceof Error && error.name === "TimeoutError") return true;
  return typeof error === "object" && error !== null && "status" in error && (error.status === 502 || error.status === 503 || error.status === 504);
}

export { ENVIRONMENT as AUTOMERGE_ENVIRONMENT, TASK as AUTOMERGE_TASK };
