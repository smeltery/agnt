// Per-thread overrides: storage round-trip + the `prependSystemPrompt`
// helper that composes a system prompt with the user's typed turn.

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
import { prependSystemPrompt } from "../src/state/threads-store";

beforeEach(() => {
  memory.clear();
});

describe("prefs.threadOverrides", () => {
  it("returns {} when nothing is persisted", async () => {
    expect(await prefsStore.loadThreadOverrides()).toEqual({});
  });

  it("round-trips an override map", async () => {
    await prefsStore.saveThreadOverrides({
      "thread-1": { systemPrompt: "Be terse.", model: "claude-sonnet-4-6" },
      "thread-2": { reasoningEffort: "high" },
    });
    expect(await prefsStore.loadThreadOverrides()).toEqual({
      "thread-1": { systemPrompt: "Be terse.", model: "claude-sonnet-4-6" },
      "thread-2": { reasoningEffort: "high" },
    });
  });

  it("drops empty entries from a malformed blob", async () => {
    memory.set("prefs.threadOverrides", {
      "valid": { systemPrompt: "ok" },
      "empty": {},
      "bad-types": { systemPrompt: 42, model: null },
      "not-object": "string",
    });
    expect(await prefsStore.loadThreadOverrides()).toEqual({
      valid: { systemPrompt: "ok" },
    });
  });
});

describe("prependSystemPrompt", () => {
  it("inserts the prompt followed by a blank line + content", () => {
    expect(prependSystemPrompt("write a haiku", "be terse")).toBe("be terse\n\nwrite a haiku");
  });

  it("returns the content unchanged when the prompt is empty/whitespace", () => {
    expect(prependSystemPrompt("hi", "")).toBe("hi");
    expect(prependSystemPrompt("hi", "   ")).toBe("hi");
  });

  it("returns just the prompt when content is empty", () => {
    expect(prependSystemPrompt("", "do this")).toBe("do this");
  });
});
