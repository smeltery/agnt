// Per-turn duration ledger. `streaming-stats-store` already keeps a per-thread
// rate counter that *clears* on turn/completed; this store is the keep-around
// version, indexed by turnId, so completed assistant rows can label themselves
// with "took 4.2s". One entry per turn, written when the terminal frame lands
// (or, for retried turns, replaced by the new attempt).
//
// Memory-only by design — durations are an artifact of the live session and
// don't need to survive a reload. The bookkeeping is also bounded: we cap the
// per-thread retention at 200 turns (a long thread will rarely have more
// completed turns than that) so a runaway day's worth of turns can't grow
// unbounded.

import { create } from "zustand";

const MAX_PER_THREAD = 200;

export interface TurnTiming {
  /** Local epoch ms at `turn/started`. */
  startedAtMs: number;
  /** Local epoch ms at `turn/completed` / `turn/failed`. Undefined while running. */
  endedAtMs?: number;
}

interface State {
  /** turnId → timing entry. */
  byTurn: Record<string, TurnTiming>;
  /** threadId → ordered list of turnIds, oldest first. Used to bound retention. */
  turnsByThread: Record<string, string[]>;
  noteTurnStarted(threadId: string, turnId: string): void;
  noteTurnEnded(turnId: string): void;
  reset(): void;
}

export const useTurnTimingStore = create<State>((set) => ({
  byTurn: {},
  turnsByThread: {},
  noteTurnStarted(threadId, turnId) {
    set((state) => {
      // A retry of the same turnId is treated as a fresh attempt — overwrite the
      // prior timing entry so the chip on the assistant row shows the new run.
      const existing = state.turnsByThread[threadId] ?? [];
      const filtered = existing.filter((id) => id !== turnId);
      filtered.push(turnId);
      let nextThreadList = filtered;
      let nextByTurn = { ...state.byTurn, [turnId]: { startedAtMs: Date.now() } };
      if (filtered.length > MAX_PER_THREAD) {
        const dropCount = filtered.length - MAX_PER_THREAD;
        const dropped = filtered.slice(0, dropCount);
        nextThreadList = filtered.slice(dropCount);
        nextByTurn = { ...nextByTurn };
        for (const oldTurnId of dropped) delete nextByTurn[oldTurnId];
      }
      return {
        byTurn: nextByTurn,
        turnsByThread: { ...state.turnsByThread, [threadId]: nextThreadList },
      };
    });
  },
  noteTurnEnded(turnId) {
    set((state) => {
      const entry = state.byTurn[turnId];
      if (!entry || entry.endedAtMs !== undefined) return state;
      return {
        byTurn: { ...state.byTurn, [turnId]: { ...entry, endedAtMs: Date.now() } },
      };
    });
  },
  reset() {
    set({ byTurn: {}, turnsByThread: {} });
  },
}));

/** Pure formatter, exported for unit tests. Returns a short human label like
 *  "0.4s", "12.3s", "1m 24s". `null` when the turn hasn't ended. */
export function formatTurnDuration(timing: TurnTiming): string | null {
  if (timing.endedAtMs === undefined) return null;
  const ms = Math.max(0, timing.endedAtMs - timing.startedAtMs);
  return formatDurationMs(ms);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const totalSec = Math.floor(seconds);
  const minutes = Math.floor(totalSec / 60);
  const remaining = totalSec % 60;
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}
