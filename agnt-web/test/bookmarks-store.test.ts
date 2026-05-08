// Bookmarks store contract: toggle in/out, persistence flattens to the
// string[]-shape that idb can encode, and clear-thread drops a key entirely.

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

import { useBookmarksStore } from "../src/state/bookmarks-store";

beforeEach(() => {
  memory.clear();
  useBookmarksStore.setState({ byThread: {}, hydrated: false });
});

describe("bookmarks store", () => {
  it("toggle adds, then removes the same id", () => {
    const store = useBookmarksStore.getState();
    store.toggle("t1", "m1");
    expect(store.isBookmarked("t1", "m1")).toBe(true);
    store.toggle("t1", "m1");
    expect(useBookmarksStore.getState().isBookmarked("t1", "m1")).toBe(false);
  });

  it("countForThread reflects the current set size", () => {
    const store = useBookmarksStore.getState();
    store.toggle("t1", "m1");
    store.toggle("t1", "m2");
    expect(useBookmarksStore.getState().countForThread("t1")).toBe(2);
  });

  it("removing the last entry in a thread drops the thread key", async () => {
    const store = useBookmarksStore.getState();
    store.toggle("t1", "m1");
    store.toggle("t1", "m1");
    expect(Object.keys(useBookmarksStore.getState().byThread)).toEqual([]);
    await Promise.resolve();
    // Persisted blob should also drop the empty bucket.
    expect(memory.get("prefs.bookmarksByThread")).toEqual({});
  });

  it("persists as an idb-friendly Record<string, string[]>", async () => {
    const store = useBookmarksStore.getState();
    store.toggle("t1", "m1");
    store.toggle("t1", "m2");
    store.toggle("t2", "m3");
    await Promise.resolve();
    expect(memory.get("prefs.bookmarksByThread")).toEqual({ t1: ["m1", "m2"], t2: ["m3"] });
  });

  it("hydrate rehydrates Sets from the persisted shape", async () => {
    memory.set("prefs.bookmarksByThread", { t1: ["m1", "m2"] });
    await useBookmarksStore.getState().hydrate();
    const set = useBookmarksStore.getState().byThread.t1;
    expect(set instanceof Set).toBe(true);
    expect([...(set ?? [])]).toEqual(["m1", "m2"]);
  });

  it("clearThread removes only the targeted thread", () => {
    const store = useBookmarksStore.getState();
    store.toggle("t1", "m1");
    store.toggle("t2", "m2");
    store.clearThread("t1");
    expect(useBookmarksStore.getState().byThread.t1).toBeUndefined();
    expect(useBookmarksStore.getState().byThread.t2).toBeDefined();
  });
});
