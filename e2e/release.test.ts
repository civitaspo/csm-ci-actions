import { testMetadata } from "./test-metadata.ts";
import { expect, test } from "bun:test";
import { github } from "../src/lib/github.ts";
import { CLIENT, SERVER, type Ctx } from "./harness.ts";
import { verifyAttestations } from "./release.ts";

test.each(["success", "failure"])("Terraform verification uses its public trust anchor without environment access (%s)", async (conclusion) => {
  const sha = "a".repeat(40);
  const tag = "v1.2.3";
  let inputs: Record<string, string> = {};
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/environments/")) {
      return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
    }
    const workflow = `/repos/${SERVER}/actions/workflows/csm-ci-release-verify.yml`;
    if (url.pathname === `${workflow}/dispatches`) {
      inputs = JSON.parse(String(init?.body)).inputs;
      return new Response(null, { status: 204 });
    }
    const run = { id: 456, html_url: "https://example.test/run/456", status: "completed", conclusion, created_at: new Date().toISOString(), display_title: `csm-ci-release-verify ${inputs.correlation}` };
    if (url.pathname === `${workflow}/runs`) {
      const response = Response.json({ total_count: 1, workflow_runs: [run] });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    if (url.pathname === `/repos/${SERVER}/actions/runs/456`) return Response.json(run);
    throw new Error(`unexpected request: ${url.pathname}`);
  }, { preconnect: () => undefined });
  const ctx: Ctx = { gh: github("test", fetch), urls: [], untrusted: undefined, ...testMetadata };
  const verification = verifyAttestations(ctx, tag, sha, 123);
  if (conclusion === "success") await verification;
  else await expect(verification).rejects.toThrow("hosted attestation verification concluded failure");
  expect(inputs).toMatchObject({
    tag, merge_sha: sha, client_repository: CLIENT,
    signer_workflow: "civitaspo/csm-ci-actions/.github/workflows/server.yml",
    predicate_type: "https://github.com/civitaspo/csm-ci-actions/attestation/release/v1",
    terraform_signer_run: "123",
    terraform_fingerprint: "539BD45AF62991F6AB8F931BA00D8967015E154E",
  });
});
