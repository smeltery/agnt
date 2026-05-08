// One-shot prefill semantics: request → consume returns the value once and
// clears the slot.

import { beforeEach, describe, expect, it } from "vitest";
import { useNewChatPrefillStore } from "../src/state/new-chat-prefill-store";

beforeEach(() => {
  useNewChatPrefillStore.setState({ pending: null });
});

describe("new-chat-prefill-store", () => {
  it("starts empty", () => {
    expect(useNewChatPrefillStore.getState().pending).toBeNull();
  });

  it("request stores the prefill", () => {
    useNewChatPrefillStore.getState().request({ cwd: "/proj", prompt: "hi" });
    expect(useNewChatPrefillStore.getState().pending).toEqual({ cwd: "/proj", prompt: "hi" });
  });

  it("consume returns and clears once", () => {
    useNewChatPrefillStore.getState().request({ cwd: "/x" });
    const first = useNewChatPrefillStore.getState().consume();
    expect(first).toEqual({ cwd: "/x" });
    const second = useNewChatPrefillStore.getState().consume();
    expect(second).toBeNull();
    expect(useNewChatPrefillStore.getState().pending).toBeNull();
  });

  it("request overwrites a prior unconsumed prefill", () => {
    useNewChatPrefillStore.getState().request({ cwd: "/old" });
    useNewChatPrefillStore.getState().request({ cwd: "/new", prompt: "hello" });
    expect(useNewChatPrefillStore.getState().pending).toEqual({ cwd: "/new", prompt: "hello" });
  });
});
