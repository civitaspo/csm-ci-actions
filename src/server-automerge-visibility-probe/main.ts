import * as core from "@actions/core";
import { z } from "zod";
import { github, loadCurrentServerConfig, splitRepository, type GitHub } from "../lib/github.ts";

const SERVER_REPOSITORY = "civitaspo/testing-csm-ci-server";
const CLIENT_REPOSITORY = "civitaspo/testing-csm-ci-client";
const SERVER_ENVIRONMENT = "csm-ci-automerge-visibility-probe";
const CLIENT_ENVIRONMENT = "csm-ci-automerge-display-probe";
const TASK = "csm-ci:automerge-visibility-probe";
const SERVER_BRANCH_PREFIX = "codex/automerge-visibility-probe-";
const CAS_ATTEMPTS = 3;

type Mode = "create" | "cleanup";
const ProbeDeploymentSchema = z.object({
  id: z.number().int().positive(), node_id: z.string().min(1), environment: z.string(), task: z.string(), sha: z.string().min(1), payload: z.unknown(),
  creator: z.object({ id: z.number().int().positive(), type: z.string() }).nullable(),
});
type ProbeDeployment = z.infer<typeof ProbeDeploymentSchema>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseMode(value: string): Mode {
  if (value === "create" || value === "cleanup") return value;
  throw new Error("mode must be create or cleanup");
}

function parseInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

async function repositoryIdentity(gh: GitHub, repository: string): Promise<number> {
  const { data } = await gh.rest.repos.get(splitRepository(repository));
  return Number(data.id);
}

async function ensureOpenClientPull(gh: GitHub, pullNumber: number, expectedSha: string): Promise<void> {
  const { data } = await gh.rest.pulls.get({ ...splitRepository(CLIENT_REPOSITORY), pull_number: pullNumber });
  assert(data.state === "open" && data.head.sha === expectedSha, `client pull request #${pullNumber} is not open at the requested head`);
}

async function branchHead(gh: GitHub, branch: string): Promise<string> {
  const { data } = await gh.rest.git.getRef({ ...splitRepository(SERVER_REPOSITORY), ref: `heads/${branch}` });
  return data.object.sha;
}

async function createCommit(gh: GitHub, branch: string, expectedHead: string, probeId: string, index: number): Promise<string> {
  const response = await gh.graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
    "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    {
      input: {
        branch: { repositoryNameWithOwner: SERVER_REPOSITORY, branchName: branch },
        expectedHeadOid: expectedHead,
        message: { headline: `csm-ci: automerge ${CLIENT_REPOSITORY}#${required("PULL_NUMBER")}`, body: `probe-id=${probeId}\ncommit=${index}` },
        fileChanges: { additions: [] },
      },
    },
  );
  return response.createCommitOnBranch.commit.oid;
}

async function appendCommits(gh: GitHub, branch: string, initialHead: string, probeId: string): Promise<string[]> {
  const first = await Promise.allSettled([1, 2].map((index) => createCommit(gh, branch, initialHead, probeId, index)));
  const created = first.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const rejected = first.flatMap((result, index) => result.status === "rejected" ? [index + 1] : []);
  assert(created.length === 1 && rejected.length === 1, "concurrent compare-and-swap did not produce exactly one winner");
  const index = rejected[0]!;
  let saved: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < CAS_ATTEMPTS && !saved; attempt++) {
    const head = await branchHead(gh, branch);
    try {
      saved = await createCommit(gh, branch, head, probeId, index);
    } catch (error) {
      lastError = error;
    }
  }
  if (!saved) throw new Error(`compare-and-swap retry failed after ${CAS_ATTEMPTS} attempts: ${String(lastError)}`);
  created.push(saved);
  return created;
}

type CommitDetails = { repository: { object: { oid: string; messageHeadline: string; messageBody: string; changedFilesIfAvailable: number | null; parents: { nodes: { oid: string }[] }; signature: { isValid: boolean; wasSignedByGitHub: boolean } | null } | null } };

