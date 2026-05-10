// Unified-diff parser + side-by-side splitter. The parser tracks left /
// right line numbers off `@@` hunk markers; the splitter zips
// remove/add runs into 1:1 pairs and pads the shorter side.

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, splitUnifiedDiff } from "../src/lib/diff-split";

const SAMPLE = [
  "diff --git a/foo.ts b/foo.ts",
  "index 0000000..1111111 100644",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,3 +1,3 @@",
  " context-a",
  "-removed",
  "+added",
  " context-b",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("returns [] for an empty body", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("strips header metadata (diff/index/---/+++)", () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines.find((line) => line.text.startsWith("diff --git"))).toBeUndefined();
    expect(lines.find((line) => line.text.startsWith("index "))).toBeUndefined();
    expect(lines.find((line) => line.text.startsWith("--- "))).toBeUndefined();
    expect(lines.find((line) => line.text.startsWith("+++ "))).toBeUndefined();
  });

  it("emits hunk + context + remove + add in order with correct line numbers", () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", leftNumber: 1, rightNumber: 1, text: "context-a" },
      { kind: "remove", leftNumber: 2, text: "removed" },
      { kind: "add", rightNumber: 2, text: "added" },
      { kind: "context", leftNumber: 3, rightNumber: 3, text: "context-b" },
    ]);
  });

  it("ignores `\\ No newline at end of file`", () => {
    const diff = "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n";
    const lines = parseUnifiedDiff(diff);
    expect(lines.find((line) => line.text.includes("No newline"))).toBeUndefined();
  });

  it("treats a leading-space-less blank line as context", () => {
    // Some diff producers emit truly blank context lines (no leading space)
    // — the parser should still count them so line numbers stay aligned.
    const diff = "@@ -1,2 +1,2 @@\n line1\n\n";
    const lines = parseUnifiedDiff(diff);
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", leftNumber: 1, rightNumber: 1, text: "line1" },
      { kind: "context", leftNumber: 2, rightNumber: 2, text: "" },
    ]);
  });
});

describe("splitUnifiedDiff", () => {
  it("zips a 1:1 edit shape", () => {
    const rows = splitUnifiedDiff(SAMPLE);
    expect(rows).toHaveLength(4); // hunk + context + edit-pair + context
    const editPair = rows[2];
    expect(editPair.left?.text).toBe("removed");
    expect(editPair.right?.text).toBe("added");
  });

  it("pads the shorter side when removes outnumber adds", () => {
    const diff = "@@ -1,3 +1,1 @@\n-a\n-b\n-c\n+x\n";
    const rows = splitUnifiedDiff(diff);
    // hunk row + 3 zipped pairs (a/x, b/blank, c/blank).
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({
      left: { kind: "remove", leftNumber: 1, text: "a" },
      right: { kind: "add", rightNumber: 1, text: "x" },
    });
    expect(rows[2].right?.kind).toBe("blank");
    expect(rows[3].right?.kind).toBe("blank");
  });

  it("pads the shorter side when adds outnumber removes", () => {
    const diff = "@@ -1,1 +1,3 @@\n-a\n+x\n+y\n+z\n";
    const rows = splitUnifiedDiff(diff);
    expect(rows).toHaveLength(4);
    expect(rows[2].left?.kind).toBe("blank");
    expect(rows[3].left?.kind).toBe("blank");
    expect(rows[1].right?.text).toBe("x");
    expect(rows[3].right?.text).toBe("z");
  });

  it("emits a left-blank row for a bare addition (no preceding removes)", () => {
    const diff = "@@ -0,0 +1,1 @@\n+new line\n";
    const rows = splitUnifiedDiff(diff);
    expect(rows[1].left?.kind).toBe("blank");
    expect(rows[1].right?.text).toBe("new line");
  });

  it("repeats context lines on both sides", () => {
    const rows = splitUnifiedDiff("@@ -1,1 +1,1 @@\n same\n");
    expect(rows[1].left?.text).toBe("same");
    expect(rows[1].right?.text).toBe("same");
  });
});
