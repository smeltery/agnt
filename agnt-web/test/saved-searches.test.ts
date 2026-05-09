// Saved-searches preference persistence: load returns an array of strings,
// dedupes corrupt blobs, and round-trips a save.

import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();
vi.mock("../src/storage/idb", () => ({
  idb: {
    async get<T>(key: string): Promise<T | undefined> {
      return memory.has(key) ? (memory.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memory.set(key, value);
    },
    async remove(key: string): Promise<void> {
      memory.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...memory.keys()];
    },
  },
}));

import { prefsStore } from "../src/storage/prefs-store";

beforeEach(() => {
  memory.clear();
});

describe("savedSearches prefs", () => {
  it("returns an empty array when nothing is persisted", async () => {
    expect(await prefsStore.loadSavedSearches()).toEqual([]);
  });

  it("round-trips a save", async () => {
    await prefsStore.saveSavedSearches(["foo", "bar baz"]);
    expect(await prefsStore.loadSavedSearches()).toEqual(["foo", "bar baz"]);
  });

  it("filters non-strings + empty strings from a malformed blob", async () => {
    memory.set("prefs.savedSearches", ["valid", null, 42, "", "  ", "another"]);
    expect(await prefsStore.loadSavedSearches()).toEqual(["valid", "another"]);
  });

  it("returns [] when the persisted blob is not an array", async () => {
    memory.set("prefs.savedSearches", { not: "an array" });
    expect(await prefsStore.loadSavedSearches()).toEqual([]);
  });
});
