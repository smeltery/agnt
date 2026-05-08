// Mention detection contract: caret-aware lookup, no false positives on
// emails (`name@host`), correct splice semantics on apply.

import { describe, expect, it } from "vitest";
import { applyMentionReplacement, detectMention } from "../src/lib/mention-detector";

describe("detectMention", () => {
  it("returns null when there is no @ before the caret", () => {
    expect(detectMention("hello world", 5)).toBeNull();
  });

  it("matches when the caret is right after a leading @", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("matches when typing a query token", () => {
    expect(detectMention("look at @comp", 13)).toEqual({ start: 8, end: 13, query: "comp" });
  });

  it("returns null inside an email-style address", () => {
    expect(detectMention("name@host", 9)).toBeNull();
  });

  it("returns null after a whitespace breaks the token", () => {
    expect(detectMention("@foo bar", 8)).toBeNull();
  });

  it("matches after an opener like a paren or bracket", () => {
    expect(detectMention("(@bar", 5)?.query).toBe("bar");
    expect(detectMention("[@baz", 5)?.query).toBe("baz");
  });
});

describe("applyMentionReplacement", () => {
  it("splices replacement + trailing space and returns caret position", () => {
    const ctx = { start: 8, end: 13, query: "comp" };
    const out = applyMentionReplacement("look at @comp", ctx, "src/Composer.tsx");
    expect(out.text).toBe("look at src/Composer.tsx ");
    expect(out.caret).toBe(out.text.length);
  });

  it("handles a mid-sentence mention with text after it", () => {
    const text = "see @x and tell me";
    const ctx = { start: 4, end: 6, query: "x" };
    const out = applyMentionReplacement(text, ctx, "path");
    expect(out.text).toBe("see path  and tell me");
  });
});
