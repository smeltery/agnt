// Find/replace primitives. These power the composer's find bar; the test
// covers the cases where naive implementations go wrong: case-insensitive
// matching, non-overlapping advance, replace-all walking back-to-front so
// shifting indices don't corrupt the result.

import { describe, expect, it } from "vitest";
import { findAllOccurrences, replaceAll, replaceAt } from "../src/lib/draft-find-replace";

describe("findAllOccurrences", () => {
  it("returns empty for an empty needle", () => {
    expect(findAllOccurrences("hello", "")).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(findAllOccurrences("Hello hello HELLO", "hello")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("does not allow overlapping matches", () => {
    // "aa" in "aaaa" — naive impl returns 3 overlapping; we want 2.
    expect(findAllOccurrences("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("returns empty when needle isn't present", () => {
    expect(findAllOccurrences("hello", "world")).toEqual([]);
  });
});

describe("replaceAt", () => {
  it("replaces a single span", () => {
    expect(replaceAt("the quick brown fox", { start: 4, end: 9 }, "lazy")).toBe("the lazy brown fox");
  });

  it("handles empty replacement (delete)", () => {
    expect(replaceAt("abc", { start: 1, end: 2 }, "")).toBe("ac");
  });
});

describe("replaceAll", () => {
  it("counts and replaces every occurrence", () => {
    const out = replaceAll("foo bar foo", "foo", "baz");
    expect(out).toEqual({ text: "baz bar baz", count: 2 });
  });

  it("walks back-to-front so length-changing replacements don't corrupt later spans", () => {
    // "ab" → "abcdefg" — naive forward walk would re-match the new 'ab'.
    const out = replaceAll("ab ab", "ab", "abcdefg");
    expect(out.count).toBe(2);
    expect(out.text).toBe("abcdefg abcdefg");
  });

  it("preserves the source casing in the surrounding text", () => {
    const out = replaceAll("Hello WORLD", "world", "earth");
    // Replace honors the original-text casing of non-matched parts.
    expect(out.text).toBe("Hello earth");
    expect(out.count).toBe(1);
  });

  it("is a no-op when needle is empty", () => {
    expect(replaceAll("abc", "", "x")).toEqual({ text: "abc", count: 0 });
  });
});
