import { z } from "zod";
import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { createRequestLabel, github, requestLogLine } from "./github.ts";

export type ClientOperation = "approve" | "merge" | "policy-check" | "release-publish";
export type RequestKind = "approve" | "merge" | "policy-check" | "release";

type RequestArgs =
  | { kind: "approve"; numbers: readonly [number] | readonly [number, number] }
  | { kind: "merge"; numbers: readonly [number, number] }
  | { kind: "policy-check"; numbers: readonly [number] | readonly [number, number] }
  | { kind: "release"; numbers: readonly [number] };

export type ClientRequest =
  | { status: "skip"; reason: string }
  | { status: "send"; request: RequestArgs; server: { owner: string; name: string } };

const pullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }).passthrough(),
}).passthrough();

const commentEvent = z.object({
  action: z.string(),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }).passthrough(),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    author_association: z.string(),
  }).passthrough(),
}).passthrough();

const botMergeIdentity = z.object({
  issue: z.object({ user: z.object({ id: z.number().int().positive() }) }),
  comment: z.object({ user: z.object({ id: z.number().int().positive(), type: z.literal("Bot") }) }),
});

const releaseEvent = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string(), default_branch: z.string() }).passthrough(),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }).passthrough(),
    base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }).passthrough(),
  }).passthrough(),
}).passthrough();

const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const POLICY_CHECK_ACTIONS = new Set([...PULL_REQUEST_ACTIONS, "edited"]);
const COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function skip(reason: string): ClientRequest {
  return { status: "skip", reason };
}

function splitRepository(serverRepository: string): { owner: string; name: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(serverRepository);
  const owner = match?.[1];
  const name = match?.[2];
  return owner && name ? { owner, name } : undefined;
}

export function prepareClientRequest(
  operation: ClientOperation,
  eventName: string,
  event: unknown,
  serverRepository: string,
): ClientRequest {
  const server = splitRepository(serverRepository);
  if (!server) throw new Error("server-repository must be owner/repo");

  if (operation === "approve" || operation === "policy-check") {
    if (eventName === "pull_request_target") {
      const parsed = pullRequestEvent.safeParse(event);
      if (!parsed.success) return skip("event payload is not a pull request event");
      const allowed = operation === "approve" ? PULL_REQUEST_ACTIONS : POLICY_CHECK_ACTIONS;
      if (!allowed.has(parsed.data.action)) return skip(`pull request action ${parsed.data.action} is not handled`);
      return {
        status: "send",
        request: { kind: operation, numbers: [parsed.data.pull_request.number] },
        server,
      };
    }
    if (operation === "approve" && eventName === "issue_comment") {
      const parsed = commentEvent.safeParse(event);
      if (!parsed.success) return skip("event payload is not an issue comment");
      if (parsed.data.action !== "created") return skip(`comment action ${parsed.data.action} is not handled`);
      if (!parsed.data.issue.pull_request) return skip("comment is not on a pull request");
      if (!COMMENT_ASSOCIATIONS.has(parsed.data.comment.author_association)) {
        return skip(`comment author association ${parsed.data.comment.author_association} is not allowed`);
      }
      if (parsed.data.comment.body !== "/recheck" && parsed.data.comment.body !== "/approve") {
        return skip("comment body is not exactly /approve or /recheck");
      }
      return {
        status: "send",
        request: { kind: "approve", numbers: [parsed.data.issue.number, parsed.data.comment.id] },
        server,
      };
    }
    return skip(`event ${eventName} is not handled`);
  }

  if (operation === "merge") {
    if (eventName !== "issue_comment") return skip(`event ${eventName} is not handled`);
    const parsed = commentEvent.safeParse(event);
    if (!parsed.success) return skip("event payload is not an issue comment");
    if (parsed.data.action !== "created") return skip(`comment action ${parsed.data.action} is not handled`);
    if (!parsed.data.issue.pull_request) return skip("comment is not on a pull request");
    if (!COMMENT_ASSOCIATIONS.has(parsed.data.comment.author_association)) {
      const identity = botMergeIdentity.safeParse(event);
      if (!identity.success || identity.data.comment.user.id !== identity.data.issue.user.id) {
        return skip(`comment author association ${parsed.data.comment.author_association} is not allowed`);
      }
    }
    if (parsed.data.comment.body !== "/merge") return skip("comment body is not exactly /merge");
    return {
      status: "send",
      request: { kind: "merge", numbers: [parsed.data.issue.number, parsed.data.comment.id] },
      server,
    };
  }

  if (eventName !== "pull_request") return skip(`event ${eventName} is not handled`);
  const parsed = releaseEvent.safeParse(event);
  if (!parsed.success) return skip("event payload is not a pull request event");
  const pull = parsed.data.pull_request;
  const repository = parsed.data.repository;
  if (parsed.data.action !== "closed") return skip(`pull request action ${parsed.data.action} is not handled`);
  if (!pull.merged) return skip("pull request was not merged");
  if (pull.head.ref !== "release/next") return skip("pull request head is not release/next");
  if (pull.head.repo?.full_name !== repository.full_name) return skip("pull request head repository is not this repository");
  if (pull.base.repo?.full_name !== repository.full_name) return skip("pull request base repository is not this repository");
  if (pull.base.ref !== repository.default_branch) return skip("pull request base is not the default branch");
  return { status: "send", request: { kind: "release", numbers: [pull.number] }, server };
}

export function parsePreparedNumbers(operation: ClientOperation, value: string): number[] {
  const parts = value.split("/");
  const validCount = operation === "merge" ? parts.length === 2 : parts.length === 1 || (operation !== "release-publish" && parts.length === 2);
  if (!validCount || parts.some((part) => !/^[1-9][0-9]{0,15}$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    throw new Error(`prepared request arguments are invalid for ${operation}`);
  }
  return parts.map(Number);
}

export function requestKind(operation: ClientOperation): RequestKind {
  return operation === "release-publish" ? "release" : operation;
}

export async function prepareClientRequestAction(operation: ClientOperation): Promise<void> {
  const request = prepareClientRequest(
    operation,
    requiredEnv("GITHUB_EVENT_NAME"),
    JSON.parse(await readFile(requiredEnv("GITHUB_EVENT_PATH"), "utf8")),
    core.getInput("server_repository", { required: true }),
  );
  if (request.status === "skip") {
    core.notice(request.reason);
    core.setOutput("should-send", "false");
    return;
  }
  core.setOutput("should-send", "true");
  core.setOutput("server-owner", request.server.owner);
  core.setOutput("server-name", request.server.name);
  core.setOutput("request-args", request.request.numbers.join("/"));
}

export async function sendClientRequestAction(operation: ClientOperation): Promise<void> {
  const server = core.getInput("server_repository", { required: true });
  const numbers = parsePreparedNumbers(operation, core.getInput("request_args", { required: true }));
  const label = await createRequestLabel(
    github(core.getInput("token", { required: true })),
    server,
    requestKind(operation),
    requiredEnv("GITHUB_REPOSITORY"),
    numbers,
  );
  core.setOutput("label", label.name);
  core.info(requestLogLine(label, server));
}

export function runClientRequestAction(operation: ClientOperation): void {
  const stage = process.env.CSM_CI_CLIENT_STAGE;
  const run = stage === "prepare"
    ? prepareClientRequestAction(operation)
    : stage === "request"
      ? sendClientRequestAction(operation)
      : Promise.reject(new Error(`unknown client stage ${stage}`));
  run.catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
