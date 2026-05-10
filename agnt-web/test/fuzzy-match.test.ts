// Subsequence matcher contract: every query char must appear in order;
// match scoring rewards prefixes + word starts + consecutive runs; the
// returned indexes can be folded into highlight spans.

import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightSpans } from "../src/lib/fuzzy-match";

describe("fuzzyMatch", () => {
  it("returns a zero-score match for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indexes: [] });
  });

  it("returns null when not every char appears in order", () => {
    expect(fuzzyMatch("abc", "axyz")).toBeNull();
    expect(fuzzyMatch("ba", "ab")).toBeNull();
  });

  it("matches subsequences and records the indexes", () => {
    const match = fuzzyMatch("abc", "axbycz");
    expect(match).not.toBeNull();
    expect(match!.indexes).toEqual([0, 2, 4]);
  });

  it("scores prefix + word-start hits higher than mid-word hits", () => {
    const prefix = fuzzyMatch("op", "open file")!;
    const middle = fuzzyMatch("op", "stop")!;
    expect(prefix.score).toBeGreaterThan(middle.score);
  });

  it("scores consecutive matches higher than gappy ones", () => {
    const consecutive = fuzzyMatch("foo", "foobar")!;
    const gappy = fuzzyMatch("foo", "f-o-o-bar")!;
    expect(consecutive.score).toBeGreaterThan(gappy.score);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("foo", "FOObar")).not.toBeNull();
  });
});

describe("highlightSpans", () => {
  it("splits a haystack into matched + unmatched runs", () => {
    expect(highlightSpans("foobar", [0, 1, 2])).toEqual([
      { text: "foo", matched: true },
      { text: "bar", matched: false },
    ]);
  });

  it("interleaves runs", () => {
    expect(highlightSpans("axbycz", [0, 2, 4])).toEqual([
      { text: "a", matched: true },
      { text: "x", matched: false },
      { text: "b", matched: true },
      { text: "y", matched: false },
      { text: "c", matched: true },
      { text: "z", matched: false },
    ]);
  });

  it("returns the haystack as a single unmatched span when no indexes given", () => {
    expect(highlightSpans("hello", [])).toEqual([{ text: "hello", matched: false }]);
  });
});
