// Block math ($$...$$ on its own line) gets lexed as a `math` block;
// other dollar-sign uses (prose like "$5 and $10") don't.

import { describe, expect, it } from "vitest";
import { lexMarkdownBlocks } from "../src/components/chat/markdown-blocks";

describe("lexMarkdownBlocks — math", () => {
  it("captures a `$$...$$` block with body lines verbatim", () => {
    const blocks = lexMarkdownBlocks("$$\nx^2 + y^2 = z^2\n$$\n");
    expect(blocks).toEqual([{ kind: "math", body: "x^2 + y^2 = z^2" }]);
  });

  it("captures multi-line block math (joined with newlines)", () => {
    const blocks = lexMarkdownBlocks("$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "math" });
    expect(blocks[0]).toHaveProperty("body");
    expect(((blocks[0] as { body: string }).body)).toContain("\\begin{align}");
    expect(((blocks[0] as { body: string }).body)).toContain("\\end{align}");
  });

  it("doesn't intercept `$$` mid-paragraph (only on its own line)", () => {
    const blocks = lexMarkdownBlocks("Inline $$x^2$$ here.\n");
    expect(blocks).toEqual([{ kind: "paragraph", text: "Inline $$x^2$$ here." }]);
  });

  it("leaves prose dollar amounts alone", () => {
    const blocks = lexMarkdownBlocks("I have $5 and $10 in my wallet.\n");
    expect(blocks).toEqual([{ kind: "paragraph", text: "I have $5 and $10 in my wallet." }]);
  });

  it("handles a block that ends without a closing $$ (no infinite loop)", () => {
    // Same shape as the fenced-code-block fallback: an unterminated block
    // captures everything to EOF as the body. The trailing newline from
    // the source ends up in the body too — that mirrors the fence
    // parser's behavior; both are consistent.
    const blocks = lexMarkdownBlocks("$$\nunterminated\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("math");
    expect((blocks[0] as { body: string }).body).toContain("unterminated");
  });

  it("preserves order around adjacent paragraphs", () => {
    const source = "Before.\n\n$$\nfoo\n$$\n\nAfter.\n";
    const blocks = lexMarkdownBlocks(source);
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Before." },
      { kind: "math", body: "foo" },
      { kind: "paragraph", text: "After." },
    ]);
  });
});
