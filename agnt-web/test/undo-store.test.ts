// Single-slot undo: publish, perform within the window fires the reverse,
// dismiss clears without firing, and the timer auto-clears the slot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetUndoStoreForTests, useUndoStore } from "../src/state/undo-store";

beforeEach(() => {
  __resetUndoStoreForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("undo-store", () => {
  it("starts empty", () => {
    expect(useUndoStore.getState().entry).toBeNull();
  });

  it("publish stores the entry and queues an auto-dismiss", () => {
    let reversed = false;
    useUndoStore.getState().publish({
      label: "Archived",
      reverse: () => {
        reversed = true;
      },
    });
    expect(useUndoStore.getState().entry?.label).toBe("Archived");
    vi.advanceTimersByTime(5_001);
    expect(useUndoStore.getState().entry).toBeNull();
    expect(reversed).toBe(false);
  });

  it("perform fires the reverse and clears the slot", async () => {
    let reversed = false;
    const id = useUndoStore.getState().publish({
      label: "Archived",
      reverse: () => {
        reversed = true;
      },
    });
    await useUndoStore.getState().perform(id);
    expect(reversed).toBe(true);
    expect(useUndoStore.getState().entry).toBeNull();
  });

  it("perform with a stale id is a no-op", async () => {
    let reversed = false;
    useUndoStore.getState().publish({
      label: "Archived",
      reverse: () => {
        reversed = true;
      },
    });
    await useUndoStore.getState().perform("not-a-real-id");
    expect(reversed).toBe(false);
    expect(useUndoStore.getState().entry).not.toBeNull();
  });

  it("dismiss clears without firing the reverse", () => {
    let reversed = false;
    const id = useUndoStore.getState().publish({
      label: "Archived",
      reverse: () => {
        reversed = true;
      },
    });
    useUndoStore.getState().dismiss(id);
    expect(reversed).toBe(false);
    expect(useUndoStore.getState().entry).toBeNull();
  });

  it("a second publish replaces the first entry", () => {
    let firstReversed = false;
    useUndoStore.getState().publish({ label: "First", reverse: () => { firstReversed = true; } });
    useUndoStore.getState().publish({ label: "Second", reverse: () => {} });
    expect(useUndoStore.getState().entry?.label).toBe("Second");
    // The first entry's auto-dismiss timer must have been cleared so the
    // second entry's timer is the only one running.
    vi.advanceTimersByTime(5_001);
    expect(firstReversed).toBe(false);
    expect(useUndoStore.getState().entry).toBeNull();
  });

  it("swallows reverse callback failures", async () => {
    const id = useUndoStore.getState().publish({
      label: "Archived",
      reverse: () => {
        throw new Error("boom");
      },
    });
    // Should not throw to the caller — the toast goes away regardless.
    await expect(useUndoStore.getState().perform(id)).resolves.toBeUndefined();
    expect(useUndoStore.getState().entry).toBeNull();
  });
});
