// Thread color persistence: setThreadColor writes through prefs, null
// clears the entry, and the fixed palette of valid colors is enforced at
// load time.

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
import { prefsStore } from "../src/storage/prefs-store";

beforeEach(() => {
  memory.clear();
  useThreadsStore.setState({ colorByThread: {} });
});

describe("setThreadColor", () => {
  it("writes the chosen color through prefs", async () => {
    await useThreadsStore.getState().setThreadColor("t1", "blue");
    expect(useThreadsStore.getState().colorByThread).toEqual({ t1: "blue" });
    await Promise.resolve();
    expect(memory.get("prefs.threadColors")).toEqual({ t1: "blue" });
  });

  it("clears with null", async () => {
    await useThreadsStore.getState().setThreadColor("t1", "blue");
    await useThreadsStore.getState().setThreadColor("t1", null);
    expect(useThreadsStore.getState().colorByThread).toEqual({});
    await Promise.resolve();
    expect(memory.get("prefs.threadColors")).toEqual({});
  });

  it("ignores empty thread ids", async () => {
    await useThreadsStore.getState().setThreadColor("", "blue");
    expect(useThreadsStore.getState().colorByThread).toEqual({});
  });
});

describe("prefsStore.loadThreadColors", () => {
  it("filters out colors not in the fixed palette", async () => {
    memory.set("prefs.threadColors", { t1: "blue", t2: "magenta", t3: "green" });
    const loaded = await prefsStore.loadThreadColors();
    expect(loaded).toEqual({ t1: "blue", t3: "green" });
  });

  it("returns empty for malformed input", async () => {
    memory.set("prefs.threadColors", "not an object");
    expect(await prefsStore.loadThreadColors()).toEqual({});
  });
});
