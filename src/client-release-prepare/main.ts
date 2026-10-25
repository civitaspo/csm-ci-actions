import * as core from "@actions/core";
import { prepareRelease } from "./prepare.ts";

try {
  const version = await prepareRelease({
    workspace: core.getInput("workspace", { required: true }),
    updateRootVersion: core.getInput("update-root-version") === "" ? true : core.getBooleanInput("update-root-version"),
    ...(core.getInput("version") ? { version: core.getInput("version") } : {}),
  });
  core.setOutput("version", version);
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
