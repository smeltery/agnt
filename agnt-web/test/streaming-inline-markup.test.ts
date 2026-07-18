import { describe, expect, it } from "vitest";
import { autoCloseStreamingInlineMarkup } from "../src/lib/streaming-inline-markup";

describe("autoCloseStreamingInlineMarkup", () => {
  it("leaves balanced and plain text unchanged", () => {
    expect(autoCloseStreamingInlineMarkup("")).toBe("");
    expect(autoCloseStreamingInlineMarkup("use `getUser()` and **bold** text")).toBe("use `getUser()` and **bold** text");
    expect(autoCloseStreamingInlineMarkup("plain prose only")).toBe("plain prose only");
  });

  it("virtually closes open inline spans that already have content", () => {
    expect(autoCloseStreamingInlineMarkup("use `getUs")).toBe("use `getUs`");
    expect(autoCloseStreamingInlineMarkup("this is **import")).toBe("this is **import**");
    expect(autoCloseStreamingInlineMarkup("**bold `code")).toBe("**bold `code`**");
    expect(autoCloseStreamingInlineMarkup("**bold ")).toBe("**bold**");
    expect(autoCloseStreamingInlineMarkup("wraps `spanning\ncontent")).toBe("wraps `spanning\ncontent`");
    expect(autoCloseStreamingInlineMarkup("**`code`")).toBe("**`code`**");
  });

  it("holds back bare trailing openers instead of flashing raw markers", () => {
    expect(autoCloseStreamingInlineMarkup("see `")).toBe("see ");
    expect(autoCloseStreamingInlineMarkup("this is **")).toBe("this is ");
    expect(autoCloseStreamingInlineMarkup("**bold `")).toBe("**bold**");
    expect(autoCloseStreamingInlineMarkup("2 ** 3 == 8**")).toBe("2 ** 3 == 8");
  });

  it("leaves fenced code blocks untouched but closes spans after closed fences", () => {
    const openFence = "intro\n\n```swift\nlet x = `raw` ** stars";
    expect(autoCloseStreamingInlineMarkup(openFence)).toBe(openFence);
    const closedFence = "```\na ` b ** c\n```\nafter";
    expect(autoCloseStreamingInlineMarkup(closedFence)).toBe(closedFence);
    expect(autoCloseStreamingInlineMarkup("```\ncode\n```\nthen `inline")).toBe("```\ncode\n```\nthen `inline`");
  });

  it("does not treat common prose operators or list bullets as bold", () => {
    expect(autoCloseStreamingInlineMarkup("result: 2 ** 3 == 8 done")).toBe("result: 2 ** 3 == 8 done");
    expect(autoCloseStreamingInlineMarkup("weight **\nmore text")).toBe("weight **\nmore text");
    expect(autoCloseStreamingInlineMarkup("* item one\n* item two")).toBe("* item one\n* item two");
  });

  it("ignores escaped markers", () => {
    const text = "literal \\` and \\*\\* stay raw";
    expect(autoCloseStreamingInlineMarkup(text)).toBe(text);
  });
});
