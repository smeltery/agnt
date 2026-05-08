// Custom slash commands: validation contract on the store, plus the
// merge-with-builtins behavior on the filter helper. We don't exercise the
// composer here (it uses DOM); the store is wired via a fake idb.

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

import { useCustomSlashCommandsStore } from "../src/state/custom-slash-commands-store";
import { filterSlashCommands } from "../src/state/slash-commands";
import type { ThreadsState } from "../src/state/threads-store";

beforeEach(() => {
  memory.clear();
  useCustomSlashCommandsStore.setState({ commands: [], hydrated: false });
});

const fakeThreadsState: ThreadsState = {
  threads: [{ id: "t1" }],
  archivedThreads: [],
  reducerStates: { t1: { messages: [], activeTurnId: undefined } },
} as unknown as ThreadsState;

describe("useCustomSlashCommandsStore", () => {
  it("rejects names that don't match the slug rule", () => {
    const result = useCustomSlashCommandsStore.getState().addCommand({ name: "Has Space", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/lowercase letters/);
  });

  it("rejects empty bodies", () => {
    const result = useCustomSlashCommandsStore.getState().addCommand({ name: "ok", body: "" });
    expect(result.ok).toBe(false);
  });

  it("stores valid commands and persists them through idb", async () => {
    const result = useCustomSlashCommandsStore.getState().addCommand({ name: "debug", body: "find the cause" });
    expect(result.ok).toBe(true);
    // Persistence is fire-and-forget; flush microtasks so the idb mock receives the write.
    await Promise.resolve();
    expect(memory.get("prefs.customSlashCommands")).toEqual([{ name: "debug", body: "find the cause" }]);
  });

  it("refuses duplicate names on add", () => {
    const store = useCustomSlashCommandsStore.getState();
    store.addCommand({ name: "x", body: "first" });
    const second = store.addCommand({ name: "x", body: "second" });
    expect(second.ok).toBe(false);
  });

  it("renames atomically via updateCommand", () => {
    const store = useCustomSlashCommandsStore.getState();
    store.addCommand({ name: "old", body: "body" });
    const result = store.updateCommand("old", { name: "new", body: "body" });
    expect(result.ok).toBe(true);
    expect(useCustomSlashCommandsStore.getState().commands).toEqual([{ name: "new", body: "body" }]);
  });

  it("removeCommand drops by name and is idempotent", () => {
    const store = useCustomSlashCommandsStore.getState();
    store.addCommand({ name: "x", body: "y" });
    store.removeCommand("x");
    store.removeCommand("x");
    expect(useCustomSlashCommandsStore.getState().commands).toEqual([]);
  });
});

describe("filterSlashCommands with custom commands", () => {
  it("merges custom commands at the end of the catalog", () => {
    const out = filterSlashCommands(
      "",
      { threadId: "t1", threads: fakeThreadsState },
      [{ name: "debug-this", body: "ask the bridge" }]
    );
    expect(out.some((command) => command.name === "debug-this")).toBe(true);
    // Built-ins still show.
    expect(out.some((command) => command.name === "compact")).toBe(true);
  });

  it("drops a custom command whose name collides with a built-in", () => {
    const out = filterSlashCommands(
      "",
      { threadId: "t1", threads: fakeThreadsState },
      [{ name: "compact", body: "no!" }]
    );
    const compact = out.filter((command) => command.name === "compact");
    // Only the built-in survives.
    expect(compact).toHaveLength(1);
    expect(compact[0].expand).toBeUndefined();
  });

  it("drops a custom command with an invalid name silently", () => {
    const out = filterSlashCommands(
      "",
      { threadId: "t1", threads: fakeThreadsState },
      [{ name: "Bad Name", body: "x" }]
    );
    expect(out.some((command) => command.name === "Bad Name")).toBe(false);
  });
});
