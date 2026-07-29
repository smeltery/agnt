import { describe, expect, it, vi } from "vitest";
import type { CodexMessage } from "../src/models";

const memory = new Map<string, unknown>();

vi.mock("../src/storage/idb", () => ({
  idb: {
    get: vi.fn((key: string) => Promise.resolve(memory.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      memory.set(key, value);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      memory.delete(key);
      return Promise.resolve();
    }),
  },
}));

describe("messagesStore", () => {
  it("persists only the newest 50 timeline rows per thread", async () => {
    const { MAX_PERSISTED_PER_THREAD, messagesStore } = await import("../src/storage/messages-store");
    const messages = Array.from({ length: 75 }, (_, index) => ({
      id: `message-${index}`,
      orderIndex: index,
    })) as CodexMessage[];

    await messagesStore.save("thread-1", messages);

    const saved = await messagesStore.load("thread-1");
    expect(MAX_PERSISTED_PER_THREAD).toBe(50);
    expect(saved).toHaveLength(50);
    expect(saved[0].id).toBe("message-25");
    expect(saved.at(-1)?.id).toBe("message-74");
  });
});
