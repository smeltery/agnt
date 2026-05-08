// Word-token diff: token splitter keeps words intact and treats whitespace
// + punctuation as their own tokens; the LCS pass marks differing tokens.

import { describe, expect, it } from "vitest";
import { diffWordTokens, tokenize } from "../src/lib/diff-word-tokens";

describe("tokenize", () => {
  it("splits a simple identifier from punctuation", () => {
    expect(tokenize("foo()")).toEqual(["foo", "(", ")"]);
  });

  it("keeps multi-word phrases as separate tokens", () => {
    expect(tokenize("hello world")).toEqual(["hello", " ", "world"]);
  });

  it("treats whitespace runs as one token", () => {
    expect(tokenize("a   b")).toEqual(["a", "   ", "b"]);
  });

  it("handles unicode word characters", () => {
    expect(tokenize("café-bar")).toEqual(["café", "-", "bar"]);
  });

  it("treats numbers as words", () => {
    expect(tokenize("count = 42")).toEqual(["count", " ", "=", " ", "42"]);
  });

  it("returns empty for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("diffWordTokens", () => {
  it("highlights only the changed identifier", () => {
    const { removed, added } = diffWordTokens("const foo = 1", "const bar = 1");
    // Same ambient text on both sides; only `foo` and `bar` should differ.
    expect(removed.find((t) => t.text === "foo")?.change).toBe("removed");
    expect(removed.find((t) => t.text === "const")?.change).toBe("same");
    expect(removed.find((t) => t.text === "1")?.change).toBe("same");
    expect(added.find((t) => t.text === "bar")?.change).toBe("added");
    expect(added.find((t) => t.text === "const")?.change).toBe("same");
  });

  it("returns empty token streams for empty inputs", () => {
    expect(diffWordTokens("", "")).toEqual({ removed: [], added: [] });
  });

  it("flags every removed token when the addition is empty", () => {
    const { removed, added } = diffWordTokens("foo bar", "");
    expect(removed.every((t) => t.change === "removed")).toBe(true);
    expect(added).toEqual([]);
  });

  it("flags every added token when the removal is empty", () => {
    const { removed, added } = diffWordTokens("", "foo bar");
    expect(removed).toEqual([]);
    expect(added.every((t) => t.change === "added")).toBe(true);
  });

  it("highlights bracket-only swaps tightly", () => {
    const { removed, added } = diffWordTokens("(foo)", "[foo]");
    expect(removed.find((t) => t.text === "(")?.change).toBe("removed");
    expect(removed.find((t) => t.text === ")")?.change).toBe("removed");
    expect(removed.find((t) => t.text === "foo")?.change).toBe("same");
    expect(added.find((t) => t.text === "[")?.change).toBe("added");
    expect(added.find((t) => t.text === "]")?.change).toBe("added");
  });
});
