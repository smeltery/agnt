// Turn-timing store: lifecycle (started → ended), retention cap, and the
// pure formatter that turns a millisecond delta into a short human label.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDurationMs,
  formatTurnDuration,
  useTurnTimingStore,
} from "../src/state/turn-timing-store";

beforeEach(() => {
  useTurnTimingStore.getState().reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("turn-timing-store lifecycle", () => {
  it("records startedAtMs on noteTurnStarted", () => {
    useTurnTimingStore.getState().noteTurnStarted("thread-1", "turn-1");
    const entry = useTurnTimingStore.getState().byTurn["turn-1"];
    expect(entry).toBeDefined();
    expect(entry.startedAtMs).toBe(Date.now());
    expect(entry.endedAtMs).toBeUndefined();
  });

  it("stamps endedAtMs on noteTurnEnded and computes duration", () => {
    useTurnTimingStore.getState().noteTurnStarted("thread-1", "turn-1");
    vi.advanceTimersByTime(2500);
    useTurnTimingStore.getState().noteTurnEnded("turn-1");
    const entry = useTurnTimingStore.getState().byTurn["turn-1"];
    expect(formatTurnDuration(entry)).toBe("2.5s");
  });

  it("noteTurnEnded for an unknown turn is a no-op", () => {
    useTurnTimingStore.getState().noteTurnEnded("never-started");
    expect(useTurnTimingStore.getState().byTurn["never-started"]).toBeUndefined();
  });

  it("retrying the same turnId resets the timing entry", () => {
    useTurnTimingStore.getState().noteTurnStarted("thread-1", "turn-1");
    vi.advanceTimersByTime(3000);
    useTurnTimingStore.getState().noteTurnEnded("turn-1");
    const firstEnded = useTurnTimingStore.getState().byTurn["turn-1"].endedAtMs;
    vi.advanceTimersByTime(5000);
    useTurnTimingStore.getState().noteTurnStarted("thread-1", "turn-1");
    const fresh = useTurnTimingStore.getState().byTurn["turn-1"];
    expect(fresh.endedAtMs).toBeUndefined();
    expect(fresh.startedAtMs).toBeGreaterThan(firstEnded ?? 0);
  });

  it("caps per-thread retention at 200 turns", () => {
    const store = useTurnTimingStore.getState();
    for (let i = 0; i < 250; i += 1) store.noteTurnStarted("thread-1", `turn-${i}`);
    expect(useTurnTimingStore.getState().turnsByThread["thread-1"]).toHaveLength(200);
    // Oldest entries got evicted from the byTurn map too.
    expect(useTurnTimingStore.getState().byTurn["turn-0"]).toBeUndefined();
    expect(useTurnTimingStore.getState().byTurn["turn-249"]).toBeDefined();
  });
});

describe("formatDurationMs", () => {
  it("emits ms below one second", () => {
    expect(formatDurationMs(450)).toBe("450ms");
  });
  it("emits decimals below ten seconds", () => {
    expect(formatDurationMs(4200)).toBe("4.2s");
  });
  it("rounds to whole seconds beyond ten", () => {
    expect(formatDurationMs(12700)).toBe("13s");
  });
  it("emits Mm SSs above a minute", () => {
    expect(formatDurationMs(84_000)).toBe("1m 24s");
  });
});

describe("formatTurnDuration", () => {
  it("returns null while the turn is still running", () => {
    expect(formatTurnDuration({ startedAtMs: Date.now() })).toBeNull();
  });
});
