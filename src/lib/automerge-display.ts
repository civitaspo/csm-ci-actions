import { z } from "zod";
import { getReservation, type ReservationRecord } from "./automerge-github.ts";
import { type GitHub, splitRepository } from "./github.ts";

const ENVIRONMENT = "csm-ci-automerge-display";
const TASK = "csm-ci:automerge-display";
const Payload = z.object({ server_repository: z.string(), reservation_deployment_id: z.number().int().positive() });
const Deployment = z.object({ id: z.number().int().positive(), sha: z.string().regex(/^[0-9a-f]{40}$/u), task: z.string(), environment: z.string(), created_at: z.iso.datetime(), payload: z.unknown(), creator: z.object({ id: z.number().int().positive(), type: z.string() }).nullable() });
const Status = z.object({ id: z.number().int().positive(), state: z.string(), log_url: z.string().nullable(), environment_url: z.string().nullable(), creator: z.object({ id: z.number().int().positive(), type: z.string() }).nullable() });

type Args = { server: GitHub; reader: GitHub; client: GitHub; serverRepository: string; repository: string; serverBotId: number; record: ReservationRecord; runUrl: string; now: Date };

function parsePayload(value: unknown): z.infer<typeof Payload> | undefined {
  try {
    let decoded = value;
    for (let depth = 0; depth < 2 && typeof decoded === "string"; depth++) decoded = JSON.parse(decoded) as unknown;
    const parsed = Payload.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function displayState(record: ReservationRecord, serverBotId: number): "queued" | "success" | "inactive" | "error" {
  if (record.state.kind === "terminal") return record.state.state === "success" ? "success" : "inactive";
  const latest = record.statuses.filter((status) => status.creator.type === "Bot" && status.creator.databaseId === serverBotId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)[0];
  return latest?.state === "error" ? "error" : "queued";
}

async function current(args: Args): Promise<{ record: ReservationRecord; head: string }> {
  const { record } = args;
  const latest = await getReservation({ server: args.server, serverRepository: args.serverRepository, serverBotId: args.serverBotId, record });
  const { data: pull } = await args.reader.rest.pulls.get({ ...splitRepository(args.repository), pull_number: record.payload.pull_number });
  if (Number(pull.base.repo?.id) !== record.payload.repository_id || pull.node_id !== record.payload.pull_node_id) throw new Error("display pull request identity changed");
  return { record: latest, head: z.string().regex(/^[0-9a-f]{40}$/u).parse(pull.head.sha) };
}

async function candidates(args: Args, head: string): Promise<z.infer<typeof Deployment>[]> {
  const raw: unknown[] = [];
  for (const sha of [head, undefined]) {
    for (let page = 1; page <= 3; page++) {
      const response = await args.client.rest.repos.listDeployments({ ...splitRepository(args.repository), environment: ENVIRONMENT, ...(sha ? { sha } : {}), per_page: 100, page });
      raw.push(...response.data);
      if (!sha && response.data.some((deployment) => Date.parse(z.iso.datetime().parse(deployment.created_at)) < Date.parse(args.record.createdAt))) break;
      if (response.data.length < 100) break;
      if (page === 3) throw new Error(sha ? "display head lookup exceeded its page limit" : "display history lookup exceeded its page limit");
    }
  }
  const seen = new Set<number>();
  return raw.flatMap((value) => {
    const parsed = Deployment.safeParse(value);
    if (!parsed.success) return [];
    const deployment = parsed.data;
    const payload = parsePayload(deployment.payload);
    if (seen.has(deployment.id)) return [];
    seen.add(deployment.id);
    return deployment.environment === ENVIRONMENT && deployment.task === TASK && deployment.creator?.type === "Bot" && deployment.creator.id === args.serverBotId && payload?.server_repository === args.serverRepository && payload.reservation_deployment_id === args.record.deploymentId ? [deployment] : [];
  }).sort((a, b) => a.id - b.id);
}

export async function reconcileAutomergeDisplay(args: Args): Promise<number | undefined> {
  let observed = await current(args);
  let deployments = await candidates(args, observed.head);
  let matching = deployments.filter((deployment) => deployment.sha === observed.head);
  if (!matching.length) {
    observed = await current(args);
    try {
      await args.client.rest.repos.createDeployment({ ...splitRepository(args.repository), ref: observed.head, task: TASK, environment: ENVIRONMENT, auto_merge: false, required_contexts: [], transient_environment: false, production_environment: false, payload: { server_repository: args.serverRepository, reservation_deployment_id: args.record.deploymentId } });
    } catch (error) {
      deployments = await candidates(args, observed.head);
      if (!deployments.some((deployment) => deployment.sha === observed.head)) throw error;
    }
    deployments = await candidates(args, observed.head);
    matching = deployments.filter((deployment) => deployment.sha === observed.head);
    if (!matching.length) throw new Error("created client display is not yet observable");
  }
  const canonical = matching[0];
  for (const deployment of deployments) {
    observed = await current(args);
    const desired = deployment.id === canonical?.id && deployment.sha === observed.head ? displayState(observed.record, args.serverBotId) : "inactive";
    const statuses: unknown[] = await args.client.paginate(args.client.rest.repos.listDeploymentStatuses, { ...splitRepository(args.repository), deployment_id: deployment.id, per_page: 100 });
    const trusted = statuses.map((value) => Status.safeParse(value)).flatMap((result) => result.success && result.data.creator?.type === "Bot" && result.data.creator.id === args.serverBotId ? [result.data] : []).sort((a, b) => b.id - a.id);
    if (trusted[0]?.state === desired) continue;
    observed = await current(args);
    if (observed.head !== canonical?.sha) throw new Error("display head changed during reconciliation");
    const finalState = deployment.id === canonical?.id && deployment.sha === observed.head ? displayState(observed.record, args.serverBotId) : "inactive";
    try {
      await args.client.rest.repos.createDeploymentStatus({ ...splitRepository(args.repository), deployment_id: deployment.id, state: finalState, log_url: args.runUrl, environment_url: args.runUrl, auto_inactive: false });
    } catch (error) {
      const after: unknown[] = await args.client.paginate(args.client.rest.repos.listDeploymentStatuses, { ...splitRepository(args.repository), deployment_id: deployment.id, per_page: 100 });
      const latest = after.map((value) => Status.safeParse(value)).flatMap((status) => status.success && status.data.creator?.type === "Bot" && status.data.creator.id === args.serverBotId ? [status.data] : []).sort((a, b) => b.id - a.id)[0];
      if (latest?.state !== finalState || latest.log_url !== args.runUrl || latest.environment_url !== args.runUrl) throw error;
    }
  }
  if ((await current(args)).head !== canonical?.sha) throw new Error("display head changed during reconciliation");
  return canonical?.id;
}

export async function syncAutomergeDisplay(args: Omit<Args, "client"> & { client?: GitHub }): Promise<{ kind: "synced"; deploymentId?: number } | { kind: "unavailable"; reason: string }> {
  if (!args.client) return { kind: "unavailable", reason: "client deployment token unavailable" };
  try {
    const deploymentId = await reconcileAutomergeDisplay({ ...args, client: args.client });
    return deploymentId ? { kind: "synced", deploymentId } : { kind: "synced" };
  } catch (error) {
    const safeMessages = ["display reservation no longer exists", "display pull request identity changed", "display head lookup exceeded its page limit", "display history lookup exceeded its page limit", "created client display is not yet observable", "display head changed during reconciliation"];
    const message = error instanceof Error ? error.message : "";
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
    return { kind: "unavailable", reason: safeMessages.includes(message) ? message : status ? `GitHub request failed (HTTP ${status})` : "GitHub request or response failed" };
  }
}
