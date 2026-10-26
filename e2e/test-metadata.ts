import type { PrIntent, RunMetadata } from "./pr-metadata.ts";
export const testRun: RunMetadata = { feature: "release", scenarioId: "release.test", scenarioName: "fixture test", invocation: "local-test", candidateSha: "1".repeat(40), harnessSha: "2".repeat(40), runner: { kind: "local" } };
export const testIntent: PrIntent = { id: "fixture", target: "client", title: "Release fixture", classification: "positive", checks: ["release-publication"], steps: [{ operation: "release", outcome: "permitted", expected: "Setup merges and release succeeds" }], identity: ["PR author, effective commit identity and requester: owner"] };
export const testMetadata = { run: testRun, cases: { fixture: testIntent } };
