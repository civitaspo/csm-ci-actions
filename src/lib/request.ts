import { randomBytes } from "node:crypto";
import { z } from "zod";
import { type Config, type Op, repositoryEntry } from "./config.ts";

// A label is only a locator (plan S1): the kind is the op that runs and the numbers say what to
// re-read from the API. A second number is the comment id of a command such as /approve or /merge.
export const REQUEST_KINDS = {
  approve: [["pull_number"], ["pull_number", "comment_id"]],
  merge: [["pull_number", "comment_id"]],
  "policy-check": [["pull_number"], ["pull_number", "comment_id"]],
  securefix: [["run_id"]],
  release: [["pull_number"]],
} as const satisfies Record<Op, readonly (readonly string[])[]>;

export type Kind = keyof typeof REQUEST_KINDS;
type ArgsOf<K extends Kind> = (typeof REQUEST_KINDS)[K][number] extends infer F
  ? F extends readonly string[]
    ? { [A in F[number]]: number }
    : never
  : never;
export type Request = {
  [K in Kind]: { kind: K; repository: string; label: string; args: ArgsOf<K> };
}[Kind];

export class Rejection extends Error {
  override name = "Rejection";
}

const LABEL_PREFIX = "csm-ci-";
const MAX_LABEL_NAME = 50;
const MAX_LABEL_DESCRIPTION = 100;
const KINDS = Object.keys(REQUEST_KINDS) as Kind[];
const LABEL_NAME = new RegExp(`^${LABEL_PREFIX}(${KINDS.join("|")})-([a-z0-9]+)$`);
const DESCRIPTION = /^([a-z0-9-]+\/[a-z0-9._-]+)((?:\/[^/]+)+)$/;
const NUMBER = /^[1-9][0-9]{0,15}$/;

function isKind(s: string): s is Kind {
  return Object.hasOwn(REQUEST_KINDS, s);
}

export function parseLabel(name: string, description: string): Request {
  if (name.length > MAX_LABEL_NAME) throw new Rejection(`label name is longer than ${MAX_LABEL_NAME} characters`);
  const nameMatch = LABEL_NAME.exec(name);
  const kind = nameMatch?.[1];
  if (kind === undefined || !isKind(kind)) throw new Rejection(`label name ${JSON.stringify(name)} is not a csm-ci request`);

  const match = DESCRIPTION.exec(description.toLowerCase());
  if (!match?.[1] || !match[2]) throw new Rejection(`label description ${JSON.stringify(description)} is not owner/repo/<numbers>`);
  const parts = match[2].slice(1).split("/");
  const forms: readonly (readonly string[])[] = REQUEST_KINDS[kind];
  const names = forms.find((f) => f.length === parts.length);
  if (!names) throw new Rejection(`${kind} expects ${forms.map((f) => f.length).join(" or ")} number(s) after owner/repo, got ${parts.length}`);
  const args: Record<string, number> = {};
  names.forEach((argName, i) => {
    const part = parts[i] ?? "";
    if (!NUMBER.test(part) || !Number.isSafeInteger(Number(part))) {
      throw new Rejection(`${argName} ${JSON.stringify(part)} is not a positive safe integer without leading zeros`);
    }
    args[argName] = Number(part);
  });
  return { kind, repository: match[1], label: name, args } as Request;
}

export const LabelEventSchema = z.object({
  action: z.string(),
  repository: z.object({ id: z.number(), full_name: z.string() }),
  label: z.object({ name: z.string(), description: z.string().nullable() }),
  sender: z.object({ id: z.number(), type: z.string() }),
});
export type LabelEvent = z.infer<typeof LabelEventSchema>;

export function validateIntake(event: LabelEvent, env: { repositoryId: number; runAttempt: number }, config: Config): Request {
  if (event.action !== "created") throw new Rejection(`label event action is ${event.action}, not created`);
  if (env.runAttempt !== 1) throw new Rejection(`server run attempt is ${env.runAttempt}; re-runs are not accepted`);
  if (event.repository.id !== env.repositoryId || event.repository.full_name.toLowerCase() !== config.server_repository) {
    throw new Rejection(`event repository ${event.repository.full_name} is not the server repository ${config.server_repository}`);
  }
  if (event.sender.id !== config.apps.client_bot_id || event.sender.type !== "Bot") {
    throw new Rejection(`label sender ${event.sender.id} (${event.sender.type}) is not the client app bot`);
  }
  const request = parseLabel(event.label.name, event.label.description ?? "");
  const entry = repositoryEntry(config, request.repository);
  if (!entry) throw new Rejection(`repository ${request.repository} is not managed by this server`);
  if (!entry.ops.includes(request.kind)) throw new Rejection(`repository ${request.repository} does not enable ${request.kind}`);
  return request;
}

// Keyed by kind as well, so a waiting /merge never blocks /approve or policy-check on the same pull request.
export function concurrencyKey(request: Request): string {
  const n = "pull_number" in request.args ? request.args.pull_number : request.args.run_id;
  return `${request.kind}-${request.repository}#${n}`;
}

// Validated by round-tripping through parseLabel, so client and server share one rule set.
export function buildLabel(
  kind: string,
  repository: string,
  numbers: readonly (string | number)[],
  suffix: string = randomBytes(8).toString("hex"),
): { name: string; description: string } {
  const name = `${LABEL_PREFIX}${kind}-${suffix}`;
  const description = [repository.toLowerCase(), ...numbers].join("/");
  if (description.length > MAX_LABEL_DESCRIPTION) {
    throw new Rejection(`label description ${description} is longer than ${MAX_LABEL_DESCRIPTION} characters; the repository name is too long`);
  }
  parseLabel(name, description);
  return { name, description };
}
