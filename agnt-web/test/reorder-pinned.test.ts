// reorderPinnedThreads contract: it filters to currently-pinned ids,
// preserves any pins missing from the input (so a partial reorder doesn't
// drop pins on the floor), and refuses to promote non-pinned ids.

import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();
vi.mock("../src/storage/idb", () => ({
  idb: {
    async get<T>(key: string): Promise<T | undefined> {
      return memory.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memory.set(key, value);
    },
    async remove(key: string): Promise<void> {
      memory.delete(key);
    },
  },
}));

import { useThreadsStore } from "../src/state/threads-store";

beforeEach(() => {
  memory.clear();
  useThreadsStore.setState({ pinnedThreadIds: new Set() });
});

describe("reorderPinnedThreads", () => {
  it("rebuilds the Set with the requested order", async () => {
    useThreadsStore.setState({ pinnedThreadIds: new Set(["a", "b", "c"]) });
    await useThreadsStore.getState().reorderPinnedThreads(["c", "a", "b"]);
    expect([...useThreadsStore.getState().pinnedThreadIds]).toEqual(["c", "a", "b"]);
  });

  it("appends pins missing from the input rather than dropping them", async () => {
    useThreadsStore.setState({ pinnedThreadIds: new Set(["a", "b", "c"]) });
    await useThreadsStore.getState().reorderPinnedThreads(["b"]);
    // Start with what the caller asked for, then add the others in their
    // existing iteration order.
    expect([...useThreadsStore.getState().pinnedThreadIds]).toEqual(["b", "a", "c"]);
  });

  it("ignores non-pinned ids the caller might pass by mistake", async () => {
    useThreadsStore.setState({ pinnedThreadIds: new Set(["a", "b"]) });
    await useThreadsStore.getState().reorderPinnedThreads(["ghost", "b", "a"]);
    expect([...useThreadsStore.getState().pinnedThreadIds]).toEqual(["b", "a"]);
  });

  it("persists the new order through prefsStore", async () => {
    useThreadsStore.setState({ pinnedThreadIds: new Set(["a", "b"]) });
    await useThreadsStore.getState().reorderPinnedThreads(["b", "a"]);
    // prefsStore.savePinnedThreadIds writes through the mocked idb under
    // "prefs.pinnedThreadIds". Flush microtasks so the fire-and-forget save
    // has a chance to land.
    await Promise.resolve();
    expect(memory.get("prefs.pinnedThreadIds")).toEqual(["b", "a"]);
  });
});
