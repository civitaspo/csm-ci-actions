import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { z } from "zod";

const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);

function workflow(path: string) {
  return record(parse(readFileSync(path, "utf8")));
}

const clientSecret = "CSM_CI_CLIENT_APP_PRIVATE_KEY";
const serverSecret = "CSM_CI_SERVER_APP_PRIVATE_KEY";
const approverSecret = "CSM_CI_APPROVER_APP_PRIVATE_KEY";
const providerSecrets = ["CSM_CI_TERRAFORM_PROVIDER_GPG_PRIVATE_KEY", "CSM_CI_TERRAFORM_PROVIDER_GPG_PASSPHRASE"];
const settingsContract = { [serverSecret]: { required: true }, [approverSecret]: { required: false } };
const serverContract = { ...settingsContract, ...Object.fromEntries(providerSecrets.map((name) => [name, { required: false }])) };
const contracts: [string, Record<string, { required: boolean }>][] = [
  ...["approve", "merge", "policy-check", "release-prepare", "release-publish"].map((name): [string, Record<string, { required: boolean }>] => [`client-${name}.yml`, { [clientSecret]: { required: true } }]),
  ["server.yml", serverContract],
  ["server-repo-settings.yml", settingsContract],
  ["server-repo-settings-target.yml", settingsContract],
  ["server-automerge.yml", { [serverSecret]: { required: true } }],
  ["server-automerge-evaluate.yml", { [serverSecret]: { required: true } }],
  ["server-check.yml", {}],
];

const mapping = (names: string[]) => Object.fromEntries(names.map((name) => [name, `\${{ secrets.${name} }}`]));

describe("explicit reusable workflow secret contracts", () => {
  test.each(contracts)("%s declares only its consumed or forwarded names", (name, expected) => {
    const call = record(record(workflow(`.github/workflows/${name}`).on).workflow_call);
    expect(call.secrets ?? {}).toEqual(expected);
  });

  test.each(["clients", "server"])("repo-settings forwards only server and approver names to %s", (name) => {
    const job = record(record(workflow(".github/workflows/server-repo-settings.yml").jobs)[name]);
    expect(job.secrets).toEqual(mapping([serverSecret, approverSecret]));
  });

  const fixtureRoots = ["testing-csm-ci-client", "testing-csm-ci-server"].map((name) => `e2e/fixtures/${name}/.github/workflows`);
  const callers = fixtureRoots.flatMap((directory) => readdirSync(directory).filter((name) => /\.yml$/u.test(name)).map((name) => join(directory, name)));
  test.each(callers)("fixture %s maps exactly the consumed names", (path) => {
    for (const rawJob of Object.values(record(workflow(path).jobs))) {
      const job = record(rawJob);
      if (typeof job.uses !== "string" || !job.uses.includes("/csm-ci-actions/.github/workflows/")) continue;
      const names = job.uses.includes("/client-") ? [clientSecret]
        : job.uses.includes("/server.yml@") ? [serverSecret, approverSecret, ...providerSecrets]
        : job.uses.includes("/server-automerge.yml@") ? [serverSecret]
        : job.uses.includes("/server-repo-settings") ? [serverSecret, approverSecret] : [];
      expect(job.secrets ?? {}).toEqual(mapping(names));
    }
  });

  test("privileged jobs retain the server environment while release builds have no credentials", () => {
    const server = record(workflow(".github/workflows/server.yml").jobs);
    for (const name of ["op", "release-plan", "release-publish"]) expect(record(server[name]).environment).toBe("csm-ci");
    const build = record(server["release-build"]);
    expect(build.environment).toBeUndefined();
    expect(build.permissions).toEqual({});
    expect(JSON.stringify(build)).not.toContain("secrets.");
    expect(record(record(workflow(".github/workflows/server-repo-settings.yml").jobs).discover).environment).toBe("csm-ci");
    expect(record(record(workflow(".github/workflows/server-repo-settings-target.yml").jobs).reconcile).environment).toBe("csm-ci");
  });

  test("approval key consumption remains limited to approval and manual activation", () => {
    const op = record(record(workflow(".github/workflows/server.yml").jobs).op);
    const steps = op.steps;
    if (!Array.isArray(steps)) throw new Error("expected steps");
    const approval = steps.map(record).find((step) => step.id === "approver-token");
    expect(approval?.if).toBe("needs.intake.outputs.kind == 'approve'");
    expect(record(approval?.with)["private-key"]).toBe("${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}");
    const reconcile = record(record(workflow(".github/workflows/server-repo-settings-target.yml").jobs).reconcile);
    if (!Array.isArray(reconcile.steps)) throw new Error("expected steps");
    const activation = reconcile.steps.map(record).find((step) => step.id === "approver-token");
    expect(activation?.if).toContain("steps.target.outputs.selects-rulesets == 'true'");
    expect(activation?.if).toContain("inputs.event-mode == 'dispatch'");
    expect(activation?.if).toContain("activation-required == 'true'");
    expect(record(activation?.with)["private-key"]).toBe("${{ secrets.CSM_CI_APPROVER_APP_PRIVATE_KEY }}");
    for (const step of [approval, activation]) expect(step?.uses).toBe("actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510");
  });
});
