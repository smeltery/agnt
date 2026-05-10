// CommandPalette filter predicate. Three orthogonal narrow axes (role,
// date, model) AND-combined; each axis has a permissive default.

import { describe, expect, it } from "vitest";
import {
  defaultFilters,
  isFilterDefault,
  passesFilters,
} from "../src/lib/search-filter";
import type { CodexMessage } from "../src/models";

function makeMessage(partial: Partial<CodexMessage> = {}): CodexMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    role: "assistant",
    kind: "chat",
    text: "hello",
    createdAt: 1_700_000_000_000,
    ...partial,
  } as CodexMessage;
}

describe("defaultFilters / isFilterDefault", () => {
  it("starts permissive (any/any/null)", () => {
    expect(isFilterDefault(defaultFilters())).toBe(true);
  });

  it("flips on any narrowing", () => {
    expect(isFilterDefault({ ...defaultFilters(), role: "user" })).toBe(false);
    expect(isFilterDefault({ ...defaultFilters(), date: "24h" })).toBe(false);
    expect(isFilterDefault({ ...defaultFilters(), model: "claude-sonnet-4-6" })).toBe(false);
  });
});

describe("passesFilters", () => {
  it("permissive defaults accept any message", () => {
    expect(passesFilters(makeMessage(), defaultFilters())).toBe(true);
  });

  describe("role", () => {
    it("filters to user", () => {
      expect(passesFilters(makeMessage({ role: "user" }), { ...defaultFilters(), role: "user" })).toBe(true);
      expect(passesFilters(makeMessage({ role: "assistant" }), { ...defaultFilters(), role: "user" })).toBe(false);
    });
    it("filters to assistant", () => {
      expect(passesFilters(makeMessage({ role: "user" }), { ...defaultFilters(), role: "assistant" })).toBe(false);
      expect(passesFilters(makeMessage({ role: "assistant" }), { ...defaultFilters(), role: "assistant" })).toBe(true);
    });
  });

  describe("date", () => {
    const now = 1_700_086_400_000; // exactly 1 day after the message default

    it("24h: keeps fresh, drops old", () => {
      // Within window: 23h ago → keeps. 25h ago → drops.
      expect(passesFilters(makeMessage({ createdAt: now - 23 * 3600_000 }), { ...defaultFilters(), date: "24h", now })).toBe(true);
      expect(passesFilters(makeMessage({ createdAt: now - 25 * 3600_000 }), { ...defaultFilters(), date: "24h", now })).toBe(false);
    });

    it("7d window", () => {
      expect(passesFilters(makeMessage({ createdAt: now - 6 * 86_400_000 }), { ...defaultFilters(), date: "7d", now })).toBe(true);
      expect(passesFilters(makeMessage({ createdAt: now - 8 * 86_400_000 }), { ...defaultFilters(), date: "7d", now })).toBe(false);
    });

    it("30d window", () => {
      expect(passesFilters(makeMessage({ createdAt: now - 29 * 86_400_000 }), { ...defaultFilters(), date: "30d", now })).toBe(true);
      expect(passesFilters(makeMessage({ createdAt: now - 31 * 86_400_000 }), { ...defaultFilters(), date: "30d", now })).toBe(false);
    });

    it("missing createdAt is treated as ancient (drops from any narrow window)", () => {
      const m = makeMessage();
      delete (m as { createdAt?: number }).createdAt;
      expect(passesFilters(m, { ...defaultFilters(), date: "24h", now })).toBe(false);
    });
  });

  describe("model", () => {
    it("matches direct `model` field", () => {
      const m = makeMessage();
      (m as unknown as Record<string, unknown>).model = "claude-sonnet-4-6";
      expect(passesFilters(m, { ...defaultFilters(), model: "claude-sonnet-4-6" })).toBe(true);
      expect(passesFilters(m, { ...defaultFilters(), model: "claude-opus-4-7" })).toBe(false);
    });

    it("falls back to metadata.model when `model` is absent", () => {
      const m = makeMessage();
      (m as unknown as Record<string, unknown>).metadata = { model: "claude-haiku-4-5" };
      expect(passesFilters(m, { ...defaultFilters(), model: "claude-haiku-4-5" })).toBe(true);
    });

    it("excludes a row that has no model when filtering on a specific model", () => {
      expect(passesFilters(makeMessage(), { ...defaultFilters(), model: "claude-sonnet-4-6" })).toBe(false);
    });
  });

  describe("AND-combined", () => {
    it("requires every axis to pass", () => {
      const now = 1_700_086_400_000;
      const recentUserSonnet = makeMessage({ role: "user", createdAt: now - 1000 });
      (recentUserSonnet as unknown as Record<string, unknown>).model = "claude-sonnet-4-6";
      expect(
        passesFilters(recentUserSonnet, { role: "user", date: "24h", model: "claude-sonnet-4-6", now })
      ).toBe(true);
      // Wrong role fails the combined predicate even though date+model pass.
      const recentAssistantSonnet = { ...recentUserSonnet, role: "assistant" } as CodexMessage;
      expect(
        passesFilters(recentAssistantSonnet, { role: "user", date: "24h", model: "claude-sonnet-4-6", now })
      ).toBe(false);
    });
  });
});