async function verifyCommitChain(gh: GitHub, commits: readonly string[], expectedParent: string, pullNumber: number, probeId: string): Promise<void> {
  const details = new Map<string, NonNullable<CommitDetails["repository"]["object"]>>();
  for (const oid of commits) {
    const result: CommitDetails = await gh.graphql(
      "query($oid: GitObjectID!) { repository(owner: \"civitaspo\", name: \"testing-csm-ci-server\") { object(oid: $oid) { ... on Commit { oid messageHeadline messageBody changedFilesIfAvailable parents(first: 1) { nodes { oid } } signature { isValid wasSignedByGitHub } } } } }",
      { oid },
    );
    const commit = result.repository.object;
    assert(commit?.oid === oid, `GitHub could not read probe commit ${oid}`);
    assert(commit.messageHeadline === `csm-ci: automerge ${CLIENT_REPOSITORY}#${pullNumber}`, `probe commit ${oid} has an unexpected subject`);
    assert(commit.messageBody.includes(`probe-id=${probeId}`), `probe commit ${oid} lost its correlation marker`);
    assert(commit.changedFilesIfAvailable === 0, `probe commit ${oid} changed files`);
    assert(commit.parents.nodes.length === 1, `probe commit ${oid} does not have exactly one parent`);
    assert(commit.signature?.isValid === true && commit.signature.wasSignedByGitHub, `probe commit ${oid} is not GitHub signed`);
    details.set(oid, commit);
  }
  let parent = expectedParent;
  for (let index = 0; index < commits.length; index++) {
    const next = [...details].find(([, commit]) => commit.parents.nodes[0]?.oid === parent);
    assert(next, `probe commits do not form a chain from parent ${parent}`);
    parent = next[0];
    details.delete(next[0]);
  }
  assert(details.size === 0, "probe commits do not form one complete chain");
}

async function createDeployment(gh: GitHub, args: { repository: string; environment: string; sha: string; probeId: string; pullNumber: number; serverBotId: number }): Promise<ProbeDeployment> {
  const { owner, repo } = splitRepository(args.repository);
  const { data } = await gh.rest.repos.createDeployment({
    owner, repo, ref: args.sha, task: TASK, environment: args.environment,
    auto_merge: false, required_contexts: [], production_environment: false, transient_environment: true,
    description: `visibility probe ${args.probeId}`,
    payload: { probe_id: args.probeId, client_repository: CLIENT_REPOSITORY, client_sha: required("CLIENT_SHA"), pull_number: args.pullNumber },
  });
  const deployment = ProbeDeploymentSchema.parse(data);
  assert(deployment.sha === args.sha, `GitHub created a deployment for ${deployment.sha}, expected SHA ${args.sha}`);
  assert(deployment.task === TASK && deployment.environment === args.environment, "GitHub created a probe deployment with the wrong task or environment");
  assert(deployment.creator?.type === "Bot" && deployment.creator.id === args.serverBotId, "Server App did not create the probe deployment");
  return deployment;
}

async function createStatus(gh: GitHub, deployment: ProbeDeployment, server: boolean, runUrl: string): Promise<void> {
  const repo = splitRepository(server ? SERVER_REPOSITORY : CLIENT_REPOSITORY);
  await gh.rest.repos.createDeploymentStatus({
    ...repo,
    deployment_id: deployment.id,
    state: "queued",
    description: `automerge visibility probe ${server ? "reservation" : "display"}`,
    log_url: runUrl,
    environment_url: server ? `https://github.com/${CLIENT_REPOSITORY}/pull/${required("PULL_NUMBER")}` : runUrl,
    auto_inactive: false,
  });
}

function parseProbeId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("probe-id must be a UUID v4");
  return value;
}

function parseSha(value: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("client-sha must be a full commit SHA");
  return value;
}

async function listProbeDeployments(gh: GitHub, repository: string, environment: string, probeId: string): Promise<ProbeDeployment[]> {
  const deployments = await gh.paginate(gh.rest.repos.listDeployments, { ...splitRepository(repository), environment, per_page: 100 });
  return deployments.filter((deployment) => {
    if (deployment.task !== TASK) return false;
    let payload: unknown = deployment.payload;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload) as unknown; } catch { return false; }
    }
    return typeof payload === "object" && payload !== null && "probe_id" in payload && payload.probe_id === probeId;
  }).map((deployment) => ProbeDeploymentSchema.parse(deployment));
}

