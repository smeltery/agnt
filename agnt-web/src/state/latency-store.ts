// Rolling-window RPC latency observer. The protocol layer feeds round-trip
// times into `record(ms)` on every successful response; the status pill
// subscribes and surfaces a quick health hint.
//
// We deliberately use a small fixed buffer (last N samples) — a longer
// window would dilute signal during a sudden Tailscale slow-down. The
// freshness check (`isFresh()`) hides the value entirely once the bridge
// has been quiet for a while, so users don't see a stale "12ms" while
// disconnected.

import { create } from "zustand";

const WINDOW = 16;
const FRESH_MS = 30_000;

interface LatencyState {
  samples: number[];
  lastSampleAtMs: number;
  record(ms: number): void;
  reset(): void;
}

export const useLatencyStore = create<LatencyState>((set, get) => ({
  samples: [],
  lastSampleAtMs: 0,
  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const next = [...get().samples, ms];
    if (next.length > WINDOW) next.splice(0, next.length - WINDOW);
    set({ samples: next, lastSampleAtMs: Date.now() });
  },
  reset() {
    set({ samples: [], lastSampleAtMs: 0 });
  },
}));

/** Returns the median of the recent samples, or `null` when there's nothing
 *  fresh to report. Median over mean keeps outlier RPC timings from
 *  swinging the indicator on every retry. */
export function selectMedianLatency(state: LatencyState, nowMs: number = Date.now()): number | null {
  if (state.samples.length === 0) return null;
  if (nowMs - state.lastSampleAtMs > FRESH_MS) return null;
  const sorted = [...state.samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Color tier for the status pill: <100 ms green, <500 ms warn, ≥500 error. */
export function classifyLatency(ms: number | null): "ok" | "warn" | "slow" | "idle" {
  if (ms === null) return "idle";
  if (ms < 100) return "ok";
  if (ms < 500) return "warn";
  return "slow";
}
