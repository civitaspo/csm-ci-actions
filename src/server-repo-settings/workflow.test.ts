import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

const outer = parse(readFileSync(".github/workflows/server-repo-settings.yml", "utf8")) as Record<string, unknown>;
const target = parse(readFileSync(".github/workflows/server-repo-settings-target.yml", "utf8")) as Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a mapping");
  return value as Record<string, unknown>;
}

describe("repo-settings reusable workflows", () => {
  test("product entry point exposes only workflow_call and derives the run mode from the event", () => {
    const triggers = record(outer.on);
    expect(Object.keys(triggers)).toEqual(["workflow_call"]);
    const workflowCall = record(triggers.workflow_call);
    const inputs = record(workflowCall.inputs);
    expect(inputs.repository).toBeDefined();
    expect(inputs).not.toHaveProperty("event-mode");
  });

  test("serializes client targets and gates the server target on the completed client wave", () => {
    const jobs = record(outer.jobs);
    const clients = record(jobs.clients);
    const strategy = record(clients.strategy);
    expect(strategy["max-parallel"]).toBe(1);
    expect(clients.needs).toBe("discover");
    const server = record(jobs.server);
    expect(server.needs).toEqual(["discover", "clients"]);
    // A failing client must not stall the server's own drift repair; the server still runs last.
    expect(server.if).toContain("needs.clients.result != 'cancelled'");
    expect(server.if).not.toContain("needs.clients.result == 'success'");
    expect(server.if).toContain("needs.discover.outputs.has-server == 'true'");
  });

  test("discovery token is metadata-only and mutations use separate least-privilege target tokens", () => {
    const discover = record(record(outer.jobs).discover);
    const discoverSteps = discover.steps as Record<string, unknown>[];
    const discoveryToken = discoverSteps.find((step) => step.id === "discovery-token");
    expect(discoveryToken).toBeDefined();
    const discoveryInputs = record(discoveryToken?.with);
    expect(discoveryInputs["permission-metadata"]).toBe("read");
    expect(discoveryInputs).not.toHaveProperty("permission-contents");
    expect(discoveryInputs).not.toHaveProperty("permission-administration");

    const reconcile = record(record(target.jobs).reconcile);
    const steps = reconcile.steps as Record<string, unknown>[];
    const admin = steps.find((step) => step.id === "admin-token");
    const content = steps.find((step) => step.id === "contents-token");
    const workflow = steps.find((step) => step.id === "workflow-token");
    expect(record(admin?.with)).toEqual(expect.objectContaining({ "permission-administration": "write" }));
    expect(record(admin?.with)).not.toHaveProperty("permission-contents");
    expect(record(content?.with)).toEqual(expect.objectContaining({ "permission-contents": "write", "permission-pull-requests": "write" }));
    expect(record(content?.with)).not.toHaveProperty("permission-workflows");
    expect(record(workflow?.with)).toHaveProperty("permission-workflows", "write");
    expect(workflow?.if).toContain("requires-workflows-write == 'true'");

    const names = steps.map((step) => step.id);
    expect(names.indexOf("admin-token")).toBeLessThan(names.indexOf("inspect"));
    expect(names.indexOf("inspect")).toBeLessThan(names.indexOf("preflight"));
    expect(names.indexOf("preflight")).toBeLessThan(names.indexOf("approver-token"));
    const read = steps.find((step) => step.id === "read-token");
    expect(record(read?.with)).not.toHaveProperty("permission-administration");
    for (const id of ["preflight", "approver-token"]) {
      expect(steps.find((step) => step.id === id)?.if).toContain("steps.inspect.outputs.activation-required == 'true'");
    }
    const inspect = record(steps.find((step) => step.id === "inspect")?.with);
    expect(inspect["admin-token"]).toBe("${{ steps.admin-token.outputs.token }}");
    expect(inspect).not.toHaveProperty("read-token");
    // Settings apply before managed files, so a rejected managed branch cannot block them.
    expect(steps.findIndex((step) => step.name === "Apply repository settings")).toBeLessThan(names.indexOf("managed-inspect"));
    const apply = steps.find((step) => step.name === "Apply repository settings");
    expect(record(apply?.with)["approver-app-slug"]).toBe("${{ steps.approver-token.outputs.app-slug }}");
  });

  test("every action adapter stage reads pinned config and gets the real workflow repository", () => {
    const workflowFiles = [outer, target];
    const adapterUses = workflowFiles.flatMap((workflow) => Object.values(record(workflow.jobs)).flatMap((job) => {
      if ("steps" in record(job) && Array.isArray(record(job).steps)) return record(job).steps as Record<string, unknown>[];
      return [];
    })).filter((step) => step.uses === "./.csm-ci-actions/actions/server/repo-settings");
    expect(adapterUses.length).toBeGreaterThan(0);
    for (const step of adapterUses) {
      const inputs = record(step.with);
      expect(inputs["github-token"]).toBe("${{ github.token }}");
      expect(inputs["actions-repository"]).toBe("${{ job.workflow_repository }}");
    }
  });

  test("the target helper receives mode as an internal input and has no public event trigger", () => {
    const triggers = record(target.on);
    expect(Object.keys(triggers)).toEqual(["workflow_call"]);
    const inputs = record(record(triggers.workflow_call).inputs);
    expect(inputs["event-mode"]).toBeDefined();
  });
});
