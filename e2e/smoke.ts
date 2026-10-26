import { assert, CLIENT, dispatch, expectServer, type Scenario, SERVER, smokeRequest } from "./harness.ts";
import { splitRepository } from "../src/lib/github.ts";

export const smoke: Scenario[] = [
  {
    id: "smoke.request-1",
    cases: {},
    name: "server and approver apps are installed with the planned permissions",
    run: async (ctx) => {
      const run = await dispatch(ctx, SERVER, "csm-ci-probe.yml");
      assert(run.conclusion === "success", `server probe concluded ${run.conclusion} (${run.html_url})`);
    },
  },
  {
    id: "smoke.request-2",
    cases: {},
    name: "client app is installed only on the server repository",
    run: async (ctx) => {
      const run = await dispatch(ctx, CLIENT, "csm-ci-probe.yml");
      assert(run.conclusion === "success", `client probe concluded ${run.conclusion} (${run.html_url})`);
    },
  },
  {
    id: "smoke.request-3",
    cases: {},
    name: "the server check validates csm-ci.yaml and lints the server workflows",
    run: async (ctx) => {
      const run = await dispatch(ctx, SERVER, "csm-ci-check.yml");
      assert(run.conclusion === "success", `server check concluded ${run.conclusion} (${run.html_url})`);
    },
  },
  {
    id: "smoke.request-4",
    cases: {},
    name: "a client app label passes intake and is deleted",
    run: async (ctx) => {
      const request = await smokeRequest(ctx, "policy-check", "1");
      await expectServer(ctx, { kind: "policy-check", repository: CLIENT, args: { pull_number: 1 }, label: request.label }, request.since, "success", "success", /accepted policy-check for civitaspo\/testing-csm-ci-client \{"pull_number":1\}/);
    },
  },
  {
    id: "smoke.request-5",
    cases: {},
    name: "a request label created by a human skips intake and is deleted",
    run: async (ctx) => {
      const since = new Date(Date.now() - 2_000);
      const name = `csm-ci-approve-human${Date.now().toString(36)}`;
      await ctx.gh.rest.issues.createLabel({ ...splitRepository(SERVER), name, description: `${CLIENT}/1` });
      await expectServer(ctx, { kind: "approve", repository: CLIENT, args: { pull_number: 1 }, label: name }, since, "skipped", "skipped");
    },
  },
];
