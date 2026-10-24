import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { parseConfig } from "../lib/config.ts";

try {
  const path = core.getInput("path", { required: true });
  const config = parseConfig(readFileSync(path, "utf8"));
  core.info(`${path} is valid: ${config.repositories.length} repository entries for ${config.owners.join(", ")}`);
} catch (e) {
  core.setFailed(e instanceof Error ? e.message : String(e));
}
