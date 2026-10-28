// Mutation-checks each E2E PR metadata rejection guard in an isolated copy of src/ and e2e/.
//   bun scripts/mutate-e2e-pr-metadata.ts
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mutations: [label: string, file: string, before: string, after: string][] = [
  ["generated title", "e2e/pr-metadata.ts", "if (actual.title !== expected.title)", "if (false)"],
  ["generated body", "e2e/pr-metadata.ts", "if (actual.body !== expected.body)", "if (false)"],
  ["missing case", "e2e/harness.ts", "assert(intent, `missing PR case", "assert(true, `missing PR case"],
  ["managed ownership", "e2e/pr-metadata.ts", "if (owned?.pull?.number !== expected)", "if (false)"],
  ["one missing delimiter", "e2e/pr-metadata.ts", "start === -1 && end === -1", "start === -1 || end === -1"],
  ["missing start delimiter", "e2e/pr-metadata.ts", "start === -1 || end < start", "false || end < start"],
  ["reversed or missing end delimiter", "e2e/pr-metadata.ts", "end < start ||", "false ||"],
  ["duplicate start delimiter", "e2e/pr-metadata.ts", "original.indexOf(START, start + START.length) !== -1", "false"],
  ["duplicate end delimiter", "e2e/pr-metadata.ts", "original.indexOf(END, end + END.length) !== -1", "false"],
  ["lookup API failure", "e2e/pr-metadata.ts", "if (!hasStatus(error, 404)) throw error", "if (false) throw error"],
  ["creation API failure", "e2e/pr-metadata.ts", "if (!hasStatus(error, 422)) throw error", "if (false) throw error"],
  ["creation conflict requires reread", "e2e/pr-metadata.ts", "      await gh.rest.issues.getLabel({ ...repo, name: label.name });", ""],
];

const workspace = mkdtempSync(join(tmpdir(), "csm-ci-e2e-intent-mutants-"));
const test = () => Bun.spawnSync([process.execPath, "test", "e2e/pr-metadata.test.ts"], { cwd: workspace, timeout: 20_000 });
const survivors: string[] = [];
try {
  for (const name of ["src", "e2e"]) cpSync(join(root, name), join(workspace, name), { recursive: true });
  cpSync(join(root, "package.json"), join(workspace, "package.json"));
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  const baseline = test();
  if (baseline.exitCode !== 0) {
    process.stderr.write(baseline.stderr);
    throw new Error("isolated mutation baseline failed");
  }
  for (const [label, file, before, after] of mutations) {
    const path = join(workspace, file);
    const original = readFileSync(path, "utf8");
    if (original.split(before).length !== 2) throw new Error(`mutation must match exactly once: ${label}`);
    let survived: boolean;
    try {
      writeFileSync(path, original.replace(before, () => after));
      survived = test().exitCode === 0;
    } finally {
      writeFileSync(path, original);
    }
    if (survived) survivors.push(label);
    console.log(`${survived ? "SURVIVED" : "killed"} ${label}`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
console.log(`${mutations.length - survivors.length}/${mutations.length} rejection guards killed`);
if (survivors.length > 0) process.exit(1);
