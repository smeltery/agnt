// Webhook fire-and-forget: only POSTs when enabled + a valid http(s) URL
// is set. Failures are swallowed; payload omits message text by design.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { fireTurnWebhook } from "../src/lib/turn-webhook";
import { prefsStore } from "../src/storage/prefs-store";

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fireTurnWebhook", () => {
  it("no-ops when no URL is set", async () => {
    await fireTurnWebhook({
      schemaVersion: 1,
      outcome: "completed",
      threadId: "t-1",
      timestamp: new Date().toISOString(),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when disabled", async () => {
    await prefsStore.saveTurnWebhook({ url: "https://hooks.example/agnt", enabled: false });
    await fireTurnWebhook({
      schemaVersion: 1,
      outcome: "completed",
      threadId: "t-1",
      timestamp: new Date().toISOString(),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-http URLs", async () => {
    await prefsStore.saveTurnWebhook({ url: "javascript:alert(1)", enabled: true });
    await fireTurnWebhook({
      schemaVersion: 1,
      outcome: "completed",
      threadId: "t-1",
      timestamp: new Date().toISOString(),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs JSON when enabled with an https URL", async () => {
    await prefsStore.saveTurnWebhook({ url: "https://hooks.example/agnt", enabled: true });
    const payload = {
      schemaVersion: 1 as const,
      outcome: "completed" as const,
      threadId: "thread-7",
      turnId: "turn-3",
      timestamp: "2026-05-08T22:00:00.000Z",
    };
    await fireTurnWebhook(payload);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://hooks.example/agnt");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("swallows network failures", async () => {
    await prefsStore.saveTurnWebhook({ url: "https://hooks.example/agnt", enabled: true });
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    await expect(
      fireTurnWebhook({
        schemaVersion: 1,
        outcome: "failed",
        threadId: "t-9",
        timestamp: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();
  });
});
