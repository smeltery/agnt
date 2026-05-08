// Composer inbox is the channel rows use to push Reply/quote text into the
// composer. The contract: consume() only succeeds when the threadId matches,
// and request() overwrites the slot (single-pending semantics).

import { beforeEach, describe, expect, it } from "vitest";
import { useComposerInboxStore } from "../src/state/composer-inbox-store";

beforeEach(() => {
  useComposerInboxStore.setState({ pending: null });
});

describe("composer inbox", () => {
  it("consume returns null when nothing is pending", () => {
    expect(useComposerInboxStore.getState().consume("t1")).toBeNull();
  });

  it("consume only fires for the matching threadId", () => {
    const store = useComposerInboxStore.getState();
    store.request({ threadId: "t1", body: "> hi\n\n" });
    expect(store.consume("t2")).toBeNull();
    // Pending stays — a future selection of t1 should still pick it up.
    expect(useComposerInboxStore.getState().pending).not.toBeNull();
    expect(store.consume("t1")).toBe("> hi\n\n");
    expect(useComposerInboxStore.getState().pending).toBeNull();
  });

  it("request overwrites a previous pending item", () => {
    const store = useComposerInboxStore.getState();
    store.request({ threadId: "t1", body: "first" });
    store.request({ threadId: "t1", body: "second" });
    expect(store.consume("t1")).toBe("second");
  });
});
