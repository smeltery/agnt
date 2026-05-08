import { beforeEach, describe, expect, it } from "vitest";
import { orderCounter } from "../src/models";
import {
  applyAgentDelta,
  applyItemCompleted,
  applyItemStarted,
  applyReasoningDelta,
  applyTurnCompleted,
  applyTurnStarted,
  emptyThreadState,
} from "../src/state/turn-reducer";

beforeEach(() => orderCounter.__resetForTests());

describe("turn-reducer assistant streaming", () => {
  it("creates a streaming row for the first delta of a turn even when item/started arrives later", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", delta: "Hello", itemId: undefined });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", delta: ", world", itemId: undefined });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe("Hello, world");
    expect(state.messages[0].isStreaming).toBe(true);
    expect(state.messages[0].itemId).toBeUndefined();
  });

  it("promotes the turn-fallback row to item-scoped when item/started arrives", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", delta: "Hi" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].itemId).toBe("i1");
  });

  it("opens a NEW row when a different itemId starts mid-turn", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i1", delta: "first" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i2", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i2", delta: "second" });
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(state.messages.map((m) => m.itemId)).toEqual(["i1", "i2"]);
  });

  it("finalizes a streaming row with item/completed and clears isStreaming", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i1", delta: "draft" });
    state = applyItemCompleted(state, {
      threadId: "t1",
      turnId: "u1",
      itemId: "i1",
      type: "agentmessage",
      text: "Final answer",
    });
    expect(state.messages[0].text).toBe("Final answer");
    expect(state.messages[0].isStreaming).toBe(false);
  });

  it("absorbs a block-replay item/completed that concatenates prior streamed rows", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i1", delta: "Part one." });
    state = applyItemCompleted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage", text: "Part one." });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i2", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i2", delta: "Part two." });
    state = applyItemCompleted(state, { threadId: "t1", turnId: "u1", itemId: "i2", type: "agentmessage", text: "Part two." });
    // Now the bridge sends a "summary" item/completed with the full transcript.
    state = applyItemCompleted(state, {
      threadId: "t1",
      turnId: "u1",
      type: "agentmessage",
      text: "Part one. Part two.",
    });
    // No third row should be inserted.
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("patches late-replay deltas onto closed-turn rows without re-opening", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyItemStarted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i1", delta: "core" });
    state = applyItemCompleted(state, { threadId: "t1", turnId: "u1", itemId: "i1", type: "agentmessage", text: "core" });
    state = applyTurnCompleted(state, { threadId: "t1", turnId: "u1" });
    // Late replay arrives after the turn is terminal.
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", itemId: "i1", delta: "-suffix" });
    expect(state.messages[0].text).toBe("core-suffix");
    expect(state.messages[0].isStreaming).toBe(false);
    expect(state.activeTurnId).toBeUndefined();
  });
});

describe("turn-reducer reasoning rows", () => {
  it("keeps reasoning deltas on a separate system-role row", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t1", turnId: "u1" });
    state = applyReasoningDelta(state, { threadId: "t1", turnId: "u1", delta: "weighing options" });
    state = applyAgentDelta(state, { threadId: "t1", turnId: "u1", delta: "I think..." });
    expect(state.messages).toHaveLength(2);
    const reasoning = state.messages.find((m) => m.kind === "thinking");
    const assistant = state.messages.find((m) => m.kind === "chat");
    expect(reasoning?.role).toBe("system");
    expect(reasoning?.text).toBe("weighing options");
    expect(assistant?.role).toBe("assistant");
  });
});
