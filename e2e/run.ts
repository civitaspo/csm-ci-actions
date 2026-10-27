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
import { type GitHub, github, splitRepository } from "../src/lib/github.ts";
import { ACTIONS, CLIENT, SERVER, assert, type Ctx, hasStatus, moveE2eBranch, type Scenario, sleep, syncFixtures } from "./harness.ts";

const LOCK = "e2e-lock";
const LOCK_TTL_MS = 60 * 60_000;
const LOCK_POLL_MS = 15_000;

// The label name is unique in a repository, so creating it is an atomic test-and-set.
async function acquireLock(gh: GitHub, holder: string): Promise<void> {
  const repo = splitRepository(ACTIONS);
  for (;;) {
    try {
      await gh.rest.issues.createLabel({ ...repo, name: LOCK, description: `${new Date().toISOString()} ${holder}` });
      console.log(`acquired the e2e lock as ${holder}`);
      return;
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
    const since = Date.parse(held.split(" ")[0] ?? "");
    if (Number.isNaN(since) || Date.now() - since > LOCK_TTL_MS) {
      // shortcut: two runs taking over the same stale lock can race; acceptable for a 60 minute TTL.
      console.log(`taking over the stale e2e lock: ${held}`);
      await gh.rest.issues.deleteLabel({ ...repo, name: LOCK }).catch((e: unknown) => {
        if (!hasStatus(e, 404)) throw e;
      });
      continue;
    }
    console.log(`waiting for the e2e lock: ${held}`);
    await sleep(LOCK_POLL_MS);
  }
}

async function releaseLock(gh: GitHub, holder: string): Promise<void> {
  const repo = splitRepository(ACTIONS);
  const { data } = await gh.rest.issues.getLabel({ ...repo, name: LOCK });
  if (data.description?.endsWith(` ${holder}`)) await gh.rest.issues.deleteLabel({ ...repo, name: LOCK });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ref: { type: "string" }, feature: { type: "string", default: "smoke" }, scenario: { type: "string" } } });
  const token = process.env.GH_TOKEN;
  assert(token, "GH_TOKEN is not set");
  assert(values.ref && /^[0-9a-f]{40}$/.test(values.ref), "--ref must be a full commit sha");
  const features = [...new Set(values.feature.split(","))].map((name) => {
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
  const holder = `${features.join(",").slice(0, 40)}@${values.ref.slice(0, 7)}#${randomBytes(3).toString("hex")}`;

  const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, encoding: "utf8" }).trim();
  const runner = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ATTEMPT
    ? { kind: "ci" as const, url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, attempt: process.env.GITHUB_RUN_ATTEMPT }
    : { kind: "local" as const };
  const started = Date.now();
  await acquireLock(actions, holder);
  let failed = 0;
  let skipped = 0;
  try {
    for (const [target, repository] of [["client", CLIENT], ["server", SERVER]] as const) {
      const names = [...new Set(scenarios.flatMap(({ feature, scenario }) => Object.values(scenario.cases)
        .filter((intent) => intent.target === target).flatMap((intent) => prLabels(feature, intent))))];
      if (names.length > 0) await ensureLabels(gh, repository, names);
    }
    await moveE2eBranch(actions, values.ref);
    await syncFixtures(gh);
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
        const message = e instanceof Error ? e.message : String(e);
        const status = typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
        console.log(`FAIL ${scenario.name} (${seconds()}s): ${message}${status}`);
        for (const url of ctx.urls) console.log(`  ${url}`);
        return { scenario, failed: true, skipped: false, seconds: seconds() };
      }
    };
    const results = await Promise.all(scenarios.filter(({ scenario }) => !scenario.serial).map(runScenario));
    for (const item of scenarios.filter(({ scenario }) => scenario.serial)) results.push(await runScenario(item));
    console.log("scenario durations:");
    for (const r of results.filter((item) => !item.skipped).sort((a, b) => b.seconds - a.seconds)) {
      console.log(`  ${String(r.seconds).padStart(5)}s ${r.failed ? "FAIL" : "PASS"} ${r.scenario.id}`);
    }
    failed = results.filter((r) => r.failed).length;
    skipped = results.filter((r) => r.skipped).length;
  } finally {
    await releaseLock(actions, holder);
  }
  console.log(`${scenarios.length - failed - skipped}/${scenarios.length} scenarios passed, ${skipped} skipped, in ${Math.round((Date.now() - started) / 1000)}s at ${values.ref}`);
  if (failed > 0) process.exit(1);
}

await main();
