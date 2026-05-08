// Latency rolling-window contract: append + cap, fresh-window gate, median
// preferred over mean, classify thresholds.

import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyLatency,
  selectMedianLatency,
  useLatencyStore,
} from "../src/state/latency-store";

beforeEach(() => {
  useLatencyStore.setState({ samples: [], lastSampleAtMs: 0 });
});

describe("useLatencyStore", () => {
  it("rejects negative or non-finite samples", () => {
    const store = useLatencyStore.getState();
    store.record(-5);
    store.record(NaN);
    store.record(Infinity);
    expect(useLatencyStore.getState().samples).toEqual([]);
  });

  it("appends samples and caps at 16", () => {
    const store = useLatencyStore.getState();
    for (let i = 0; i < 25; i += 1) store.record(i + 1);
    const samples = useLatencyStore.getState().samples;
    expect(samples).toHaveLength(16);
    // Oldest (1..9) dropped; newest 16 retained.
    expect(samples[0]).toBe(10);
    expect(samples[15]).toBe(25);
  });
});

describe("selectMedianLatency", () => {
  it("returns null for an empty buffer", () => {
    expect(selectMedianLatency(useLatencyStore.getState())).toBeNull();
  });

  it("returns null when the last sample is older than 30 s", () => {
    useLatencyStore.setState({ samples: [10, 20, 30], lastSampleAtMs: 1000 });
    expect(selectMedianLatency(useLatencyStore.getState(), 60_000)).toBeNull();
  });

  it("returns the median of an odd-length window", () => {
    useLatencyStore.setState({ samples: [10, 50, 30], lastSampleAtMs: 1000 });
    expect(selectMedianLatency(useLatencyStore.getState(), 1000)).toBe(30);
  });

  it("averages the two middle samples for even lengths", () => {
    useLatencyStore.setState({ samples: [10, 20, 30, 40], lastSampleAtMs: 1000 });
    expect(selectMedianLatency(useLatencyStore.getState(), 1000)).toBe(25);
  });
});

describe("classifyLatency", () => {
  it("idle when null", () => {
    expect(classifyLatency(null)).toBe("idle");
  });

  it("ok under 100 ms", () => {
    expect(classifyLatency(50)).toBe("ok");
    expect(classifyLatency(99)).toBe("ok");
  });

  it("warn 100–499 ms", () => {
    expect(classifyLatency(100)).toBe("warn");
    expect(classifyLatency(499)).toBe("warn");
  });

  it("slow at 500+ ms", () => {
    expect(classifyLatency(500)).toBe("slow");
    expect(classifyLatency(2000)).toBe("slow");
  });
});
