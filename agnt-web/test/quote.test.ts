// Reply/quote formatter contract: prefix every line with `> `, strip code
// fences so they don't reopen, truncate long passages.

import { describe, expect, it } from "vitest";
import { quoteAsMarkdown } from "../src/lib/quote";

describe("quoteAsMarkdown", () => {
  it("returns empty for empty input", () => {
    expect(quoteAsMarkdown("")).toBe("");
    expect(quoteAsMarkdown("   ")).toBe("");
  });

  it("prefixes every line with > (preserving blank lines as bare >)", () => {
    expect(quoteAsMarkdown("hello\n\nworld")).toBe("> hello\n>\n> world");
  });

  it("strips fenced-code markers so the quote can't reopen a fence", () => {
    const input = "see this:\n```ts\nconst x = 1;\n```\nnext";
    const out = quoteAsMarkdown(input);
    expect(out).not.toContain("```");
    expect(out).toContain("> const x = 1;");
  });

  it("truncates long quotes with an ellipsis suffix", () => {
    const long = "x".repeat(2000);
    const out = quoteAsMarkdown(long);
    expect(out.length).toBeLessThan(long.length + 10);
    expect(out.endsWith("…")).toBe(true);
  });
});
