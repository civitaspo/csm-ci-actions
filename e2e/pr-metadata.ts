import type { GitHub } from "../src/lib/github.ts";
import { splitRepository } from "../src/lib/github.ts";
import { MANAGED_FILES_TITLE } from "../src/lib/managed-files.ts";

export const FEATURES = ["smoke", "approve", "merge", "policy-check", "securefix", "release", "release-pr", "repo-settings"] as const;
export type Feature = typeof FEATURES[number];
const categories = {
  "identity-trust": "Immutable identities and configured trust",
  "bot-ownership": "Bot PR and commit ownership",
  signature: "Verified commit signatures",
  "command-evidence": "Original command evidence",
  replay: "Repeated requests and receipts",
  "head-consistency": "Pinned head consistency",
  "approval-policy": "Approval and policy results",
  "required-checks": "Required checks",
  "request-validation": "Request validation",
  "path-safety": "Allowed paths and changes",
  "branch-ownership": "Managed branch ownership",
  "metadata-refresh": "Generated PR metadata refresh",
  "release-publication": "Release publication",
  "release-verification": "Release assets and attestations",
  "repository-settings": "Repository settings reconciliation",
};
export type Check = keyof typeof categories;
type Permitted = { operation: string; outcome: "permitted"; expected: string };
type Rejected = { operation: string; outcome: "rejected"; expected: string };
type Step = Permitted | Rejected;
type Expectations =
  | { classification: "positive"; steps: readonly [Permitted, ...Permitted[]] }
  | { classification: "negative"; steps: readonly [Step, ...Step[]] }
  | { classification: "mixed"; steps: readonly [Permitted, Rejected, ...Step[]] | readonly [Rejected, Permitted, ...Step[]] };
export type PrIntent = Expectations & {
  id: string;
  target: "client" | "server";
  title: string;
  checks: readonly [Check, ...Check[]];
  identity: readonly [string, ...string[]];
};
export type RunMetadata = Readonly<{
  feature: Feature;
  scenarioId: string;
  scenarioName: string;
  invocation: string;
  candidateSha: string;
  harnessSha: string;
  runner: Readonly<{ kind: "local" } | { kind: "ci"; url: string; attempt: string }>;
}>;
export const LABEL_CATALOG = [
  { name: "e2e", color: "ededed", description: "E2E test resource; display metadata only" },
  ...FEATURES.filter((feature) => feature !== "smoke").map((feature) => ({ name: `e2e:${feature}`, color: "1d76db", description: `E2E ${feature} feature suite` })),
  ...(["positive", "negative", "mixed"] as const).map((classification) => ({ name: `case:${classification}`, color: "5319e7", description: `Declared ${classification} test expectations, not an observed result` })),
  ...Object.entries(categories).map(([check, description]) => ({ name: `check:${check}`, color: "0e8a16", description })),
];

export const OWNER_IDENTITY = [
  "PR author: civitaspo (ID 4525500).",
  "Effective commit identity: civitaspo (ID 4525500); GitHub-signed commits use the owner as author and web-flow as committer.",
  "Command requester: civitaspo (ID 4525500); automatic operations originate from the fixture workflow. Trust is configured by immutable IDs.",
] as const;

export function ownedAnnotationNumber(owned: { pull?: { number: number } } | undefined, expected: number): number {
  if (owned?.pull?.number !== expected) throw new Error("managed PR ownership is not verified; refusing annotation");
  return expected;
}

