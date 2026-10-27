import { repoSettingsManagedFiles, type RepoSettingsConfig } from "./config.ts";
import { splitRepository, type GitHub } from "./github.ts";
import { findTreeEntry, validateManagedFiles, validateManagedPath } from "./managed-files.ts";
import { Rejection } from "./request.ts";

export async function loadAdditionalManagedFiles(gh: GitHub, input: {
  repository: string;
  sha: string;
  settings: RepoSettingsConfig | undefined;
}): Promise<Record<string, string>> {
  const files: [string, string][] = [];
  const address = splitRepository(input.repository);
  for (const [destination, source] of Object.entries(input.settings?.additional_managed_files ?? {})) {
    validateManagedPath(destination);
    validateManagedPath(source);
    const entry = await findTreeEntry(gh, address.owner, address.repo, source, input.sha);
    if (!entry?.sha) throw new Rejection(`additional managed source ${JSON.stringify(source)} is missing`);
    const { data } = await gh.rest.git.getBlob({ ...address, file_sha: entry.sha });
    if (data.encoding !== "base64" || typeof data.content !== "string") throw new Rejection(`additional managed source ${JSON.stringify(source)} has malformed or unsupported Git blob encoding`);
    const encoded = data.content.replaceAll("\n", "");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Rejection(`additional managed source ${JSON.stringify(source)} has malformed or unsupported Git blob encoding`);
    try {
      files.push([destination, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)]);
    } catch {
      throw new Rejection(`additional managed source ${JSON.stringify(source)} is not UTF-8`);
    }
    validateManagedFiles(repoSettingsManagedFiles(input.settings, Object.fromEntries(files)));
  }
  return repoSettingsManagedFiles(input.settings, Object.fromEntries(files));
}
