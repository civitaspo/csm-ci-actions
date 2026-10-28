import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FEATURES } from "./pr-metadata.ts";

test("the /e2e workflow knows exactly the harness features", () => {
  const text = readFileSync(new URL("../.github/workflows/e2e-comment.yml", import.meta.url), "utf8");
  const known = /KNOWN_FEATURES: "([^"]+)"/.exec(text)?.[1]?.split(" ");
  expect(known).toEqual([...FEATURES]);
});