// Escape declarations as text, including HTML comment delimiters and Markdown links.
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()#!|]/g, "\\$&").replace(/[\r\n]+/g, " ");
}
export function prLabels(feature: Feature, intent: PrIntent): string[] {
  return ["e2e", `e2e:${feature}`, `case:${intent.classification}`, ...new Set(intent.checks.map((check) => `check:${check}`))];
}
export function prTitle(run: RunMetadata, intent: PrIntent, fixture: string): string {
  return `[e2e][${run.feature}][${intent.classification}] ${intent.title.replace(/[\r\n]+/g, " ")} — ${fixture}`;
}
export function prBody(run: RunMetadata, intent: PrIntent): string {
  const text = escapeText;
  const runner = run.runner.kind === "local" ? `Local invocation ${text(run.invocation)}` : `${run.runner.url} (attempt ${text(run.runner.attempt)})`;
  return `## E2E test
- Scenario: ${text(run.scenarioId)} — ${text(run.scenarioName)}
- Case: ${text(intent.id)}
- Classification: ${text(intent.classification)}
- Checks: ${intent.checks.map((check) => text(categories[check])).join("; ")}

## Expected behavior
These are test declarations, not observed results or authorization evidence. Consult the execution and operation receipts for actual results.

${intent.steps.map((step, i) => `${i + 1}. ${text(step.operation)}: ${text(step.expected)} (${step.outcome}).`).join("\n")}

## Identity and trust during this case
${intent.identity.map((line) => `- ${text(line)}`).join("\n")}

The harness attempts to restore temporary test configuration during cleanup; this description does not claim that cleanup succeeded.

## Execution
- Feature: ${text(run.feature)}
- Candidate SHA: ${text(run.candidateSha)}
- Harness SHA: ${text(run.harnessSha)}
- Invocation: ${text(run.invocation)}
- Runner: ${runner}
`;
}
const START = "<!-- csm-ci-e2e:intent:start -->";
const END = "<!-- csm-ci-e2e:intent:end -->";
export function annotatedBody(original: string, section: string): string {
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  if (start === -1 && end === -1) return `${original}\n\n${START}\n${section}${END}`;
  if (start === -1 || end < start || original.indexOf(START, start + START.length) !== -1 || original.indexOf(END, end + END.length) !== -1) throw new Error("malformed harness intent section; refusing to edit server content");
  return original.slice(0, start) + START + "\n" + section + END + original.slice(end + END.length);
}
function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}
export async function ensureLabels(gh: GitHub, repository: string, names: readonly string[]): Promise<void> {
  const repo = splitRepository(repository);
  for (const label of LABEL_CATALOG.filter((item) => names.includes(item.name))) {
    try { await gh.rest.issues.getLabel({ ...repo, name: label.name }); continue; }
    catch (error) { if (!hasStatus(error, 404)) throw error; }
    try { await gh.rest.issues.createLabel({ ...repo, ...label }); }
    catch (error) {
      if (!hasStatus(error, 422)) throw error;
      // Only a label now present at this exact name recovers concurrent creation.
      await gh.rest.issues.getLabel({ ...repo, name: label.name });
    }
  }
}
export async function labelPr(gh: GitHub, repository: string, number: number, run: RunMetadata, intent: PrIntent): Promise<void> {
  await gh.rest.issues.addLabels({ ...splitRepository(repository), issue_number: number, labels: prLabels(run.feature, intent) });
}
// Call only after the scenario's existing request, identity, marker, and head checks.
export async function annotatePr(gh: GitHub, repository: string, number: number, run: RunMetadata, intent: PrIntent): Promise<void> {
  await labelPr(gh, repository, number, run, intent);
  const { data } = await gh.rest.pulls.get({ ...splitRepository(repository), pull_number: number });
  await gh.rest.pulls.update({ ...splitRepository(repository), pull_number: number, body: annotatedBody(data.body ?? "", prBody(run, intent)) });
}

export function assertGeneratedMetadata(actual: { title: string; body: string | null }, expected: { title: string; body: string }): void {
  if (actual.title !== expected.title) throw new Error("unexpected generated PR title");
  if (actual.body !== expected.body) throw new Error("unexpected generated PR body");
}
const MANAGED_BODY = "Update files managed by csm-ci.\n\n<!-- csm-ci:repo-settings:managed-files -->";
// Generated callers append exactly one released-revision line to the managed body.
const GENERATED_CALLERS_LINE = /^\n\nStandard client workflows: v\d+\.\d+\.\d+ \([0-9a-f]{40}\)\.$/u;
export async function assertManagedMetadata(gh: GitHub, repository: string, number: number): Promise<void> {
  const { data } = await gh.rest.pulls.get({ ...splitRepository(repository), pull_number: number });
  const suffix = data.body?.startsWith(MANAGED_BODY) ? data.body.slice(MANAGED_BODY.length) : "";
  assertGeneratedMetadata(data, { title: MANAGED_FILES_TITLE, body: GENERATED_CALLERS_LINE.test(suffix) ? MANAGED_BODY + suffix : MANAGED_BODY });
}
