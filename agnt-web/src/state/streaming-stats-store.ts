// Per-thread streaming throughput counters. Lives outside threads-store so the
// chat-header tick interval doesn't poke the per-message reducer state. Pure
// counters: turn/started resets, every assistant/reasoning delta increments,
// turn/completed (or failed/interrupted) clears the entry.
//
// We deliberately count delta *characters*, not tokens — the bridge doesn't
// emit a stable per-delta token count, and chars-per-second is close enough as
// a "is the model still alive" signal. Anyone looking for true tok/s can read
// the existing context-window bar.

import { create } from "zustand";

export interface StreamingStats {
  startedAtMs: number;
  charCount: number;
}

interface StreamingStatsState {
  byThread: Record<string, StreamingStats>;
  noteTurnStarted(threadId: string): void;
  noteDelta(threadId: string, charCount: number): void;
  noteTurnFinished(threadId: string): void;
}

export const useStreamingStatsStore = create<StreamingStatsState>((set) => ({
  byThread: {},
  noteTurnStarted(threadId) {
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: { startedAtMs: Date.now(), charCount: 0 } },
    }));
  },
  noteDelta(threadId, charCount) {
    if (charCount <= 0) return;
    set((state) => {
      const existing = state.byThread[threadId];
      // Late deltas can land after a turn ended (terminal-replay path); ignore
      // them rather than spawning a phantom stats entry that no one will clear.
      if (!existing) return state;
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...existing, charCount: existing.charCount + charCount },
        },
      };
    });
  },
  noteTurnFinished(threadId) {
    set((state) => {
      if (!(threadId in state.byThread)) return state;
      const next = { ...state.byThread };
      delete next[threadId];
      return { byThread: next };
    });
  },
}));

/** Pure formatter, exported for unit tests. */
export function formatStreamingStats(stats: StreamingStats, nowMs: number): { rate: string; elapsed: string } {
  const elapsedMs = Math.max(0, nowMs - stats.startedAtMs);
  const seconds = elapsedMs / 1000;
  // Until we've collected at least 250ms of data the rate is meaningless —
  // showing "8000 ch/s" for the first delta is more confusing than helpful.
  const rate = seconds < 0.25 ? "…" : `${Math.round(stats.charCount / Math.max(seconds, 0.001))} ch/s`;
  const totalSec = Math.floor(seconds);
  const minutes = Math.floor(totalSec / 60);
  const remainingSec = totalSec % 60;
  const elapsed = `${minutes}:${String(remainingSec).padStart(2, "0")}`;
  return { rate, elapsed };
}
