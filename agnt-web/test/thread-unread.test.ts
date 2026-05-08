// Pure selector contract: a thread is unread iff its updatedAt outpaces the
// recorded last-visited timestamp. Works without idb / DOM, so the tests stay
// minimal — just shape the inputs.

import { describe, expect, it } from "vitest";
import { isThreadUnread } from "../src/state/threads-store";
import type { CodexThread } from "../src/models";

function thread(id: string, updatedAt?: number): CodexThread {
  return { id, title: id, updatedAt } as CodexThread;
}

describe("isThreadUnread", () => {
  it("returns false when the thread has no updatedAt", () => {
    expect(isThreadUnread(thread("a"), {})).toBe(false);
  });

  it("returns true when updatedAt > visited", () => {
    expect(isThreadUnread(thread("a", 200), { a: 100 })).toBe(true);
  });

  it("returns false when updatedAt <= visited", () => {
    expect(isThreadUnread(thread("a", 100), { a: 100 })).toBe(false);
    expect(isThreadUnread(thread("a", 99), { a: 100 })).toBe(false);
  });

  it("treats a thread that's never been visited as unread once it has any updatedAt", () => {
    expect(isThreadUnread(thread("a", 1), {})).toBe(true);
  });

  it("ignores updatedAt of zero — thread/list often returns 0 for fresh threads", () => {
    expect(isThreadUnread(thread("a", 0), {})).toBe(false);
  });
});
