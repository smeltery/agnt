// FILE: relay-reconnect-scheduler.js
// Purpose: Owns the relay-reconnect backoff state: attempt counter + the
//          single scheduled setTimeout handle. Bridge.js asks the scheduler
//          to schedule the next reconnect after a socket close; the
//          scheduler computes a bounded linear delay (default
//          1s, 2s, 3s, …, capped at 5s) and fires the caller-supplied
//          attempt callback when the timer elapses. `connectRelay` resets
//          the counter on a successful open via `resetAttempt`.
// Layer: Bridge support (state-bearing factory)
// Exports: createRelayReconnectScheduler
//   - DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5_000;

function createRelayReconnectScheduler({
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let attempt = 0;
  let timer = null;

  // Schedules onAttempt to fire after the next linear-backoff delay. Returns
  // the chosen delay (or null when a reconnect is already scheduled — the
  // existing timer is left alone).
  function schedule(onAttempt) {
    if (typeof onAttempt !== "function") {
      throw new Error("relay-reconnect-scheduler: schedule(onAttempt) requires a function.");
    }
    if (timer) {
      return null;
    }
    attempt += 1;
    const delayMs = Math.min(baseDelayMs * attempt, maxDelayMs);
    timer = setTimeoutImpl(() => {
      timer = null;
      onAttempt(attempt);
    }, delayMs);
    timer.unref?.();
    return delayMs;
  }

  function clear() {
    if (!timer) return;
    clearTimeoutImpl(timer);
    timer = null;
  }

  function resetAttempt() {
    attempt = 0;
  }

  function getAttempt() {
    return attempt;
  }

  function isPending() {
    return timer !== null;
  }

  return {
    schedule,
    clear,
    resetAttempt,
    getAttempt,
    isPending,
  };
}

module.exports = {
  createRelayReconnectScheduler,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
};
