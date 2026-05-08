import { describe, expect, it } from "vitest";
import { lexMarkdownBlocks } from "../src/components/chat/markdown-blocks";

describe("lexMarkdownBlocks", () => {
  it("treats consecutive non-empty lines as one paragraph", () => {
    const blocks = lexMarkdownBlocks("Hello\nworld\n\nNext.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Hello world" },
      { kind: "paragraph", text: "Next." },
    ]);
  });

  it("captures fenced code blocks verbatim, including blank lines inside", () => {
    const source = "Before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    const blocks = lexMarkdownBlocks(source);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ kind: "fence", language: "ts", body: "const a = 1;\n\nconst b = 2;" });
  });

  it("handles unclosed fenced code blocks (run to EOF)", () => {
    const blocks = lexMarkdownBlocks("```\nstill code");
    expect(blocks).toEqual([{ kind: "fence", language: null, body: "still code" }]);
  });

  it("decodes headings at every level", () => {
    const source = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n####### still 6";
    const blocks = lexMarkdownBlocks(source);
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "H1" },
      { kind: "heading", level: 2, text: "H2" },
      { kind: "heading", level: 3, text: "H3" },
      { kind: "heading", level: 4, text: "H4" },
      { kind: "heading", level: 5, text: "H5" },
      { kind: "heading", level: 6, text: "H6" },
      // 7+ hashes is still a level-6 heading per CommonMark; our regex caps at 6.
      { kind: "paragraph", text: "####### still 6" },
    ]);
  });

  it("groups consecutive bullet items into one list", () => {
    const source = "- alpha\n- beta\n- gamma";
    expect(lexMarkdownBlocks(source)).toEqual([
      { kind: "listBullet", items: ["alpha", "beta", "gamma"] },
    ]);
  });

  it("groups ordered items and remembers the start number", () => {
    expect(lexMarkdownBlocks("3. third\n4. fourth")).toEqual([
      { kind: "listOrdered", items: ["third", "fourth"], start: 3 },
    ]);
  });

  it("parses a basic table with default alignment", () => {
    const source = "| Name | Score |\n|------|-------|\n| Ada  | 100   |\n| Lin  | 88    |";
    const blocks = lexMarkdownBlocks(source);
    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["Name", "Score"],
        rows: [
          ["Ada", "100"],
          ["Lin", "88"],
        ],
        alignments: [null, null],
      },
    ]);
  });

  it("parses table column alignments from divider colons", () => {
    const source = "| L | C | R |\n|:---|:---:|---:|\n| a | b | c |";
    expect(lexMarkdownBlocks(source)[0]).toMatchObject({
      kind: "table",
      alignments: ["left", "center", "right"],
    });
  });

  it("falls back to paragraph when a table-shaped row has no divider", () => {
    expect(lexMarkdownBlocks("| not | really |\n| a | table |")).toEqual([
      { kind: "paragraph", text: "| not | really | | a | table |" },
    ]);
  });

  it("ignores fenced-code-like content inside an actual fenced block", () => {
    const source = "```\n## not a heading\n- not a bullet\n```";
    expect(lexMarkdownBlocks(source)).toEqual([
      { kind: "fence", language: null, body: "## not a heading\n- not a bullet" },
    ]);
  });

  it("collapses consecutive `>`-prefixed lines into one blockquote", () => {
    const source = "> first line\n> second line\n\nfollow-up";
    expect(lexMarkdownBlocks(source)).toEqual([
      { kind: "blockquote", text: "first line second line" },
      { kind: "paragraph", text: "follow-up" },
    ]);
  });

  it("strips `>` and exactly one optional space — preserves further indentation", () => {
    expect(lexMarkdownBlocks("> hi\n>nospace")).toEqual([
      { kind: "blockquote", text: "hi nospace" },
    ]);
  });

  it("recognizes --- / *** / ___ as horizontal rules", () => {
    expect(lexMarkdownBlocks("---")).toEqual([{ kind: "horizontal" }]);
    expect(lexMarkdownBlocks("***")).toEqual([{ kind: "horizontal" }]);
    expect(lexMarkdownBlocks("___")).toEqual([{ kind: "horizontal" }]);
    // Mixed runs should NOT match.
    expect(lexMarkdownBlocks("--*")).toEqual([{ kind: "paragraph", text: "--*" }]);
  });

  it("doesn't confuse a one-line table-divider with a horizontal rule (table needs the header row first)", () => {
    expect(lexMarkdownBlocks("---|---")).toEqual([{ kind: "paragraph", text: "---|---" }]);
  });

  it("blockquote terminator stops at a blank line, not at any other block kind", () => {
    expect(lexMarkdownBlocks("> q\n# heading after quote")).toEqual([
      { kind: "blockquote", text: "q" },
      { kind: "heading", level: 1, text: "heading after quote" },
    ]);
  });
});
