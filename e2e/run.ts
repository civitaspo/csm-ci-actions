// Runs the e2e scenarios of one or more features against the testing repositories.
//   bun e2e/run.ts --ref <sha> [--feature smoke[,approve,...]]
// Features of one invocation share the lock and the fixture sync. Their concurrent scenarios run
// together, then their serial scenarios run one at a time, because serial scenarios change state
// that every request reads, such as the server configuration and client rulesets.
// GH_TOKEN acts as the owner on the testing repositories. CSM_CI_ACTIONS_TOKEN (default GH_TOKEN)
// holds the lock and moves the e2e branch of csm-ci-actions, which the testing callers reference.
// CSM_CI_UNTRUSTED_COMMITTER_TOKEN, set only in the e2e workflow, enables the scenarios that need
// a second identity.
import { execFileSync } from "node:child_process";
import { ensureLabels, prLabels, type Feature } from "./pr-metadata.ts";
import { SCENARIOS } from "./scenarios.ts";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { appendFileSync, readFileSync } from "node:fs";
import { drainQueue, releaseAfterDrain } from "./drain.ts";
import { type GitHub, github, splitRepository } from "../src/lib/github.ts";
import { ACTIONS, CLIENT, SERVER, assert, type Ctx, drainWorkflowRuns, hasStatus, moveE2eBranch, type Scenario, sleep, syncFixtures } from "./harness.ts";

const LOCK = "e2e-lock";
const LOCK_POLL_MS = 15_000;
const LOCK_HEARTBEAT_MS = 5 * 60_000;
const CANCEL_POLL_MS = 5_000;
const MAX_CONCURRENT_SCENARIOS = 20;
// About 20 pull requests opened within two seconds left the last ones without workflow runs.
const SCENARIO_START_SPACING_MS = 2_000;

// The label name is unique in a repository, so creating it is an atomic test-and-set.
async function acquireLock(gh: GitHub, holder: string, stopping: () => boolean): Promise<boolean> {
  const repo = splitRepository(ACTIONS);
  while (!stopping()) {
    try {
      await gh.rest.issues.createLabel({ ...repo, name: LOCK, description: `${new Date().toISOString()} ${holder}` });
      console.log(`acquired the e2e lock as ${holder}`);
      return true;
    } catch (e) {
      if (!hasStatus(e, 422)) throw e;
    }
    let held: string;
    try {
      held = (await gh.rest.issues.getLabel({ ...repo, name: LOCK })).data.description ?? "";
    } catch (e) {
      if (hasStatus(e, 404)) continue;
      throw e;
    }
    console.log(`waiting for the e2e lock: ${held}`);
    await sleep(LOCK_POLL_MS);
  }
  return false;
}

// Keeps a long multi-feature invocation from looking stale to a waiting invocation.
async function refreshLock(gh: GitHub, holder: string): Promise<void> {
  const repo = splitRepository(ACTIONS);
  const { data } = await gh.rest.issues.getLabel({ ...repo, name: LOCK });
  if (data.description?.endsWith(` ${holder}`)) await gh.rest.issues.updateLabel({ ...repo, name: LOCK, description: `${new Date().toISOString()} ${holder}` });
}

