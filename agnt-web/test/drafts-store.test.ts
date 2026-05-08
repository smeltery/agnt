// `lib/storage/idb.ts` calls `indexedDB.open` through the drafts-store's
// `loadMap()` helper. Vitest's default node env doesn't have IndexedDB, so
// we replace the idb wrapper with an in-memory map. Keeps the test focused
// on the drafts-store's contract without pulling in `fake-indexeddb`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { draftsStore } from "../src/storage/drafts-store";

beforeEach(() => {
  memory.clear();
  draftsStore.__resetForTests();
});

afterEach(() => {
  draftsStore.__resetForTests();
});

describe("draftsStore", () => {
  it("returns empty string for unknown thread ids", async () => {
    expect(await draftsStore.load("never-typed")).toBe("");
  });

  it("save+load round-trips a non-empty draft", async () => {
    await draftsStore.save("t1", "in progress");
    expect(await draftsStore.load("t1")).toBe("in progress");
  });

  it("treats empty / whitespace drafts as a delete so we don't persist noise", async () => {
    await draftsStore.save("t1", "real text");
    await draftsStore.save("t1", "");
    expect(await draftsStore.load("t1")).toBe("");
    await draftsStore.save("t1", "   \n");
    expect(await draftsStore.load("t1")).toBe("");
  });

  it("clear() drops the entry without touching siblings", async () => {
    await draftsStore.save("t1", "a");
    await draftsStore.save("t2", "b");
    await draftsStore.clear("t1");
    expect(await draftsStore.load("t1")).toBe("");
    expect(await draftsStore.load("t2")).toBe("b");
  });

  it("save with the same value is a no-op (no thrash on duplicate keystrokes)", async () => {
    await draftsStore.save("t1", "hello");
    // Doesn't throw; the second save short-circuits when the cached map
    // already matches.
    await draftsStore.save("t1", "hello");
    expect(await draftsStore.load("t1")).toBe("hello");
  });

  it("ignores empty thread ids on every entry point", async () => {
    await draftsStore.save("", "anything");
    expect(await draftsStore.load("")).toBe("");
    await draftsStore.clear(""); // no-op
  });
});
