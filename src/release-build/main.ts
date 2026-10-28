import { releaseBuild } from "../release/release-build.ts";

try {
  const output = releaseBuild(process.argv.slice(2));
  if (output) console.log(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
