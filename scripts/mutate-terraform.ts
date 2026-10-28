import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Remove each release rejection guard (an `ensure(...)` call) in an isolated copy and rerun its tests.
const root = resolve(import.meta.dir, "..");
const TIMEOUT_MS = 60_000;
const guarded = [
  { file: "src/release/terraform-assets.ts", tests: ["src/release/terraform-assets.test.ts"] },
  { file: "src/release/zip-reader.ts", tests: ["src/release/zip-reader.test.ts"] },
  { file: "src/release/terraform-collect.ts", tests: ["src/release/terraform-collect.test.ts"] },
  { file: "src/release/cargo-package.ts", tests: ["src/release/cargo-package.test.ts"] },
  { file: "src/release/cargo-raw.ts", tests: ["src/release/cargo-raw.test.ts"] },
];
const typescript: [label: string, file: string, before: string, after: string][] = [
  ["provider length", "src/lib/config.ts", "provider_name: z.string().max(64)", "provider_name: z.string()"],
  ["provider grammar", "src/lib/config.ts", '.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])/u, "provider_name must be lowercase alphanumeric with single internal hyphens")', ""],
  ["unknown provider fields", "src/lib/config.ts", 'z.strictObject({\n    build_type: z.literal("terraform-provider")', 'z.object({\n    build_type: z.literal("terraform-provider")'],
  ["provider required", "src/lib/config.ts", '"provider_name must be lowercase alphanumeric with single internal hyphens"),', '"provider_name must be lowercase alphanumeric with single internal hyphens").optional(),'],
  ["planning metadata", "src/release/plan.ts", 'input.release.build_type === "terraform-provider" && version.includes("+")', "false"],
  ["serialized metadata", "src/release/plan-schema.ts", 'plan.release.build_type !== "terraform-provider" || !plan.version.includes("+")', "true"],
  ["public verification required", "src/release/publish.ts", 'if (!input.terraform) throw new Rejection("Terraform publication requires the verified public key and source timestamp");', ""],
  ["publication revalidation", "src/release/publish.ts", 'if (plan.release.build_type === "terraform-provider")', "if (false)"],
  ["asset revalidation", "src/release/assets.ts", 'if (release?.build_type === "terraform-provider")', "if (false)"],
];
const typescriptTests = ["src/lib/config.test.ts", "src/release/plan.test.ts", "src/release/publish.test.ts", "src/release/assets.test.ts"];

const transpiler = new Bun.Transpiler({ loader: "ts" });

// Finds the first argument of every `ensure(` call; brackets and string literals are balanced so commas inside them are skipped.
function guardConditions(text: string): { line: number; start: number; end: number }[] {
  const found: { line: number; start: number; end: number }[] = [];
  for (const match of text.matchAll(/\bensure\(/gu)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    let end = -1;
    for (let index = start; index < text.length && end < 0; index += 1) {
      const char = text[index]!;
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = "";
      } else if (char === "\"" || char === "'" || char === "`") quote = char;
      else if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) depth -= 1;
      else if (char === "," && depth === 1) end = index;
      if (depth === 0) break;
    }
    if (end < 0) throw new Error(`cannot find the condition of the ensure call at offset ${match.index}`);
    found.push({ line: text.slice(0, start).split("\n").length, start, end });
  }
  return found;
}

const workspace = mkdtempSync(join(tmpdir(), "csm-ci-terraform-mutant-"));
const survivors: string[] = [];
let count = 0;

function run(tests: string[]): { passed: boolean; timedOut: boolean; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "test", ...tests], { cwd: workspace, timeout: TIMEOUT_MS, stdout: "pipe", stderr: "pipe" });
  return { passed: result.exitCode === 0, timedOut: result.signalCode !== null && result.signalCode !== undefined, stderr: result.stderr.toString() };
}

function report(label: string, result: { passed: boolean; timedOut: boolean }): void {
  count += 1;
  if (result.passed) survivors.push(label);
  console.log(`${result.passed ? "SURVIVED" : result.timedOut ? "killed (timeout)" : "killed"} ${label}`);
}

function mutate(relative: string, tests: string[], edit: (original: string) => { label: string; mutant: string }[]): void {
  const path = join(workspace, relative);
  const original = readFileSync(path, "utf8");
  for (const { label, mutant } of edit(original)) {
    try {
      writeFileSync(path, mutant);
      report(label, run(tests));
    } finally {
      writeFileSync(path, original);
    }
  }
}

try {
  for (const name of ["src"]) cpSync(join(root, name), join(workspace, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "bunfig.toml"]) {
    try { copyFileSync(join(root, name), join(workspace, name)); } catch { /* optional */ }
  }
  Bun.spawnSync(["ln", "-s", join(root, "node_modules"), join(workspace, "node_modules")]);

  for (const { file, tests } of guarded) {
    const baseline = run(tests);
    if (!baseline.passed) {
      process.stderr.write(baseline.stderr);
      throw new Error(`isolated mutation baseline failed for ${file}`);
    }
    mutate(file, tests, (original) => {
      return guardConditions(original).map(({ line, start, end }) => ({
        label: `${file}:${line}`,
        mutant: transpiler.transformSync(original.slice(0, start) + "true" + original.slice(end)) && original.slice(0, start) + "true" + original.slice(end),
      }));
    });
  }

  const baseline = run(typescriptTests);
  if (!baseline.passed) {
    process.stderr.write(baseline.stderr);
    throw new Error("isolated TypeScript mutation baseline failed");
  }
  for (const [label, file, before, after] of typescript) {
    mutate(file, typescriptTests, (original) => {
      if (original.split(before).length !== 2) throw new Error(`mutation no longer matches exactly once: ${label}`);
      return [{ label, mutant: original.replace(before, () => after) }];
    });
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`${count - survivors.length}/${count} rejection guards killed`);
if (survivors.length) process.exit(1);
