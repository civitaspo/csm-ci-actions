// Requests a cooperative stop for the sole active e2e run associated with a pull request.
// Usage: GH_TOKEN=<token> REPO=owner/repo bun e2e/cancel.ts <pull-request-number>
import { github, splitRepository } from "../src/lib/github.ts";
import { ALLOWED_IDS, findCancellationTarget, requestCancellation } from "./e2e-comment.ts";
import { ACTIONS } from "./harness.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const [argument, ...extra] = process.argv.slice(2);
  if (!argument || extra.length > 0 || !/^[1-9][0-9]*$/u.test(argument) || !Number.isSafeInteger(Number(argument))) {
    throw new Error("usage: GH_TOKEN=<token> REPO=owner/repo bun e2e/cancel.ts <pull-request-number>");
  }
  const prNumber = Number(argument);
  const repository = required("REPO");
  if (repository.toLowerCase() !== ACTIONS.toLowerCase()) throw new Error(`REPO must be ${ACTIONS}`);
  const repo = splitRepository(repository);
  const gh = github(required("GH_TOKEN"));
  const { data: actor } = await gh.rest.users.getAuthenticated();
  if (!ALLOWED_IDS.includes(Number(actor.id))) throw new Error("the authenticated GitHub user is not allowed to run e2e");
  const { data: pr } = await gh.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (pr.state !== "open") throw new Error("the pull request is not open");

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const selected = await findCancellationTarget(gh, repository, prNumber, serverUrl);
  if (!selected.ok) throw new Error(selected.error);
  await requestCancellation(gh, repository, prNumber, selected.target, serverUrl);
  const runUrl = `${serverUrl}/${repository}/actions/runs/${selected.target.runId}`;
  await gh.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body: `e2e cancellation requested for run ${selected.target.runId}, attempt ${selected.target.attempt}. The active scenario will finish and cleanup must succeed before the run releases its lock. This confirms the request only; the run will post its final result after cleanup. Run: ${runUrl}`,
  });
  console.log(`Cancellation requested for ${runUrl} (attempt ${selected.target.attempt}). This confirms the request only; check the run's final result after cleanup.`);
}

if (import.meta.main) await main();
