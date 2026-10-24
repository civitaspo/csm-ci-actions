import { describe, expect, test } from "bun:test";
import { compareSemVer, parseSemVer } from "./semver.ts";

describe("parseSemVer", () => {
  test.each([
    ["0.0.0", true],
    ["1.2.3-rc.1+build.4", true],
    ["01.2.3", false],
    ["1.02.3", false],
    ["1.2", false],
    ["v1.2.3", false],
    ["1.2.3-01", false],
    ["1.2.3+", false],
  ])("parses %s", (version, valid) => {
    expect(parseSemVer(version) !== undefined).toBe(valid);
  });
});

describe("compareSemVer", () => {
  test.each([
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-1", 1],
    ["999999999999999999999.0.0", "999999999999999999998.99.99", 1],
    ["1.2.3+first", "1.2.3+second", 0],
  ])("compares %s with %s", (a, b, expected) => {
    expect(compareSemVer(parseSemVer(a)!, parseSemVer(b)!)).toBe(expected);
  });
});
