import { describe, expect, test } from "bun:test";
import { parseAutomergePayload } from "./merge.ts";

describe("e2e deployment payload decoding", () => {
  const payload = { repository_id: 123, pull_number: 45 };

  test("accepts an object payload", () => {
    expect(parseAutomergePayload(payload)).toEqual(payload);
  });

  test("decodes a JSON string payload", () => {
    expect(parseAutomergePayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("decodes the double-encoded payload returned by GitHub GraphQL", () => {
    expect(parseAutomergePayload(JSON.stringify(JSON.stringify(payload)))).toEqual(payload);
  });

  test("stops after two decoding passes", () => {
    expect(parseAutomergePayload(JSON.stringify(JSON.stringify(JSON.stringify(payload))))).toBe(JSON.stringify(payload));
  });

  test("rejects malformed JSON", () => {
    expect(() => parseAutomergePayload("not JSON")).toThrow();
  });
});
