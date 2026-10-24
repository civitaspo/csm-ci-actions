import { type Config, type Release, repositoryEntry } from "./config.ts";
import { type GitHub, loadConfig, verifyLiveLabel } from "./github.ts";
import { LabelEventSchema, type Request, validateIntake } from "./request.ts";

export type IntakeInput = { event: unknown; repository: string; sha: string; repositoryId: number; runAttempt: number; configPath: string };

export type IntakeResult = { request: Request; release: Release | undefined; serverBotId: number };

export async function runIntake(gh: GitHub, input: IntakeInput): Promise<IntakeResult> {
  const event = LabelEventSchema.parse(input.event);
  const config = await loadConfig(gh, input.repository, input.sha, input.configPath);
  const request = validateIntake(event, { repositoryId: input.repositoryId, runAttempt: input.runAttempt }, config);
  await verifyLiveLabel(gh, config.server_repository, request.label, event.label.description ?? "");
  return { request, release: request.kind === "release" ? repositoryRelease(config, request.repository) : undefined, serverBotId: config.apps.server_bot_id };
}

function repositoryRelease(config: Config, repository: string): Release {
  const entry = repositoryEntry(config, repository);
  if (!entry?.release) throw new Error(`release configuration for ${repository} disappeared after intake validation`);
  return entry.release;
}
