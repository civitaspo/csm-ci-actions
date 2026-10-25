import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

type Step = { id?: string; if?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> };

const action = parse(readFileSync("actions/client/securefix/action.yml", "utf8")) as { inputs: Record<string, { required?: boolean }>; runs: { using: string; steps: Step[] } };
const steps = action.runs.steps;

describe("securefix client action", () => {
  test("takes the Client App credentials and server repository as required inputs", () => {
    for (const name of ["client-id", "private-key", "server-repository"]) expect(action.inputs[name]?.required).toBe(true);
  });

  test("packages, uploads, mints the token and requests, in that order, all in one composite action", () => {
    expect(action.runs.using).toBe("composite");
    const order = steps.map((step) => step.id ?? step.uses?.split("@")[0]);
    expect(order).toEqual(["package", "actions/upload-artifact", "token", "request"]);
  });

  test("uploads, mints and requests only when changes were packaged", () => {
    for (const step of steps.slice(1)) expect(step.if).toBe("steps.package.outputs.has-changes == 'true'");
  });

  test("passes the private key only to the official token action, which mints only issues:write", () => {
    const token = steps.find((step) => step.id === "token");
    expect(token?.uses?.startsWith("actions/create-github-app-token@")).toBe(true);
    expect(Object.keys(token?.with ?? {}).filter((key) => key.startsWith("permission-"))).toEqual(["permission-issues"]);
    expect(token?.with?.["permission-issues"]).toBe("write");
    for (const step of steps.filter((candidate) => candidate !== token)) {
      expect(JSON.stringify(step)).not.toContain("inputs.private-key");
    }
  });

  test("scopes the token to the server repository named by the package step", () => {
    const token = steps.find((step) => step.id === "token");
    expect(token?.with?.owner).toBe("${{ steps.package.outputs.server-owner }}");
    expect(token?.with?.repositories).toBe("${{ steps.package.outputs.server-name }}");
  });

  test("every package output the action reads is one main.ts sets", () => {
    const source = readFileSync("src/client-securefix/main.ts", "utf8");
    const referenced = [...readFileSync("actions/client/securefix/action.yml", "utf8").matchAll(/steps\.(package|request)\.outputs\.([a-z-]+)/gu)].map((match) => match[2]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of new Set(referenced)) expect(source).toContain(`core.setOutput("${name}"`);
  });

  test("the request step receives the minted token", () => {
    expect(steps.find((step) => step.id === "request")?.env?.INPUT_TOKEN).toBe("${{ steps.token.outputs.token }}");
  });
});

describe("release-pr reusable workflow", () => {
  test("generates and requests in one job through the securefix client action", () => {
    const workflow = parse(readFileSync(".github/workflows/client-release-prepare.yml", "utf8")) as { jobs: Record<string, { steps?: Step[] }> };
    expect(Object.keys(workflow.jobs)).toEqual(["generate"]);
    const client = workflow.jobs.generate?.steps?.find((step) => step.uses === "./.csm-ci-actions/actions/client/securefix");
    expect(client?.with?.["private-key"]).toBe("${{ secrets.CSM_CI_CLIENT_APP_PRIVATE_KEY }}");
  });
});
