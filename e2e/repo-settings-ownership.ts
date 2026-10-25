import { z } from "zod";

export type CreatedRuleset = { repository: string; id: number; name: string };

const RECORD_PREFIX = "created-repo-settings-ruleset ";
const RecordLine = new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}T\\S+(?:\\s+INFO)?\\s+)?${RECORD_PREFIX}(.+)$`, "u");
const CreatedRulesetRecordSchema = z.object({
  repository: z.string(),
  id: z.number().int().positive().refine(Number.isSafeInteger),
  name: z.string().min(1),
});
type CreatedRulesetRecord = z.infer<typeof CreatedRulesetRecordSchema>;

export function parseCreatedRulesets(log: string, repository: string): { rulesets: CreatedRuleset[]; errors: string[] } {
  const rulesets: CreatedRuleset[] = [];
  const errors: string[] = [];
  for (const line of log.split("\n")) {
    const match = RecordLine.exec(line);
    if (!match) continue;
    let record: unknown;
    try {
      record = JSON.parse(match[1]!);
    } catch {
      errors.push("invalid created ruleset record in " + repository);
      continue;
    }
    const parsed = CreatedRulesetRecordSchema.safeParse(record);
    if (!parsed.success || parsed.data.repository !== repository) {
      errors.push("created ruleset record does not match " + repository);
      continue;
    }
    const valid: CreatedRulesetRecord = parsed.data;
    rulesets.push({ repository: valid.repository, id: valid.id, name: valid.name });
  }
  return { rulesets, errors };
}

export function rulesetCleanupPlan<T extends { id: number }>(
  current: readonly T[],
  originalIds: ReadonlySet<number>,
  createdIds: ReadonlySet<number>,
): { deleteIds: number[]; errors: string[] } {
  const deleteIds: number[] = [];
  const errors: string[] = [];
  for (const { id } of current) {
    if (originalIds.has(id)) continue;
    if (createdIds.has(id)) deleteIds.push(id);
    else errors.push(`ruleset ${id} was not created by this e2e run; refusing deletion`);
  }
  return { deleteIds, errors };
}
