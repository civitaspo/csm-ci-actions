import type { Config, Principal } from "./config.ts";
import { type GitHub, splitRepository } from "./github.ts";

// GitHub caps pulls.listCommits at 250, so a PR at the cap may hide commits.
export const MAX_COMMITS = 250;
const WEB_FLOW = "web-flow";

type Account = { id: number; login: string };

export type CommitFacts = {
  sha: string;
  verified: boolean;
  author: Account | null;
  committer: Account | null;
  // Present only for commits whose committer is web-flow.
  web?: { committedViaWeb: boolean; signatureValid: boolean; signedByGitHub: boolean; authorLogin: string | null };
};

export type Identity = { kind: "user"; principal: Account } | { kind: "server" } | { kind: "unknown"; reason: string };

export type CommitVerdict = { sha: string; signed: boolean; identity: Identity; trusted: boolean };

export type TrustResult = { head: string; commits: CommitVerdict[]; problems: string[] };

function identityOf(c: CommitFacts, config: Config): Identity {
  // Without a verified signature, the GitHub account is inferred from an email anyone can set.
  if (!c.verified) return { kind: "unknown", reason: "commit is not signed, so its author cannot be verified" };
  if (c.committer?.login !== WEB_FLOW) {
    const who = c.committer ?? c.author;
    return who ? { kind: "user", principal: who } : { kind: "unknown", reason: "commit has neither a GitHub committer nor a GitHub author" };
  }
  const web = c.web;
  if (!web?.signedByGitHub || !web.signatureValid) return { kind: "unknown", reason: "web-flow commit is not signed by GitHub" };
  if (!c.author) return { kind: "unknown", reason: "web-flow commit has no GitHub author" };
  if (c.author.id === config.apps.server_bot_id) return { kind: "server" };
  if (!web.committedViaWeb) return { kind: "unknown", reason: "web-flow commit was not committed via the web" };
  if (web.authorLogin !== c.author.login) return { kind: "unknown", reason: "web-flow commit author differs between REST and GraphQL" };
  return { kind: "user", principal: c.author };
}

function isTrusted(identity: Identity, committers: readonly Principal[]): boolean {
  if (identity.kind === "server") return true;
  if (identity.kind === "unknown") return false;
  return committers.some((p) => p.id === identity.principal.id);
}

export function evaluateTrust(commits: readonly CommitFacts[], head: string, config: Config): TrustResult {
  const problems: string[] = [];
  if (commits.length === 0) problems.push("pull request has no commits");
  if (commits.length >= MAX_COMMITS) problems.push(`pull request has ${MAX_COMMITS} or more commits; GitHub cannot list them all`);
  const last = commits.at(-1);
  if (last && last.sha !== head) problems.push(`last listed commit ${last.sha} is not the pinned head ${head}`);
  const verdicts = commits.map((c): CommitVerdict => {
    const identity = identityOf(c, config);
    return { sha: c.sha, signed: c.verified, identity, trusted: isTrusted(identity, config.trust.committers) };
  });
  return { head, commits: verdicts, problems };
}

type RestCommit = Awaited<ReturnType<GitHub["rest"]["pulls"]["listCommits"]>>["data"][number];

function account(user: RestCommit["author"]): Account | null {
  return user ? { id: Number(user.id), login: user.login } : null;
}

const WEB_QUERY_FIELDS = "committedViaWeb signature { isValid wasSignedByGitHub } author { user { login } }";

type WebNode = { committedViaWeb: boolean; signature: { isValid: boolean; wasSignedByGitHub: boolean } | null; author: { user: { login: string } | null } | null };

export async function fetchCommitFacts(gh: GitHub, repository: string, pullNumber: number): Promise<CommitFacts[]> {
  const { owner, repo } = splitRepository(repository);
  const rest = await gh.paginate(gh.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 });
  const facts: CommitFacts[] = rest.map((c) => ({
    sha: c.sha,
    verified: c.commit.verification?.verified === true,
    author: account(c.author),
    committer: account(c.committer),
  }));
  const web = facts.filter((c) => c.committer?.login === WEB_FLOW);
  if (web.length === 0) return facts;
  if (!web.every((c) => /^[0-9a-f]{40}$/.test(c.sha))) throw new Error("commit sha from the API is not 40 hex characters");
  const aliases = web.map((c, i) => `c${i}: object(oid: "${c.sha}") { ... on Commit { ${WEB_QUERY_FIELDS} } }`).join("\n");
  const data = await gh.graphql<{ repository: Record<string, WebNode | null> }>(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${aliases} } }`,
    { owner, repo },
  );
  web.forEach((c, i) => {
    const node = data.repository[`c${i}`];
    c.web = {
      committedViaWeb: node?.committedViaWeb === true,
      signatureValid: node?.signature?.isValid === true,
      signedByGitHub: node?.signature?.wasSignedByGitHub === true,
      authorLogin: node?.author?.user?.login ?? null,
    };
  });
  return facts;
}
