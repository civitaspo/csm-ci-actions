import { z } from "zod";
import { type GitHub, splitRepository } from "./github.ts";
import { type ReservationPayload } from "./automerge.ts";

const BRANCH = "csm-ci/automerge";
const ATTEMPTS = 3;
const DISPLAY_IDENTITY = "csm-ci:automerge-display:v1";
const Sha = z.string().regex(/^[0-9a-f]{40}$/u);
const Commit = z.object({
  oid: Sha,
  messageHeadline: z.string(),
  messageBody: z.string(),
  changedFilesIfAvailable: z.number().nullable(),
  parents: z.object({ nodes: z.array(z.object({ oid: Sha })) }),
  author: z.object({ user: z.object({ databaseId: z.number().int().positive() }).nullable() }).nullable(),
  signature: z.object({ isValid: z.boolean(), wasSignedByGitHub: z.boolean() }).nullable(),
});

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

async function readHead(server: GitHub, repository: string): Promise<string | undefined> {
  try {
    const result = await server.rest.git.getRef({ ...splitRepository(repository), ref: `heads/${BRANCH}` });
    return Sha.parse(result.data.object.sha);
  } catch (error) {
    if (status(error) === 404) return undefined;
    throw error;
  }
}

async function readCommit(server: GitHub, repository: string, oid: string): Promise<z.infer<typeof Commit>> {
  const { owner, repo } = splitRepository(repository);
  const response: unknown = await server.graphql("query($owner:String!,$repo:String!,$oid:GitObjectID!){repository(owner:$owner,name:$repo){object(oid:$oid){... on Commit{oid messageHeadline messageBody changedFilesIfAvailable parents(first:2){nodes{oid}} author{user{databaseId}} signature{isValid wasSignedByGitHub}}}}}", { owner, repo, oid });
  return z.object({ repository: z.object({ object: Commit }) }).parse(response).repository.object;
}

function owned(commit: z.infer<typeof Commit>, serverBotId: number): boolean {
  return commit.author?.user?.databaseId === serverBotId && commit.signature?.isValid === true && commit.signature.wasSignedByGitHub && commit.changedFilesIfAvailable === 0 && commit.parents.nodes.length === 1 && /^csm-ci: automerge [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u.test(commit.messageHeadline) && commit.messageBody.startsWith(`${DISPLAY_IDENTITY}\n`);
}

export async function createAutomergeDisplayCommit(args: { server: GitHub; serverRepository: string; defaultBranch: string; serverBotId: number; payload: ReservationPayload }): Promise<string> {
  const { server, serverRepository, payload } = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(payload.repository)) throw new Error("display commit repository name is invalid");
  const headline = `csm-ci: automerge ${payload.repository}#${payload.pull_number}`;
  if (headline.length > 255) throw new Error("display commit subject is too long");
  const body = `${DISPLAY_IDENTITY}\nrepository_id=${payload.repository_id}\ncommand_comment_id=${payload.command_comment_id}`;
  let head = await readHead(server, serverRepository);
  let bootstrapped = false;
  if (!head) {
    const base = await server.rest.git.getRef({ ...splitRepository(serverRepository), ref: `heads/${args.defaultBranch}` });
    const baseSha = Sha.parse(base.data.object.sha);
    try {
      await server.rest.git.createRef({ ...splitRepository(serverRepository), ref: `refs/heads/${BRANCH}`, sha: baseSha });
      head = baseSha;
      bootstrapped = true;
    } catch (error) {
      if (status(error) !== 422) throw error;
      head = await readHead(server, serverRepository);
      if (!head) throw error;
    }
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (!bootstrapped) {
      const prior = await readCommit(server, serverRepository, head);
      if (prior.oid !== head) throw new Error("display branch tip is not an owned display commit");
      if (!owned(prior, args.serverBotId)) {
        const comparison = await server.rest.repos.compareCommitsWithBasehead({ ...splitRepository(serverRepository), basehead: `${head}...${args.defaultBranch}` });
        if (comparison.data.status !== "ahead" && comparison.data.status !== "identical") throw new Error("display branch tip is not an owned display commit");
      }
    }
    let oid: string;
    try {
      const response: unknown = await server.graphql("mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}", { input: { branch: { repositoryNameWithOwner: serverRepository, branchName: BRANCH }, expectedHeadOid: head, message: { headline, body }, fileChanges: { additions: [] } } });
      oid = z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: Sha }) }) }).parse(response).createCommitOnBranch.commit.oid;
    } catch (error) {
      const current = await readHead(server, serverRepository);
      if (!current || current === head || attempt + 1 === ATTEMPTS) throw error;
      head = current;
      bootstrapped = false;
      continue;
    }
    const commit = await readCommit(server, serverRepository, oid);
    if (!owned(commit, args.serverBotId) || commit.oid !== oid || commit.parents.nodes[0]?.oid !== head || commit.messageHeadline !== headline) throw new Error("display commit verification failed");
    return oid;
  }
  throw new Error(`display commit CAS retries exhausted after ${ATTEMPTS} attempts`);
}
