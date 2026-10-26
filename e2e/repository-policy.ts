import { stringify } from "yaml";
import { parseConfig, type Config } from "../src/lib/config.ts";
import { assert, CLIENT, type Ctx, withServerConfig } from "./harness.ts";

type RepositoryPolicy = Pick<Config["repositories"][number], "sensitive_paths" | "merge">;

export async function withRepositoryPolicy(ctx: Ctx, override: RepositoryPolicy, run: () => Promise<void>): Promise<void> {
  await withServerConfig(ctx, (text) => {
    const config = parseConfig(text);
    const entry = config.repositories.find((entry) => entry.name === CLIENT.toLowerCase());
    assert(entry, "the client fixture must have an exact repository entry");
    config.repositories.unshift({ ...entry, ...override });
    return stringify(config);
  }, run);
}
