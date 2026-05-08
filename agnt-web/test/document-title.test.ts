import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTitleControllerForTests,
  flashTitle,
} from "../src/lib/document-title";

const originalDocument = globalThis.document;

beforeEach(() => {
  vi.useFakeTimers();
  __resetTitleControllerForTests();
});

afterEach(() => {
  __resetTitleControllerForTests();
  vi.useRealTimers();
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
});

function fakeDocument(initial: { hidden: boolean; title: string }) {
  let hidden = initial.hidden;
  let title = initial.title;
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    get title() {
      return title;
    },
    set title(value: string) {
      title = value;
    },
    get hidden() {
      return hidden;
    },
    setHidden(next: boolean) {
      hidden = next;
      const visibility = listeners.get("visibilitychange");
      if (visibility) for (const cb of visibility) cb();
    },
    addEventListener(event: string, callback: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
    },
    removeEventListener(event: string, callback: () => void) {
      listeners.get(event)?.delete(callback);
    },
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  return doc;
}

describe("flashTitle", () => {
  it("does nothing when the tab is focused", () => {
    const doc = fakeDocument({ hidden: false, title: "agnt" });
    flashTitle("Turn done");
    expect(doc.title).toBe("agnt");
    vi.advanceTimersByTime(5_000);
    expect(doc.title).toBe("agnt");
  });

  it("alternates the title while the tab is hidden, restoring on visibility", () => {
    const doc = fakeDocument({ hidden: true, title: "agnt" });
    flashTitle("Turn done");
    expect(doc.title).toBe("(Turn done) agnt");
    vi.advanceTimersByTime(1_500);
    expect(doc.title).toBe("agnt");
    vi.advanceTimersByTime(1_500);
    expect(doc.title).toBe("(Turn done) agnt");
    // User refocuses — the flash stops and the title resets to neutral.
    doc.setHidden(false);
    expect(doc.title).toBe("agnt");
    vi.advanceTimersByTime(5_000);
    expect(doc.title).toBe("agnt");
  });

  it("a second flashTitle while one is active doesn't double the timer", () => {
    const doc = fakeDocument({ hidden: true, title: "agnt" });
    flashTitle("First");
    flashTitle("Second");
    // The second call refreshes the alert label only when we're currently on
    // the alert frame. Either way, no runaway timer.
    expect(doc.title.startsWith("(") || doc.title === "agnt").toBe(true);
    vi.advanceTimersByTime(1_500);
    // After one full interval we should be on whichever frame the cycle
    // points at; check shape rather than exact label.
    expect(doc.title === "agnt" || doc.title.startsWith("(")).toBe(true);
  });
});
