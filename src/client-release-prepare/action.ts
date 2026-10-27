import * as core from "@actions/core";
import { installGitCliff } from "./git-cliff.ts";
import { prepareRelease } from "./prepare.ts";

type Install = (input: { os: string; arch: string; tempDir: string }) => Promise<string>;

export async function runReleasePrepare(install: Install = installGitCliff): Promise<void> {
  try {
    const tempDir = process.env.RUNNER_TEMP;
    if (!tempDir) throw new Error("RUNNER_TEMP is required to install git-cliff");
    const gitCliff = await install({ os: process.env.RUNNER_OS ?? "", arch: process.env.RUNNER_ARCH ?? "", tempDir });
    const version = await prepareRelease({
      workspace: core.getInput("workspace", { required: true }),
      gitCliff,
      ...(core.getInput("version-files") ? { versionFiles: parseVersionFiles(core.getInput("version-files")) } : {}),
      ...(core.getInput("version") ? { version: core.getInput("version") } : {}),
    });
    core.setOutput("version", version);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

// The input is a JSON array of root-relative paths; an empty input keeps the default file set.
export function parseVersionFiles(input: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { parsed = undefined; }
  if (!Array.isArray(parsed) || !parsed.every((path) => typeof path === "string")) throw new Error("version-files must be a JSON array of strings");
  return parsed;
}
