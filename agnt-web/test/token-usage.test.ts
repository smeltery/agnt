// Token-usage extractor + formatters. The bridge publishes the same
// payload under several alias keys (Codex camelCase, Claude snake_case,
// nested under `tokenUsage` / `info`), so the extractor must handle the
// full surface or the assistant-row chip silently drops on real traffic.

import { describe, expect, it } from "vitest";
import {
  extractTurnTokenUsage,
  formatCostUsd,
  formatTokens,
  totalTokens,
} from "../src/lib/token-usage";

describe("extractTurnTokenUsage", () => {
  it("returns null for missing / empty payloads", () => {
    expect(extractTurnTokenUsage(null)).toBeNull();
    expect(extractTurnTokenUsage(undefined)).toBeNull();
    expect(extractTurnTokenUsage({})).toBeNull();
    // Both counts zero — caller should treat as no-data, not zero-tokens.
    expect(extractTurnTokenUsage({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("parses the bridge's camelCase shape", () => {
    expect(
      extractTurnTokenUsage({
        threadId: "t",
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 340,
          cachedInputTokens: 800,
          cachedCreationInputTokens: 0,
          totalCostUsd: 0.0182,
        },
      })
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
      totalCostUsd: 0.0182,
    });
  });

  it("parses the snake_case fallback some providers send", () => {
    expect(
      extractTurnTokenUsage({
        usage: {
          input_tokens: 50,
          output_tokens: 75,
          cache_read_input_tokens: 20,
          total_cost_usd: 0.001,
        },
      })
    ).toEqual({
      inputTokens: 50,
      outputTokens: 75,
      cachedInputTokens: 20,
      totalCostUsd: 0.001,
    });
  });

  it("returns null totalCostUsd when the provider doesn't surface it", () => {
    const usage = extractTurnTokenUsage({ inputTokens: 10, outputTokens: 20 });
    expect(usage).not.toBeNull();
    expect(usage!.totalCostUsd).toBeNull();
  });
});

describe("formatTokens", () => {
  it("formats small counts as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(123)).toBe("123");
    expect(formatTokens(999)).toBe("999");
  });
  it("formats thousands with one decimal until 100k", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_500)).toBe("45.5k");
    expect(formatTokens(99_900)).toBe("99.9k");
  });
  it("formats >=100k without decimals", () => {
    expect(formatTokens(100_000)).toBe("100k");
    expect(formatTokens(450_000)).toBe("450k");
  });
  it("formats millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("formatCostUsd", () => {
  it("hides nothing-cost", () => {
    expect(formatCostUsd(0)).toBe("$0");
  });
  it("renders sub-cent costs as `<$0.01`", () => {
    expect(formatCostUsd(0.0001)).toBe("<$0.01");
  });
  it("renders pennies with three decimals", () => {
    expect(formatCostUsd(0.012)).toBe("$0.012");
  });
  it("renders dollars with two decimals", () => {
    expect(formatCostUsd(2.345)).toBe("$2.35");
  });
});

describe("totalTokens", () => {
  it("sums input + output (cached not double-counted)", () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, totalCostUsd: null })).toBe(150);
  });
});
