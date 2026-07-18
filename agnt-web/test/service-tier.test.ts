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
import { normalizeModel } from "../src/state/sync";
import { effectiveServiceTier } from "../src/state/threads-store";

beforeEach(() => {
  memory.clear();
});

describe("service tier model metadata", () => {
  it("decodes fast support from explicit fields and additional speed tiers", () => {
    expect(normalizeModel({ slug: "gpt-5.5", name: "GPT-5.5", additionalSpeedTiers: ["fast"] })).toMatchObject({
      id: "gpt-5.5",
      model: "gpt-5.5",
      name: "GPT-5.5",
      supportsFastMode: true,
    });
    expect(normalizeModel({ id: "custom-model", supports_fast_mode: false })).toMatchObject({
      id: "custom-model",
      supportsFastMode: false,
    });
  });

  it("falls back to known fast-capable model ids when metadata is absent", () => {
    expect(normalizeModel({ slug: "gpt-5.4" })?.supportsFastMode).toBe(true);
    expect(normalizeModel({ slug: "gpt-5.3-codex" })?.supportsFastMode).toBe(false);
  });
});

describe("service tier turn flags", () => {
  it("round-trips the persisted fast tier preference", async () => {
    await prefsStore.saveTurnFlags({ model: "gpt-5.4", serviceTier: "fast" });
    expect(await prefsStore.loadTurnFlags()).toEqual({ model: "gpt-5.4", serviceTier: "fast" });
  });

  it("only emits fast for the selected or default model when that model supports it", () => {
    const models = [
      { id: "gpt-5.4", supportsFastMode: true },
      { id: "gpt-5.3-codex", supportsFastMode: false },
      { id: "gpt-5.5", isDefault: true, supportsFastMode: true },
    ];

    expect(effectiveServiceTier({ model: "gpt-5.4", serviceTier: "fast" }, models)).toBe("fast");
    expect(effectiveServiceTier({ model: "gpt-5.3-codex", serviceTier: "fast" }, models)).toBeUndefined();
    expect(effectiveServiceTier({ serviceTier: "fast" }, models)).toBe("fast");
    expect(effectiveServiceTier({ model: "missing", serviceTier: "fast" }, models)).toBeUndefined();
    expect(effectiveServiceTier({ model: "gpt-5.4" }, models)).toBeUndefined();
  });
});
