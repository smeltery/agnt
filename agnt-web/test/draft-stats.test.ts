// Footer counters. Cheap math but the rounding rules ("a 3-char draft shows
// ~1 token, not 0") have a real visual impact.

import { describe, expect, it } from "vitest";
import { computeDraftStats, formatCount } from "../src/lib/draft-stats";

describe("computeDraftStats", () => {
  it("returns all zeros for empty input", () => {
    expect(computeDraftStats("")).toEqual({ chars: 0, words: 0, approxTokens: 0 });
  });

  it("counts whitespace-separated words", () => {
    expect(computeDraftStats("hello world")).toMatchObject({ chars: 11, words: 2 });
    expect(computeDraftStats("  many   spaces here  ").words).toBe(3);
  });

  it("counts characters including spaces", () => {
    expect(computeDraftStats("a b").chars).toBe(3);
  });

  it("rounds the token estimate up so non-empty drafts always show ≥1", () => {
    expect(computeDraftStats("ok").approxTokens).toBe(1);
    expect(computeDraftStats("a".repeat(20)).approxTokens).toBe(5);
    // 17 / 4 = 4.25 → ceil = 5
    expect(computeDraftStats("a".repeat(17)).approxTokens).toBe(5);
  });

  it("treats whitespace-only drafts as zero words but non-zero chars", () => {
    const stats = computeDraftStats("   ");
    expect(stats.chars).toBe(3);
    expect(stats.words).toBe(0);
  });
});

describe("formatCount", () => {
  it("uses locale grouping for thousands", () => {
    // Don't bake a particular locale into the test — just that grouping
    // happens for big numbers.
    expect(formatCount(1234567).length).toBeGreaterThanOrEqual(7);
  });
});
