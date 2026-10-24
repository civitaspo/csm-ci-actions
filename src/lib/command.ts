import type { Principal } from "./config.ts";
import { Rejection } from "./request.ts";

export type Command = { name: "approve" } | { name: "recheck" };

export const COMMAND_TTL_MS = 60 * 60_000;
export function parseCommand(body: string): Command | undefined {
  const text = body.trim();
  if (text === "/approve") return { name: "approve" };
  if (text === "/recheck") return { name: "recheck" };
  return undefined;
}

export type CommentFacts = {
  id: number;
  body: string;
  issueUrl: string;
  createdAt: string;
  updatedAt: string;
  user: { id: number; login: string; type: string } | null;
};

// Plan S5. The command comes from the comment itself, never from the label. /recheck only
// re-evaluates the current state, so it skips the freshness checks.
export function validateComment(c: CommentFacts, repository: string, pullNumber: number, now: Date): Command {
  if (!c.issueUrl.toLowerCase().endsWith(`/repos/${repository.toLowerCase()}/issues/${pullNumber}`)) {
    throw new Rejection(`comment ${c.id} is not on ${repository}#${pullNumber}`);
  }
  const command = parseCommand(c.body);
  if (!command) throw new Rejection(`comment ${c.id} is not exactly /approve or /recheck`);
  if (command.name === "recheck") return command;
  if (c.createdAt !== c.updatedAt) throw new Rejection(`comment ${c.id} was edited after it was posted`);
  const age = now.getTime() - new Date(c.createdAt).getTime();
  if (!(age >= 0 && age <= COMMAND_TTL_MS)) throw new Rejection(`comment ${c.id} is older than 60 minutes`);
  return command;
}

export function requirePrincipal(user: CommentFacts["user"], allowed: readonly Principal[], role: string): Principal {
  const match = user && user.type === "User" ? allowed.find((p) => p.id === user.id) : undefined;
  if (!match) throw new Rejection(`${user?.login ?? "a deleted user"} is not one of the ${role}`);
  return match;
}

export type PullFacts = {
  number: number;
  state: string;
  draft: boolean;
  headSha: string;
  headRepository: string | null;
  baseRepository: string;
  baseRef: string;
  defaultBranch: string;
  authorId: number;
};

export function checkPullState(p: PullFacts): void {
  if (p.state !== "open") throw new Rejection(`#${p.number} is ${p.state}`);
  if (p.draft) throw new Rejection(`#${p.number} is a draft`);
  if (p.headRepository?.toLowerCase() !== p.baseRepository.toLowerCase()) throw new Rejection(`#${p.number} comes from a fork`);
  if (p.baseRef !== p.defaultBranch) throw new Rejection(`#${p.number} targets ${p.baseRef}, not the default branch ${p.defaultBranch}`);
}
