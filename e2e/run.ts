// Runs the e2e scenarios of a feature against the testing repositories.
//   bun e2e/run.ts --ref <sha> [--feature smoke]
// GH_TOKEN acts as the owner on the testing repositories. CSM_CI_ACTIONS_TOKEN (default GH_TOKEN)
// holds the lock and moves the e2e branch of csm-ci-actions, which the testing callers reference.
// CSM_CI_UNTRUSTED_COMMITTER_TOKEN, set only in the e2e workflow, enables the scenarios that need
// a second identity.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { type GitHub, github, splitRepository } from "../src/lib/github.ts";
import { approve } from "./approve.ts";
import { ACTIONS, assert, type Ctx, hasStatus, moveE2eBranch, type Scenario, sleep, syncFixtures } from "./harness.ts";
import { policyCheck } from "./policy-check.ts";
import { smoke } from "./smoke.ts";

const FEATURES: Record<string, Scenario[]> = { smoke, approve, "policy-check": policyCheck };

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
  const featureScenarios = FEATURES[values.feature ?? ""];
  assert(featureScenarios, `unknown feature ${values.feature}; known: ${Object.keys(FEATURES).join(", ")}`);
  assert(values.scenario === undefined || values.scenario.length > 0, "--scenario must be a non-empty substring");
  const scenarios = values.scenario ? featureScenarios.filter((scenario) => scenario.name.includes(values.scenario!)) : featureScenarios;
  assert(scenarios.length > 0, `no ${values.feature} scenario matches ${JSON.stringify(values.scenario)}`);

  const gh = github(token);
  const actions = github(process.env.CSM_CI_ACTIONS_TOKEN || token);
  const untrustedToken = process.env.CSM_CI_UNTRUSTED_COMMITTER_TOKEN;
  const holder = `${values.feature}@${values.ref.slice(0, 7)}#${randomBytes(3).toString("hex")}`;

  await acquireLock(actions, holder);
  let failed = 0;
  let skipped = 0;
  try {
    await moveE2eBranch(actions, values.ref);
    await syncFixtures(gh);
    const results = await Promise.all(scenarios.map(async (scenario) => {
      if (scenario.needsUntrusted && !untrustedToken) {
        console.log(`SKIP ${scenario.name}: needs CSM_CI_UNTRUSTED_COMMITTER_TOKEN, which only the e2e workflow has`);
        return { failed: false, skipped: true };
      }
      const ctx: Ctx = { gh, urls: [], untrusted: untrustedToken ? github(untrustedToken) : undefined };
      try {
        await scenario.run(ctx);
        console.log(`PASS ${scenario.name}`);
        for (const url of ctx.urls) console.log(`  ${url}`);
        return { failed: false, skipped: false };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
        console.log(`FAIL ${scenario.name}: ${message}${status}`);
        for (const url of ctx.urls) console.log(`  ${url}`);
        return { failed: true, skipped: false };
      }
    }));
    failed = results.filter((r) => r.failed).length;
    skipped = results.filter((r) => r.skipped).length;
  } finally {
    await releaseLock(actions, holder);
  }
  console.log(`${scenarios.length - failed - skipped}/${scenarios.length} scenarios passed, ${skipped} skipped, at ${values.ref}`);
  if (failed > 0) process.exit(1);
}

await main();
