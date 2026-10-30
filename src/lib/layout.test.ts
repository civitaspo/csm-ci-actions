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
  server: ["approve", "automerge", "check-config", "intake", "merge", "policy-check", "release-assets", "release-build", "release-plan", "release-publish", "release-tag", "repo-settings", "securefix"],
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

describe("release-prepare dependencies", () => {
  test("uses only official GitHub actions and installs git-cliff itself", () => {
    const prepare = actionSchema.parse(readYaml("actions/client/release-prepare/action.yml"));
    const external = (prepare.runs.steps ?? []).flatMap((step) => (step.uses ? [step.uses.split("@")[0]] : []));
    expect(external).toEqual(["actions/upload-artifact", "actions/create-github-app-token"]);
    expect(readFileSync("actions/client/release-prepare/action.yml", "utf8")).not.toMatch(/install-action|curl|wget/u);
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

  test("acceptance can write deployments on the server repository without client write permissions", () => {
    const token = steps.find((step) => step.id === "automerge-deployments-token");
    expect(token?.uses).toMatch(/^actions\/create-github-app-token@/u);
    expect(token?.if).toBe("needs.intake.outputs.kind == 'merge'");
    expect(token?.with).toEqual({
      "client-id": "${{ vars.CSM_CI_SERVER_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-deployments": "write",
    });
    const merge = steps.find((step) => step.with?.mode === "accept");
    expect(merge?.with?.["deployments-token"]).toBe("${{ steps.automerge-deployments-token.outputs.token }}");
    expect(merge?.with?.["server-token"]).toBe("${{ steps.merge-read-token.outputs.token }}");
    expect(merge?.with?.["notification-token"]).toBe("${{ steps.merge-notify-token.outputs.token }}");
  });

  test.each(["merge-read-token", "merge-notify-token", "automerge-deployments-token"])("keeps client merge permissions off %s", (id) => {
    const token = steps.find((step) => step.id === id);
    expect(token).toBeDefined();
    expect(token?.with).not.toHaveProperty("permission-workflows");
    expect(token?.with?.["permission-contents"]).not.toBe("write");
  });
});

test("automerge mints client write permissions only after readiness and pins the reservation and head", () => {
  const workflow = z.object({ jobs: z.object({ evaluate: z.object({ steps: z.array(stepSchema) }) }) }).parse(readYaml(".github/workflows/server-automerge-evaluate.yml"));
  const steps = workflow.jobs.evaluate.steps;
  const readToken = steps.find((step) => step.id === "read-token");
  expect(readToken?.with).toEqual({
    "client-id": "${{ vars.CSM_CI_SERVER_APP_CLIENT_ID }}",
    "private-key": "${{ secrets.CSM_CI_SERVER_APP_PRIVATE_KEY }}",
    owner: "${{ needs.resolve.outputs.repository-owner }}",
    repositories: "${{ needs.resolve.outputs.repository-name }}",
    "permission-contents": "read",
    "permission-pull-requests": "read",
    "permission-checks": "read",
    "permission-issues": "read",
  });
  expect(readToken?.with).not.toHaveProperty("permission-statuses");
  const token = steps.find((step) => step.id === "write-token");
  expect(token?.if).toBe("steps.readiness.outputs.ready == 'true'");
  expect(token?.with?.["permission-contents"]).toBe("write");
  expect(token?.with?.["permission-pull-requests"]).toBe("write");
  expect(token?.with?.["permission-workflows"]).toBe("write");
  const merge = steps.find((step) => step.with?.mode === "merge");
  expect(merge?.with?.["write-token"]).toBe("${{ steps.write-token.outputs.token }}");
  expect(merge?.with?.head).toBe("${{ steps.readiness.outputs.head }}");
  expect(merge?.with?.["deployment-id"]).toBe("${{ steps.readiness.outputs.deployment-id || inputs.deployment-id }}");
});

test("automerge resolves immutable repository identity before canonical concurrency and client tokens", () => {
  const workflow = z.object({
    jobs: z.object({
      resolve: z.object({
        outputs: z.record(z.string(), z.string()),
        steps: z.array(stepSchema),
      }),
      evaluate: z.object({
        needs: z.array(z.string()),
        if: z.string(),
        concurrency: z.object({ group: z.string() }),
        steps: z.array(stepSchema),
      }),
    }),
  }).parse(readYaml(".github/workflows/server-automerge-evaluate.yml"));
  const resolve = workflow.jobs.resolve;
  const evaluation = workflow.jobs.evaluate;
  expect(resolve.outputs).toMatchObject({
    resolved: "${{ steps.resolve.outputs.resolved }}",
    repository: "${{ steps.resolve.outputs.repository }}",
    "concurrency-key": "${{ steps.resolve.outputs.concurrency-key }}",
  });
  const resolveStep = resolve.steps.find((step) => step.id === "resolve");
  expect(resolveStep?.with?.mode).toBe("${{ inputs.repair && 'resolve-repair' || 'resolve' }}");
  expect(resolveStep?.with?.["deployment-id"]).toBe("${{ inputs.deployment-id }}");
  expect(evaluation.needs).toEqual(["resolve"]);
  expect(evaluation.if).toBe("needs.resolve.outputs.resolved == 'true'");
  expect(evaluation.concurrency.group).toBe("csm-ci-${{ needs.resolve.outputs.concurrency-key }}");
  expect(evaluation.steps.find((step) => step.id === "read-token")?.if).toBeUndefined();
  expect(evaluation.steps.find((step) => step.id === "read-token")?.with?.owner).toBe("${{ needs.resolve.outputs.repository-owner }}");
});
