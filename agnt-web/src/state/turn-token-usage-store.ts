// Per-turn token usage ledger. The bridge's `thread/tokenUsage/updated`
// event is published *just before* `turn/completed` while the turn is still
// active, so the threads-store wiring resolves the active turnId for the
// thread and writes here. Components read the entry by turnId on completed
// assistant rows.
//
// Mirrors the bookkeeping discipline of `turn-timing-store`: memory-only,
// per-thread retention capped at 200 turns so a long-running session can't
// leak memory.

import { create } from "zustand";
import type { TurnTokenUsage } from "../lib/token-usage";

const MAX_PER_THREAD = 200;

interface State {
  byTurn: Record<string, TurnTokenUsage>;
  turnsByThread: Record<string, string[]>;
  noteTurnUsage(threadId: string, turnId: string, usage: TurnTokenUsage): void;
  reset(): void;
}

export const useTurnTokenUsageStore = create<State>((set) => ({
  byTurn: {},
  turnsByThread: {},
  noteTurnUsage(threadId, turnId, usage) {
    set((state) => {
      const existing = state.turnsByThread[threadId] ?? [];
      const filtered = existing.filter((id) => id !== turnId);
      filtered.push(turnId);
      let nextThreadList = filtered;
      let nextByTurn: Record<string, TurnTokenUsage> = { ...state.byTurn, [turnId]: usage };
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
  reset() {
    set({ byTurn: {}, turnsByThread: {} });
  },
}));
