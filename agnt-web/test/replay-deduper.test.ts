import { beforeEach, describe, expect, it } from "vitest";
import { createMessage, orderCounter } from "../src/models";
import { replayDeduper } from "../src/state/replay-deduper";

beforeEach(() => orderCounter.__resetForTests());

describe("replay deduper", () => {
  it("treats whitespace-equivalent strings as the same exact replay", () => {
    const messages = [
      createMessage({ threadId: "t", role: "assistant", turnId: "u", text: "Hello world" }),
    ];
    expect(
      replayDeduper.isExactReplay(messages, { threadId: "t", turnId: "u", text: "  Hello   world  " })
    ).toBe(true);
  });

  it("detects block replay across multiple prior rows in the same turn", () => {
    const messages = [
      createMessage({ threadId: "t", role: "assistant", turnId: "u", text: "First half." }),
      createMessage({ threadId: "t", role: "assistant", turnId: "u", text: "Second half." }),
    ];
    expect(replayDeduper.isBlockReplay(messages, { threadId: "t", turnId: "u", text: "First half. Second half." })).toBe(true);
  });

  it("does NOT flag a different text as a replay", () => {
    const messages = [
      createMessage({ threadId: "t", role: "assistant", turnId: "u", text: "Hello" }),
    ];
    expect(replayDeduper.isReplay(messages, { threadId: "t", turnId: "u", text: "Hello world" })).toBe(false);
  });

  it("scopes by turn so prior turns don't poison the dedup", () => {
    const messages = [
      createMessage({ threadId: "t", role: "assistant", turnId: "u-old", text: "old turn final" }),
    ];
    expect(replayDeduper.isReplay(messages, { threadId: "t", turnId: "u-new", text: "old turn final" })).toBe(false);
  });
});
