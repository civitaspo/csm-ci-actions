import { Rejection } from "./request.ts";
import type { GitHub } from "./github.ts";

export type ServerOwnedCommit = {
  sha: string;
  parentSha: string;
  files: NonNullable<Awaited<ReturnType<GitHub["rest"]["repos"]["getCommit"]>>["data"]["files"]>;
};

export async function isServerMadeCommit(gh: GitHub, input: { owner: string; repo: string; sha: string; serverBotId: number }): Promise<boolean> {
  const { data: commit } = await gh.rest.repos.getCommit({ owner: input.owner, repo: input.repo, ref: input.sha });
  if (commit.committer?.login !== "web-flow" || Number(commit.author?.id) !== input.serverBotId || commit.commit.verification?.verified !== true) return false;
  const data = await gh.graphql<{ repository: { commit: { signature: { isValid: boolean; wasSignedByGitHub: boolean } | null } | null } }>(
    "query($owner: String!, $repo: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $repo) { commit: object(oid: $sha) { ... on Commit { signature { isValid wasSignedByGitHub } } } } }",
    { owner: input.owner, repo: input.repo, sha: input.sha },
  );
  const signature = data.repository.commit?.signature;
  return signature?.isValid === true && signature.wasSignedByGitHub === true;
}

export async function loadServerOwnedHistory(gh: GitHub, input: {
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  serverBotId: number;
  messages: {
    incomplete: string;
    untrusted: string;
    changesIncomplete: string;
    nonLinear: string;
  };
}): Promise<ServerOwnedCommit[]> {
  const comparisonInput = {
    owner: input.owner,
    repo: input.repo,
    basehead: `${input.baseSha}...${input.headSha}`,
    per_page: 100,
  };
  const comparison = await gh.rest.repos.compareCommitsWithBasehead(comparisonInput);
  const comparedCommits = [...comparison.data.commits];
  const seen = new Set(comparedCommits.map(({ sha }) => sha));
  for (let page = 2; comparedCommits.length < comparison.data.ahead_by; page++) {
    const next = await gh.rest.repos.compareCommitsWithBasehead({ ...comparisonInput, page });
    if (next.data.commits.length === 0 || next.data.commits.some(({ sha }) => seen.has(sha))) throw new Rejection(input.messages.incomplete);
    for (const commit of next.data.commits) {
      seen.add(commit.sha);
      comparedCommits.push(commit);
    }
  }
  const result: ServerOwnedCommit[] = [];
  const mergeBaseSha = comparison.data.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Rejection(input.messages.incomplete);
  let expectedParent = mergeBaseSha;
  for (const compared of comparedCommits) {
    if (!await isServerMadeCommit(gh, { owner: input.owner, repo: input.repo, sha: compared.sha, serverBotId: input.serverBotId })) {
      throw new Rejection(input.messages.untrusted);
    }
    const { data: commit } = await gh.rest.repos.getCommit({ owner: input.owner, repo: input.repo, ref: compared.sha });
    if (commit.parents.length !== 1 || commit.parents[0]?.sha !== expectedParent) throw new Rejection(input.messages.nonLinear);
    if (commit.files === undefined || commit.files.length >= 300) throw new Rejection(input.messages.changesIncomplete);
    result.push({ sha: compared.sha, parentSha: expectedParent, files: commit.files });
    expectedParent = compared.sha;
  }
  if (expectedParent !== input.headSha) throw new Rejection(input.messages.incomplete);
  return result;
}
