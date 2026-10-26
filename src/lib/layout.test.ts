import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";

const stepSchema = z.object({
  id: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const actionSchema = z.object({
  runs: z.object({ using: z.string(), main: z.string().optional(), steps: z.array(stepSchema).optional() }),
});
const readYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));
const actions = {
  client: ["approve", "merge", "policy-check", "release-prepare", "release-publish", "securefix"],
  server: ["approve", "check-config", "intake", "merge", "policy-check", "release-assets", "release-build", "release-plan", "release-publish", "release-tag", "repo-settings", "securefix"],
};

describe("published action layout", () => {
  test("exposes only the planned actions at one level below each side", () => {
    expect(readdirSync("actions").sort()).toEqual(["client", "server"]);
    for (const [side, names] of Object.entries(actions)) {
      expect(readdirSync(`actions/${side}`).sort()).toEqual(names);
      for (const name of names) {
        const action = actionSchema.parse(readYaml(`actions/${side}/${name}/action.yml`));
        if (action.runs.using === "node24") expect(action.runs.main).toBe(`../../../dist/${side}-${name}.js`);
      }
    }
  });

  test("every locally referenced action exists", () => {
    const workflows = readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"));
    for (const workflow of workflows) {
      const text = readFileSync(`.github/workflows/${workflow}`, "utf8");
      for (const match of text.matchAll(/uses: \.\/\.csm-ci-actions\/(actions\/[^\s]+)/gu)) {
        actionSchema.parse(readYaml(`${match[1]}/action.yml`));
      }
    }
  });
});

const build = actionSchema.parse(readYaml("actions/server/release-build/action.yml"));
const buildSteps = build.runs.steps ?? [];

describe("release build boundary", () => {
  test.each(["", "unknown", "cargo; echo unsafe"])("rejects unsupported build type %s", (type) => {
    const validate = buildSteps[0]?.run;
    if (!validate) throw new Error("release build must validate the build type first");
    const result = spawnSync("bash", ["-e", "-c", validate], { env: { ...process.env, BUILD_TYPE: type }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unsupported release build type: ${type}`);
  });

  test("build implementations run only for their selected type and disable the tool cache", () => {
    for (const step of buildSteps.slice(1)) expect(step.if).toMatch(/^inputs\.build-type == '(none|js-action|goreleaser|cargo|cargo-raw|terraform-provider)'(?: \|\| inputs\.build-type == 'terraform-provider')?$/u);
    expect(buildSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.with?.["no-cache"]).toBe(true);
    expect(buildSteps.find((step) => step.uses?.startsWith("actions/setup-go@"))?.with?.cache).toBe(false);
  });

  test("the build job has no permissions, secrets or environment", () => {
    const workflow = z.object({ jobs: z.record(z.string(), z.record(z.string(), z.unknown())) }).parse(readYaml(".github/workflows/server.yml"));
    const job = workflow.jobs["release-build"];
    expect(job?.permissions).toEqual({});
    expect(job).not.toHaveProperty("environment");
    expect(job).not.toHaveProperty("secrets");
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|id-token|actions\/cache/u);
  });
});


describe("merge token boundary", () => {
  const workflow = z.object({ jobs: z.object({ op: z.object({ steps: z.array(stepSchema) }) }) }).parse(readYaml(".github/workflows/server.yml"));
  const steps = workflow.jobs.op.steps;

  test("mints the final merge token only after readiness with target repository write permissions", () => {
    const token = steps.find((step) => step.id === "merge-token");
    expect(token?.uses).toMatch(/^actions\/create-github-app-token@/u);
    expect(token?.if).toBe("needs.intake.outputs.kind == 'merge' && steps.merge-ready.outputs.ready == 'true'");
    expect(token?.with).toEqual({
      "client-id": "${{ vars.CSM_CI_SERVER_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}",
      owner: "${{ needs.intake.outputs.owner }}",
      repositories: "${{ needs.intake.outputs.name }}",
      "permission-contents": "write",
      "permission-pull-requests": "write",
      "permission-workflows": "write",
    });
    expect(steps.findIndex((step) => step.id === "merge-token")).toBeGreaterThan(steps.findIndex((step) => step.id === "merge-ready"));
    const merge = steps.find((step) => step.with?.mode === "merge");
    expect(merge?.with?.["write-token"]).toBe("${{ steps.merge-token.outputs.token }}");
    expect(merge?.with?.head).toBe("${{ steps.merge-ready.outputs.head }}");
  });

  test.each(["merge-read-token", "merge-notify-token", "merge-failure-notify-token", "merge-final-read-token", "merge-final-notify-token"])("keeps workflows permission off %s", (id) => {
    const token = steps.find((step) => step.id === id);
    expect(token).toBeDefined();
    expect(token?.with).not.toHaveProperty("permission-workflows");
    expect(token?.with?.["permission-contents"]).not.toBe("write");
  });
});
