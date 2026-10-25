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
  const result: ServerOwnedCommit[] = [];
  const mergeBaseSha = comparison.data.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Rejection(input.messages.incomplete);
  let expectedParent = mergeBaseSha;
  const seen = new Set<string>();
  let commits = comparison.data.commits;
  let collected = 0;
  for (let page = 1; ; page++) {
    if (page > 1 && (commits.length === 0 || commits.some(({ sha }) => seen.has(sha)))) {
      throw new Rejection(input.messages.incomplete);
    }
    for (const compared of commits) {
      seen.add(compared.sha);
      collected++;
      if (!await isServerMadeCommit(gh, { owner: input.owner, repo: input.repo, sha: compared.sha, serverBotId: input.serverBotId })) {
        throw new Rejection(input.messages.untrusted);
      }
      const { data: commit } = await gh.rest.repos.getCommit({ owner: input.owner, repo: input.repo, ref: compared.sha });
      if (commit.parents.length !== 1 || commit.parents[0]?.sha !== expectedParent) throw new Rejection(input.messages.nonLinear);
      if (commit.files === undefined || commit.files.length >= 300) throw new Rejection(input.messages.changesIncomplete);
      result.push({ sha: compared.sha, parentSha: expectedParent, files: commit.files });
      expectedParent = compared.sha;
    }
    if (collected >= comparison.data.ahead_by) break;
    const next = await gh.rest.repos.compareCommitsWithBasehead({ ...comparisonInput, page: page + 1 });
    commits = next.data.commits;
  }
  if (expectedParent !== input.headSha) throw new Rejection(input.messages.incomplete);
  return result;
}
