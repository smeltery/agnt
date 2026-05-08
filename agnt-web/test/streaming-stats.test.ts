// Streaming-stats store + formatter contract. The store is a thin counter so
// the tests focus on the lifecycle (start clears, deltas accumulate, finish
// removes) and the formatter's edge cases (sub-250ms shows ellipsis, minute
// padding, ignored late deltas).

import { beforeEach, describe, expect, it } from "vitest";
import { formatStreamingStats, useStreamingStatsStore } from "../src/state/streaming-stats-store";

beforeEach(() => {
  useStreamingStatsStore.setState({ byThread: {} });
});

describe("streaming stats store", () => {
  it("seeds an entry on turn/started and clears on turn/finished", () => {
    const store = useStreamingStatsStore.getState();
    store.noteTurnStarted("t1");
    expect(useStreamingStatsStore.getState().byThread.t1).toMatchObject({ charCount: 0 });
    store.noteTurnFinished("t1");
    expect(useStreamingStatsStore.getState().byThread.t1).toBeUndefined();
  });

  it("accumulates char counts across deltas", () => {
    const store = useStreamingStatsStore.getState();
    store.noteTurnStarted("t1");
    store.noteDelta("t1", 12);
    store.noteDelta("t1", 8);
    expect(useStreamingStatsStore.getState().byThread.t1?.charCount).toBe(20);
  });

  it("ignores deltas for threads with no started entry — late replays don't spawn phantoms", () => {
    useStreamingStatsStore.getState().noteDelta("ghost", 50);
    expect(useStreamingStatsStore.getState().byThread.ghost).toBeUndefined();
  });

  it("starting a turn for a second thread leaves the first one alone", () => {
    const store = useStreamingStatsStore.getState();
    store.noteTurnStarted("a");
    store.noteDelta("a", 5);
    store.noteTurnStarted("b");
    expect(useStreamingStatsStore.getState().byThread.a?.charCount).toBe(5);
    expect(useStreamingStatsStore.getState().byThread.b?.charCount).toBe(0);
  });
});

describe("formatStreamingStats", () => {
  it("shows an ellipsis until at least 250 ms of data", () => {
    const out = formatStreamingStats({ startedAtMs: 1_000_000, charCount: 30 }, 1_000_100);
    expect(out.rate).toBe("…");
  });

  it("computes chars-per-second once enough time has passed", () => {
    const out = formatStreamingStats({ startedAtMs: 1_000_000, charCount: 1000 }, 1_002_000);
    // 1000 chars in 2s = 500 ch/s
    expect(out.rate).toBe("500 ch/s");
  });

  it("formats elapsed time as m:ss with zero-padded seconds", () => {
    const out = formatStreamingStats({ startedAtMs: 0, charCount: 50 }, 75_000);
    expect(out.elapsed).toBe("1:15");
  });

  it("clamps negative elapsed (clock skew) to zero", () => {
    const out = formatStreamingStats({ startedAtMs: 10_000, charCount: 5 }, 5_000);
    expect(out.elapsed).toBe("0:00");
  });
});
