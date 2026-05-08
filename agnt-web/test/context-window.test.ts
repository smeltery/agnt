import { describe, expect, it } from "vitest";
import { extractContextWindowUsage, fractionUsed } from "../src/models";

describe("extractContextWindowUsage", () => {
  it("reads camelCase keys", () => {
    expect(extractContextWindowUsage({ tokensUsed: 200, tokenLimit: 1000 })).toEqual({ tokensUsed: 200, tokenLimit: 1000 });
  });

  it("reads snake_case keys", () => {
    expect(extractContextWindowUsage({ tokens_used: 200, token_limit: 1000 })).toEqual({ tokensUsed: 200, tokenLimit: 1000 });
  });

  it("derives the limit from used + remaining when no explicit limit is sent", () => {
    expect(extractContextWindowUsage({ tokensUsed: 100, tokensRemaining: 900 })).toEqual({ tokensUsed: 100, tokenLimit: 1000 });
  });

  it("clamps used at the limit and returns null without enough info", () => {
    expect(extractContextWindowUsage({ tokensUsed: 5000, tokenLimit: 1000 })).toEqual({ tokensUsed: 1000, tokenLimit: 1000 });
    expect(extractContextWindowUsage({ tokensUsed: 100 })).toBeNull();
    expect(extractContextWindowUsage(null)).toBeNull();
  });

  it("digs into nested .info / .usage sub-objects (bridge sometimes wraps)", () => {
    expect(
      extractContextWindowUsage({ threadId: "t", info: { tokensUsed: 50, tokenLimit: 100 } })
    ).toEqual({ tokensUsed: 50, tokenLimit: 100 });
  });

  it("computes fractionUsed", () => {
    expect(fractionUsed({ tokensUsed: 250, tokenLimit: 1000 })).toBeCloseTo(0.25);
    expect(fractionUsed({ tokensUsed: 0, tokenLimit: 0 })).toBe(0);
  });
});
