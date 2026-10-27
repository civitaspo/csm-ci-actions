// Root files release preparation can rewrite. The default omits herdr-plugin.toml to keep existing release PRs unchanged.
export const VERSION_FILES = ["package.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "dbt_project.yml", "herdr-plugin.toml"] as const;
export type VersionFile = (typeof VERSION_FILES)[number];
export const DEFAULT_VERSION_FILES: readonly VersionFile[] = ["package.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "dbt_project.yml"];

export const isVersionFile = (path: string): path is VersionFile => (VERSION_FILES as readonly string[]).includes(path);

// Returns the first reason an explicit list cannot be prepared, or undefined when it is valid.
export function versionFilesError(files: readonly string[]): string | undefined {
  for (const [index, path] of files.entries()) {
    if (!isVersionFile(path)) return `version file ${JSON.stringify(path)} is not supported`;
    if (files.indexOf(path) !== index) return `version file ${JSON.stringify(path)} is listed more than once`;
  }
  if (files.includes("Cargo.lock") && !files.includes("Cargo.toml")) return 'version file "Cargo.lock" requires "Cargo.toml"';
  return undefined;
}
