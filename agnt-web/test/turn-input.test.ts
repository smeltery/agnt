import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "../src/models";
import { buildTurnInput } from "../src/state/turn-input";

function makeAttachment(payload: string): ImageAttachment {
  return {
    id: "a1",
    payloadDataUrl: payload,
    thumbnailDataUrl: payload,
  };
}

describe("buildTurnInput", () => {
  it("builds a single text item for prompt-only turns (matches what every translator expects)", () => {
    expect(buildTurnInput("hello", undefined)).toEqual([{ type: "text", text: "hello" }]);
  });

  it("trims surrounding whitespace and drops empty prompts entirely", () => {
    expect(buildTurnInput("   \n\n  ", undefined)).toEqual([]);
    expect(buildTurnInput("  hi  ", undefined)).toEqual([{ type: "text", text: "hi" }]);
  });

  it("emits images first, then text — matching iOS makeTurnInputPayload order", () => {
    const result = buildTurnInput("look at this", [makeAttachment("data:image/png;base64,iVBOR")]);
    expect(result).toEqual([
      { type: "image", url: "data:image/png;base64,iVBOR" },
      { type: "text", text: "look at this" },
    ]);
  });

  it("supports image-only turns (text empty, attachments present)", () => {
    const result = buildTurnInput("", [makeAttachment("data:image/jpeg;base64,XYZ")]);
    expect(result).toEqual([{ type: "image", url: "data:image/jpeg;base64,XYZ" }]);
  });

  it("filters attachments without a payload data URL so a malformed one doesn't break the turn", () => {
    const result = buildTurnInput("hi", [
      makeAttachment(""),
      makeAttachment("   "),
      makeAttachment("data:image/png;base64,OK"),
    ]);
    expect(result).toEqual([
      { type: "image", url: "data:image/png;base64,OK" },
      { type: "text", text: "hi" },
    ]);
  });
});