async function removeProbeDeployments(gh: GitHub, repository: string, environment: string, probeId: string, pullNumber: number, expectedSha: string | undefined, serverBotId: number): Promise<void> {
  const { owner, repo } = splitRepository(repository);
  for (const deployment of await listProbeDeployments(gh, repository, environment, probeId)) {
    const current = await gh.rest.repos.getDeployment({ owner, repo, deployment_id: deployment.id });
    assert(current.data.task === TASK && current.data.environment === environment, `deployment ${deployment.id} changed identity; leaving it in place`);
    assert(current.data.creator?.type === "Bot" && current.data.creator.id === serverBotId, `deployment ${deployment.id} has a foreign creator; leaving it in place`);
    if (expectedSha) assert(current.data.sha === expectedSha, `deployment ${deployment.id} has a different SHA; leaving it in place`);
    const payload = typeof current.data.payload === "string" ? JSON.parse(current.data.payload) as unknown : current.data.payload;
    assert(typeof payload === "object" && payload !== null && "probe_id" in payload && payload.probe_id === probeId
      && "pull_number" in payload && payload.pull_number === pullNumber
      && "client_repository" in payload && payload.client_repository === CLIENT_REPOSITORY
      && "client_sha" in payload && payload.client_sha === required("CLIENT_SHA"), `deployment ${deployment.id} has different correlation data; leaving it in place`);
    await gh.rest.repos.createDeploymentStatus({ owner, repo, deployment_id: deployment.id, state: "inactive", description: `cleanup visibility probe ${probeId}`, auto_inactive: false });
    await gh.rest.repos.deleteDeployment({ owner, repo, deployment_id: deployment.id });
    core.info(`removed owned probe deployment ${deployment.id} from ${repository}`);
  }
}

async function createProbe(server: GitHub, clientRead: GitHub, clientDeployments: GitHub, pullNumber: number, clientSha: string, probeId: string): Promise<void> {
  await ensureOpenClientPull(clientRead, pullNumber, clientSha);
  const config = await loadCurrentServerConfig(server, SERVER_REPOSITORY, "csm-ci.yaml");
  const { data: serverRepo } = await server.rest.repos.get(splitRepository(SERVER_REPOSITORY));
  const branch = `${SERVER_BRANCH_PREFIX}${probeId}`;
  const base = await server.rest.git.getRef({ ...splitRepository(SERVER_REPOSITORY), ref: `heads/${serverRepo.default_branch}` });
  await core.summary.addHeading("Automerge visibility probe").addTable([
    [{ data: "Item", header: true }, { data: "Value", header: true }],
    ["Probe ID", probeId], ["Client pull request", `https://github.com/${CLIENT_REPOSITORY}/pull/${pullNumber}`],
    ["Client SHA", clientSha], ["Server branch", branch], ["Expected parent", base.data.object.sha],
  ]).write();
  await server.rest.git.createRef({ ...splitRepository(SERVER_REPOSITORY), ref: `refs/heads/${branch}`, sha: base.data.object.sha });
  const commits = await appendCommits(server, branch, base.data.object.sha, probeId);
  const tip = await branchHead(server, branch);
  assert(tip === commits.at(-1), "probe branch tip does not match the last commit");
  await verifyCommitChain(server, commits, base.data.object.sha, pullNumber, probeId);

  const serverDeployment = await createDeployment(server, { repository: SERVER_REPOSITORY, environment: SERVER_ENVIRONMENT, sha: tip, probeId, pullNumber, serverBotId: config.apps.server_bot_id });
  await createStatus(server, serverDeployment, true, `https://github.com/${SERVER_REPOSITORY}/actions/runs/${required("RUN_ID")}`);
  const clientRepositoryId = await repositoryIdentity(clientRead, CLIENT_REPOSITORY);
  await core.summary
    .addTable([
      [{ data: "Item", header: true }, { data: "Value", header: true }],
      ["Probe ID", probeId], ["Client pull request", `https://github.com/${CLIENT_REPOSITORY}/pull/${pullNumber}`],
      ["Server repository ID", String((await server.rest.repos.get(splitRepository(SERVER_REPOSITORY))).data.id)],
      ["Server deployment", String(serverDeployment.id)], ["Server commit", tip], ["Server branch", branch],
      ["Expected parent", base.data.object.sha], ["Client repository ID", String(clientRepositoryId)],
      ["Client head", clientSha],
    ])
    .write();
  core.notice(`server deployment ${serverDeployment.id} uses SHA ${tip}; branch ${branch}; parent ${base.data.object.sha}`);

  if (process.env.CLIENT_TOKEN_RESULT !== "success" || !process.env.CLIENT_TOKEN) {
    core.warning(`client Deployments token was not issued (${process.env.CLIENT_TOKEN_RESULT ?? "unknown"}); server reservation probe completed without client display`);
    return;
  }
  const { data: clientRepo } = await clientDeployments.rest.repos.get(splitRepository(CLIENT_REPOSITORY));
  const clientDeployment = await createDeployment(clientDeployments, { repository: CLIENT_REPOSITORY, environment: CLIENT_ENVIRONMENT, sha: clientSha, probeId, pullNumber, serverBotId: config.apps.server_bot_id });
  await createStatus(clientDeployments, clientDeployment, false, `https://github.com/${SERVER_REPOSITORY}/actions/runs/${required("RUN_ID")}`);
  core.notice(`client deployment ${clientDeployment.id} for PR #${pullNumber} uses SHA ${clientSha}; client repository ID ${clientRepo.id}`);
  await core.summary.addTable([
    [{ data: "Client deployment", header: true }, { data: "Client environment", header: true }],
    [String(clientDeployment.id), clientDeployment.environment],
  ]).write();
  core.info(`Server App bot ID for cleanup: ${config.apps.server_bot_id}`);
}

