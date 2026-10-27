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
      updateRootVersion: core.getInput("update-root-version") === "" ? true : core.getBooleanInput("update-root-version"),
      ...(core.getInput("version") ? { version: core.getInput("version") } : {}),
    });
    core.setOutput("version", version);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
