import { Octokit as Core } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { type Config, parseConfig } from "./config.ts";
import { Rejection, buildLabel } from "./request.ts";

const Octokit = Core.plugin(restEndpointMethods, paginateRest);
export type GitHub = InstanceType<typeof Octokit>;

type RetryOptions = { timeoutMs?: number; backoffMs?: number[] };

export function github(token: string, fetch?: typeof globalThis.fetch, retryOptions: RetryOptions = {}): GitHub {
  const octokit = new Octokit({ auth: token, userAgent: "csm-ci-actions", ...(fetch ? { request: { fetch } } : {}) });
  const timeoutMs = retryOptions.timeoutMs ?? 30_000;
  const backoffMs = retryOptions.backoffMs ?? [250, 1_000];
  const usage = trackRateLimit();
  octokit.hook.wrap("request", async (request, options) => {
    const endpoint = octokit.request.endpoint.parse(options);
    const retryable = isReadOnly(endpoint.method, endpoint.url, endpoint.body);
    const originalRequest = options.request;
    const callerSignal = originalRequest.signal;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(callerSignal?.reason);
      if (callerSignal?.aborted) abortFromCaller();
      else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("GitHub request timed out", "TimeoutError"));
      }, timeoutMs);
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
        options.request = { ...originalRequest, signal: controller.signal };
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
        });
        const call = request(options);
        const result = await Promise.race([call, aborted]);
        usage.record(result.headers);
        return result;
      } catch (error) {
        usage.record(responseHeaders(error));
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abortFromCaller);
        if (callerSignal?.aborted || !retryable || attempt >= backoffMs.length || !isRetryableError(error, timedOut)) throw error;
        await delay(backoffMs[attempt], undefined, callerSignal ? { signal: callerSignal } : {});
      } finally {
        options.request = originalRequest;
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abortFromCaller);
      }
    }
  });
  return octokit;
}

// Each client logs its request count and last observed rate-limit headers when the process exits.
// Clients sharing a token share one bucket, so compare used/reset across lines to attribute consumption.
type RateLimitUsage = { requests: number; headers: Record<string, string> };
const usages: RateLimitUsage[] = [];

function trackRateLimit(): { record: (headers: unknown) => void } {
  const usage: RateLimitUsage = { requests: 0, headers: {} };
  if (usages.length === 0) process.once("exit", () => { for (const line of rateLimitLines(usages)) console.log(line); });
  usages.push(usage);
  return {
    record: (headers) => {
      usage.requests++;
      if (typeof headers !== "object" || headers === null) return;
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase().startsWith("x-ratelimit-") && value !== undefined) usage.headers[key.toLowerCase().slice("x-ratelimit-".length)] = String(value);
      }
    },
  };
}

export function rateLimitLines(list: readonly RateLimitUsage[]): string[] {
  return list.flatMap((u, i) => {
    if (u.requests === 0) return [];
    const h = u.headers;
    const reset = h.reset && /^\d+$/.test(h.reset) ? new Date(Number(h.reset) * 1000).toISOString() : "unknown";
    return [`rate-limit: client=${i + 1} requests=${u.requests} resource=${h.resource ?? "unknown"} used=${h.used ?? "unknown"} remaining=${h.remaining ?? "unknown"} limit=${h.limit ?? "unknown"} reset=${reset}`];
  });
}

function responseHeaders(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined;
  const response = error.response;
  return typeof response === "object" && response !== null && "headers" in response ? response.headers : undefined;
}

function isReadOnly(method: string, url: string, body: unknown): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST" || !url.endsWith("/graphql")) return false;
  const query = typeof body === "object" && body !== null && "query" in body && typeof body.query === "string" ? body.query : null;
  if (query === null) return false;
  if (/\b(?:mutation|subscription)\b/i.test(query)) return false;
  const operations = query.match(/\bquery\b/gi)?.length ?? 0;
  return /^\s*\{/i.test(query) ? operations === 0 : /^\s*query\b/i.test(query) && operations === 1;
}

function isRetryableError(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (typeof error !== "object" || error === null) return false;
  if ("status" in error && (error.status === 502 || error.status === 503 || error.status === 504)) return true;
  return isNetworkFailure(error);
}

export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null || !("cause" in error)) return false;
  const cause = error.cause;
  return cause instanceof TypeError || (cause instanceof Error && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].some((code) => cause.message.includes(code)));
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

export async function loadCurrentServerConfig(gh: GitHub, repository: string, path: string): Promise<Config> {
  const { data: server } = await gh.rest.repos.get(splitRepository(repository));
  const config = await loadConfig(gh, repository, server.default_branch, path);
  if (config.server_repository !== repository.toLowerCase()) {
    throw new Error(`current server configuration identifies ${config.server_repository}, not ${repository}`);
  }
  return config;
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
import { setTimeout as delay } from "node:timers/promises";

// Creates the request label in the server repository with a Client App token.
// e2e correlates client runs with server runs by this exact line.
export function requestLogLine(label: { name: string; description: string }, server: string): string {
  return `created label ${label.name} (${label.description}) in ${server}`;
}

export async function createRequestLabel(gh: GitHub, server: string, kind: string, repository: string, numbers: readonly (string | number)[]): Promise<{ name: string; description: string }> {
  const label = buildLabel(kind, repository, numbers);
  await gh.rest.issues.createLabel({ ...splitRepository(server), ...label, color: "1f6feb" });
  return label;
}
