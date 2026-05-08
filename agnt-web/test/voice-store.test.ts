// Voice store test surface. We can't drive MediaRecorder + getUserMedia in
// node, so we verify the no-connection / no-mic / consume-transcript edges —
// the parts that hold across runtimes.

import { afterEach, describe, expect, it } from "vitest";
import { useVoiceStore } from "../src/state/voice-store";

afterEach(() => useVoiceStore.getState().reset());

describe("voice-store", () => {
  it("starts in idle with no pending transcript", () => {
    expect(useVoiceStore.getState().state).toEqual({ kind: "idle" });
    expect(useVoiceStore.getState().pendingTranscript).toBeNull();
  });

  it("surfaces a clean error when getUserMedia is unavailable (Node)", async () => {
    await useVoiceStore.getState().start();
    const state = useVoiceStore.getState().state;
    expect(state.kind).toBe("error");
    if (state.kind === "error") expect(state.message).toMatch(/microphone|browser/i);
  });

  it("consumeTranscript returns null when none is pending and clears after read", () => {
    expect(useVoiceStore.getState().consumeTranscript()).toBeNull();
    useVoiceStore.setState({ pendingTranscript: "hello" });
    expect(useVoiceStore.getState().consumeTranscript()).toBe("hello");
    expect(useVoiceStore.getState().pendingTranscript).toBeNull();
    expect(useVoiceStore.getState().consumeTranscript()).toBeNull();
  });

  it("reset() returns to a clean idle state and clears any pending transcript", () => {
    useVoiceStore.setState({ pendingTranscript: "leftover", state: { kind: "error", message: "!" } });
    useVoiceStore.getState().reset();
    expect(useVoiceStore.getState().state).toEqual({ kind: "idle" });
    expect(useVoiceStore.getState().pendingTranscript).toBeNull();
  });
});