async function releaseLock(gh: GitHub, holder: string): Promise<void> {
  const repo = splitRepository(ACTIONS);
  const { data } = await gh.rest.issues.getLabel({ ...repo, name: LOCK });
  assert(data.description?.endsWith(` ${holder}`), `e2e lock ownership changed; expected ${holder}, found ${data.description ?? "no description"}`);
  await gh.rest.issues.deleteLabel({ ...repo, name: LOCK });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ref: { type: "string" }, feature: { type: "string", default: "smoke" }, scenario: { type: "string" } } });
  const token = process.env.GH_TOKEN;
  assert(token, "GH_TOKEN is not set");
  assert(values.ref && /^[0-9a-f]{40}$/.test(values.ref), "--ref must be a full commit sha");
  const features = [...new Set(values.feature.split(",").map((name) => name.trim()))].map((name) => {
    const feature = Object.keys(SCENARIOS).find((key): key is Feature => key === name);
    assert(feature, `unknown feature ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
    return feature;
  });
  assert(values.scenario === undefined || values.scenario.length > 0, "--scenario must be a non-empty substring");
  const scenarios = features.flatMap((feature) => SCENARIOS[feature].map((scenario) => ({ feature, scenario })))
    .filter(({ scenario }) => values.scenario === undefined || scenario.name.includes(values.scenario));
  assert(scenarios.length > 0, `no ${values.feature} scenario matches ${JSON.stringify(values.scenario)}`);

  const gh = github(token);
  const actions = github(process.env.CSM_CI_ACTIONS_TOKEN || token);
  const untrustedToken = process.env.CSM_CI_UNTRUSTED_COMMITTER_TOKEN;
  // Label descriptions hold at most 100 characters, including the lock's timestamp.
  const holderRun = process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
    ? `gh${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}` : `local${process.pid}`;
  const holder = `${features.join(",").slice(0, 20)}@${values.ref.slice(0, 7)}#${randomBytes(3).toString("hex")}:${holderRun}`;

  const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" }).trim();
  const runner = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ATTEMPT
    ? { kind: "ci" as const, url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, attempt: process.env.GITHUB_RUN_ATTEMPT }
    : { kind: "local" as const };
  const started = Date.now();
  let stopRequested = false;
  let unsafe = false;
  let monitorFailure: unknown;
  const stop = () => { stopRequested = true; console.log("e2e cancellation requested; draining active scenarios"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const event = process.env.GITHUB_EVENT_NAME === "issue_comment" && process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as { issue?: { number?: number } }
    : undefined;
  const prNumber = process.env.E2E_PR_NUMBER ?? (event?.issue?.number ? String(event.issue.number) : undefined);
  const cancelLabel = process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT && prNumber
    ? `e2e-cancel-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` : undefined;
  const reportCancellation = async (message: string) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "cancelled=true\n");
    console.log(message);
    if (prNumber && !process.env.E2E_PR_NUMBER && runner.kind === "ci") {
      console.log("The older reporting workflow marks this intentional stop as failed; see this log for the cancellation result.");
      process.exitCode = 1;
    }
  };
  let poll: Promise<void> | undefined;
  let markerSeen = false;
  const checkCancel = async () => {
    if (!cancelLabel || markerSeen) return;
    try {
      const { data } = await actions.rest.issues.getLabel({ ...splitRepository(ACTIONS), name: cancelLabel });
      const match = /^pr=([1-9]\d*);attempt=([1-9]\d*)$/.exec(data.description ?? "");
      if (!match || match[1] !== prNumber || match[2] !== process.env.GITHUB_RUN_ATTEMPT) {
        throw new Error(`invalid cancellation marker ${cancelLabel}`);
      }
      markerSeen = true;
      if (!stopRequested) stop();
    } catch (error) {
      if (!hasStatus(error, 404)) {
        monitorFailure = error;
        stop();
      }
    }
  };
  const monitor = setInterval(() => {
    if (!poll) poll = checkCancel().finally(() => { poll = undefined; });
  }, CANCEL_POLL_MS);
  await checkCancel();
  let acquired: boolean;
  try {
    acquired = await acquireLock(actions, holder, () => stopRequested);
  } catch (error) {
    clearInterval(monitor);
    await poll;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    throw error;
  }
  if (!acquired) {
    clearInterval(monitor);
    await poll;
    if (monitorFailure) throw monitorFailure;
    if (cancelLabel && markerSeen) await actions.rest.issues.deleteLabel({ ...splitRepository(ACTIONS), name: cancelLabel }).catch((error: unknown) => { if (!hasStatus(error, 404)) throw error; });
    await reportCancellation("e2e cancelled before acquiring the lock");
    return;
  }
  const lockStarted = new Date();
  const heartbeat = setInterval(() => refreshLock(actions, holder).catch((e: unknown) => console.log(`could not refresh the e2e lock: ${String(e)}`)), LOCK_HEARTBEAT_MS);
  let failed = 0;
  let skipped = 0;
  let finished = 0;
  let completed = false;
  try {
    for (const [target, repository] of [["client", CLIENT], ["server", SERVER]] as const) {
      if (stopRequested) break;
      const names = [...new Set(scenarios.flatMap(({ feature, scenario }) => Object.values(scenario.cases)
        .filter((intent) => intent.target === target).flatMap((intent) => prLabels(feature, intent))))];
      if (names.length > 0) await ensureLabels(gh, repository, names);
    }
    if (!stopRequested) await moveE2eBranch(actions, values.ref);
    if (!stopRequested) await syncFixtures(gh);
    const runScenario = async ({ feature, scenario }: { feature: Feature; scenario: Scenario }) => {
      if (scenario.needsUntrusted && !untrustedToken) {
        console.log(`SKIP ${scenario.name}: needs CSM_CI_UNTRUSTED_COMMITTER_TOKEN, which only the e2e workflow has`);
        return { scenario, failed: false, skipped: true, seconds: 0 };
      }
      const ctx: Ctx = { gh, urls: [], untrusted: untrustedToken ? github(untrustedToken) : undefined, cases: scenario.cases,
        run: Object.freeze({ feature, scenarioId: scenario.id, scenarioName: scenario.name, invocation: holder, candidateSha: values.ref!, harnessSha, runner }) };
      const started = Date.now();
      const seconds = () => Math.round((Date.now() - started) / 1000);
      try {
        await scenario.run(ctx);
        console.log(`PASS ${scenario.name} (${seconds()}s)`);
        for (const url of ctx.urls) console.log(`  ${url}`);
        return { scenario, failed: false, skipped: false, seconds: seconds() };
      } catch (e) {
        unsafe = true;
        const message = e instanceof Error ? e.message : String(e);
        const status = typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
        console.log(`FAIL ${scenario.name} (${seconds()}s): ${message}${status}`);
        for (const url of ctx.urls) console.log(`  ${url}`);
        return { scenario, failed: true, skipped: false, seconds: seconds() };
      }
    };
    const queue = scenarios.filter(({ scenario }) => !scenario.serial);
    const results: Awaited<ReturnType<typeof runScenario>>[] = [];
    await drainQueue({ items: queue, workers: MAX_CONCURRENT_SCENARIOS, spacingMs: SCENARIO_START_SPACING_MS,
      stopped: () => stopRequested || unsafe, sleep, run: async (item) => { results.push(await runScenario(item)); } });
    for (const item of scenarios.filter(({ scenario }) => scenario.serial)) {
      if (stopRequested || unsafe) break;
      results.push(await runScenario(item));
    }
    console.log("scenario durations:");
    for (const r of results.filter((item) => !item.skipped).sort((a, b) => b.seconds - a.seconds)) {
      console.log(`  ${String(r.seconds).padStart(5)}s ${r.failed ? "FAIL" : "PASS"} ${r.scenario.id}`);
    }
    failed = results.filter((r) => r.failed).length;
    skipped = results.filter((r) => r.skipped).length;
    finished = results.length;
    completed = true;
  } finally {
    let released = false;
    try {
      if (completed && failed === 0 && !monitorFailure) {
        await releaseAfterDrain(() => drainWorkflowRuns(gh, lockStarted), async () => {
          clearInterval(monitor);
          await poll;
          await checkCancel();
          if (monitorFailure) throw monitorFailure;
          if (cancelLabel && markerSeen) await actions.rest.issues.deleteLabel({ ...splitRepository(ACTIONS), name: cancelLabel }).catch((error: unknown) => { if (!hasStatus(error, 404)) throw error; });
          await releaseLock(actions, holder);
          released = true;
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(monitor);
      await poll;
      if (!released) console.error(`e2e lock retained for ${holder}; verify cleanup and related workflow runs before removing it`);
    }
  }
  if (monitorFailure) throw monitorFailure;
  if (stopRequested) {
    if (failed > 0) throw new Error("e2e cancellation could not confirm cleanup; the lock was retained");
    await reportCancellation("e2e cancelled after active scenarios completed cleanup");
    return;
  }
  console.log(`${finished - failed - skipped}/${scenarios.length} scenarios passed, ${skipped} skipped, ${scenarios.length - finished} not started, in ${Math.round((Date.now() - started) / 1000)}s at ${values.ref}`);
  if (failed > 0) process.exit(1);
}

await main();
