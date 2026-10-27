import { describe, expect, test } from "bun:test";
import { escapeHtml, receiptFooter } from "./notify.ts";

const context = {
  repository: "owner/client", pullNumber: 12, commentId: 9, head: "a".repeat(40),
  serverRun: { serverUrl: "https://github.example", repository: "owner/server", id: "9007199254740993", attempt: "2" },
};

describe("receiptFooter", () => {
  test("keeps request, short head, and exact server run attempt inside HTML links in one small footer", () => {
    expect(receiptFooter(context)).toBe(`<sub><a href="https://github.example/owner/client/pull/12#issuecomment-9">Request</a> · <a href="https://github.example/owner/client/commit/${context.head}">Head aaaaaaa</a> · <a href="https://github.example/owner/server/actions/runs/9007199254740993/attempts/2">Server run 9007199254740993, attempt 2</a></sub>`);
  });

  test("links the resulting squash commit separately from the requested head", () => {
    expect(receiptFooter({ ...context, mergeCommit: "c".repeat(40) })).toBe(`<sub><a href="https://github.example/owner/client/pull/12#issuecomment-9">Request</a> · <a href="https://github.example/owner/client/commit/${context.head}">Head aaaaaaa</a> · <a href="https://github.example/owner/client/commit/${"c".repeat(40)}">Squash commit ccccccc</a> · <a href="https://github.example/owner/server/actions/runs/9007199254740993/attempts/2">Server run 9007199254740993, attempt 2</a></sub>`);
  });

  test("escapes both HTML attribute and label contents", () => {
    const footer = receiptFooter({ ...context, repository: 'owner/repo" data-x="<&', serverRun: { ...context.serverRun, id: '<"&' } });
    expect(footer).toContain('owner/repo&quot; data-x=&quot;&lt;&amp;/pull/12');
    expect(footer).toContain('runs/&lt;&quot;&amp;/attempts/2');
    expect(footer).toContain('Server run &lt;&quot;&amp;, attempt 2');
    expect(footer).not.toContain('data-x="');
  });
});

test.each([
  ["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"],
])("escapes %s in receipt text", (input, escaped) => {
  expect(escapeHtml(input)).toBe(escaped);
});