async function cleanup(server: GitHub, client: GitHub, pullNumber: number, clientSha: string, probeId: string, expectedTip: string | undefined): Promise<void> {
  const config = await loadCurrentServerConfig(server, SERVER_REPOSITORY, "csm-ci.yaml");
  if (process.env.SERVER_TOKEN_RESULT === "success" && process.env.SERVER_TOKEN) {
    await removeProbeDeployments(server, SERVER_REPOSITORY, SERVER_ENVIRONMENT, probeId, pullNumber, expectedTip, config.apps.server_bot_id);
  }
  if (process.env.CLIENT_TOKEN_RESULT === "success" && process.env.CLIENT_TOKEN) {
    await removeProbeDeployments(client, CLIENT_REPOSITORY, CLIENT_ENVIRONMENT, probeId, pullNumber, clientSha, config.apps.server_bot_id);
  } else {
    core.warning("client cleanup skipped because the Server App client Deployments token is unavailable");
  }
  const branch = `${SERVER_BRANCH_PREFIX}${probeId}`;
  let current: string | undefined;
  try {
    current = await branchHead(server, branch);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "status" in error && error.status === 404)) throw error;
  }
  if (!current) {
    await core.summary.addHeading("Automerge visibility probe cleanup").addList([
      `Probe ID: ${probeId}`,
      `Client pull request: https://github.com/${CLIENT_REPOSITORY}/pull/${pullNumber}`,
      "The probe branch was already absent.",
    ]).write();
    return;
  }
  if (!expectedTip) {
    core.warning(`probe branch ${branch} exists at ${current}; no verified tip was supplied, leaving it in place`);
    return;
  }
  assert(current === expectedTip, `probe branch tip is ${current}, expected ${expectedTip}; leaving the ref in place`);
  await server.rest.git.deleteRef({ ...splitRepository(SERVER_REPOSITORY), ref: `heads/${branch}` });
  core.info(`removed probe ref ${branch} at verified tip ${expectedTip}`);
  await core.summary.addHeading("Automerge visibility probe cleanup").addList([
    `Probe ID: ${probeId}`,
    `Client pull request: https://github.com/${CLIENT_REPOSITORY}/pull/${pullNumber}`,
    `Verified and removed server ref: ${branch} at ${expectedTip}`,
  ]).write();
}

async function main(): Promise<void> {
  assert(required("GITHUB_REPOSITORY") === SERVER_REPOSITORY, `probe only runs in ${SERVER_REPOSITORY}`);
  const mode = parseMode(required("MODE"));
  const pullNumber = parseInteger(required("PULL_NUMBER"), "pull-number");
  const clientSha = parseSha(required("CLIENT_SHA"));
  const probeId = parseProbeId(required("PROBE_ID"));
  const serverToken = process.env.SERVER_TOKEN;
  const clientToken = process.env.CLIENT_TOKEN;
  const server = github(serverToken ?? "");
  const client = github(clientToken ?? "");
  if (mode === "create") {
    assert(process.env.SERVER_TOKEN_RESULT === "success" && serverToken, "Server App Contents and Deployments token was not issued");
    assert(process.env.CLIENT_READ_TOKEN_RESULT === "success" && process.env.CLIENT_READ_TOKEN, "Server App client pull request read token was not issued; no resources were created");
    await createProbe(server, github(required("CLIENT_READ_TOKEN")), client, pullNumber, clientSha, probeId);
    return;
  }
  assert(process.env.SERVER_TOKEN_RESULT === "success" && serverToken, "Server App cleanup token was not issued");
  const expectedTip = process.env.SERVER_TIP ? parseSha(process.env.SERVER_TIP) : undefined;
  await cleanup(server, client, pullNumber, clientSha, probeId, expectedTip);
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
