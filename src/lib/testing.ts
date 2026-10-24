import { type Config, parseConfig } from "./config.ts";

export const SERVER_BOT_ID = 3000;
export const CLIENT_BOT_ID = 2000;
export const APPROVER_BOT_ID = 4000;

export const CONFIG_YAML = `
owners: [Owner]
server_repository: Owner/Server
apps: { client_bot_id: ${CLIENT_BOT_ID}, server_app_id: 1, server_bot_id: ${SERVER_BOT_ID} }
approver: { id: ${APPROVER_BOT_ID}, login: "approver[bot]" }
trust:
  committers: [{ id: 10, login: alice }, { id: 20, login: "renovate[bot]" }]
  approvers: [{ id: 10, login: alice }]
  mergers: [{ id: 10, login: alice }]
  bot_mergers: [{ id: 20, login: "renovate[bot]" }]
merge:
  required_checks: [{ name: status-check, app_id: 15368 }]
  deadline_minutes: 60
policies:
  - { type: signed-commits }
  - { type: trusted-committers }
repositories:
  - { name: owner/no-ops, ops: [] }
  - { name: owner/*, ops: [approve, policy-check] }
`;

export function config(): Config {
  return parseConfig(CONFIG_YAML);
}

// `then` answers the calls after the first one, in order, and repeats its last entry.
type Route = { method: string; path: string; status?: number; body: unknown; then?: unknown[] };

export function fakeFetch(routes: Route[]): typeof globalThis.fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    const route = routes.find((r) => r.method === method && r.path === url.pathname);
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    const seen = calls.filter((c) => c === `${method} ${url.pathname}`).length - 1;
    const answer = seen === 0 || !route.then?.length ? route.body : route.then[Math.min(seen, route.then.length) - 1];
    const body = typeof answer === "string" ? answer : JSON.stringify(answer);
    const type = typeof answer === "string" ? "text/plain" : "application/json";
    return new Response(body, { status: route.status ?? 200, headers: { "content-type": type } });
  };
  return Object.assign(fn, { calls }) as typeof globalThis.fetch & { calls: string[] };
}
