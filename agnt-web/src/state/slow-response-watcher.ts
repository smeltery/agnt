// Per-turn watchdog that emits a "still working…" toast when a turn has been
// running for 15s without a terminal frame. Useful when the model is silent
// for a long time (large reasoning step, slow tool, throttled provider) and
// the user can't tell whether anything's still happening.
//
// One timer per turnId, cleared by `cancel` on the terminal frame. Memory is
// bounded by the cancel hook — we don't accumulate stale entries.

import { useNoticesStore } from "./notices-store";

const SLOW_RESPONSE_MS = 15_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Arm a watchdog for the given turn. Calls cancel + replaces any existing
 *  timer for the same turnId so retries reset cleanly. */
export function armSlowResponseWatch(turnId: string): void {
  cancelSlowResponseWatch(turnId);
  // setTimeout exists on globalThis in both browsers and node — no env guard
  // needed. Vitest's default env is node-like and reaches the same global.
  timers.set(
    turnId,
    setTimeout(() => {
      timers.delete(turnId);
      useNoticesStore.getState().enqueue({
        severity: "info",
        title: "Still working…",
        message: "The agent has been running for 15s without sending output. It may be on a slow tool, large reasoning step, or throttled provider.",
        // Slightly longer than the default info duration so the user has
        // time to notice it on their next glance at the screen.
        durationMs: 8_000,
      });
    }, SLOW_RESPONSE_MS)
  );
}

export function cancelSlowResponseWatch(turnId: string): void {
  const timer = timers.get(turnId);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(turnId);
}

export function __resetSlowResponseWatchersForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

export function __pendingSlowResponseTurnsForTests(): string[] {
  return [...timers.keys()];
}
