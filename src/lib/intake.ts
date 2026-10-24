import { type GitHub, loadConfig, verifyLiveLabel } from "./github.ts";
import { LabelEventSchema, type Request, validateIntake } from "./request.ts";

export type IntakeInput = { event: unknown; repository: string; sha: string; repositoryId: number; runAttempt: number; configPath: string };

export async function runIntake(gh: GitHub, input: IntakeInput): Promise<Request> {
  const event = LabelEventSchema.parse(input.event);
  const config = await loadConfig(gh, input.repository, input.sha, input.configPath);
  const request = validateIntake(event, { repositoryId: input.repositoryId, runAttempt: input.runAttempt }, config);
  await verifyLiveLabel(gh, config.server_repository, request.label, event.label.description ?? "");
  return request;
}
