// FILE: contracts/relay-reconnect-scheduler.test.js
// Purpose: Pins the relay-reconnect backoff state machine. Load-bearing rules:
//          1. schedule() is one-shot — calling it twice while a timer is
//             pending is a no-op (returns null) so bridge.js can't accidentally
//             stack reconnect timers.
//          2. Backoff is bounded: linear (baseDelay * attempt) capped at
//             maxDelay. The default cap is 5s.
//          3. resetAttempt() restarts the backoff series (a successful
//             reconnect should start the next retry at the base delay).
//          4. clear() actually stops a pending timer.
//          5. The attempt counter and pending flag are observable for tests +
//             diagnostics.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRelayReconnectScheduler,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} = require("../../src/bridge/relay-reconnect-scheduler");

function makeFakeTimerEnv() {
  const handles = [];
  return {
    setTimeoutImpl(fn, ms) {
      const handle = { fn, ms, cleared: false, unref() {} };
      handles.push(handle);
      return handle;
    },
    clearTimeoutImpl(handle) {
      if (handle) handle.cleared = true;
    },
    fireAll() {
      for (const h of handles) {
        if (!h.cleared) {
          h.cleared = true;
          h.fn();
        }
      }
    },
    active: () => handles.filter((h) => !h.cleared),
  };
}

test("defaults expose 1s base and 5s cap", () => {
  assert.equal(DEFAULT_BASE_DELAY_MS, 1_000);
  assert.equal(DEFAULT_MAX_DELAY_MS, 5_000);
});

test("schedule() throws when onAttempt is not a function", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });
  assert.throws(() => scheduler.schedule(), /requires a function/);
  assert.throws(() => scheduler.schedule(null), /requires a function/);
});

test("schedule() bumps attempt and computes a linear delay, capped at maxDelayMs", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    baseDelayMs: 100,
    maxDelayMs: 350,
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  // Attempt 1 → 100ms, fire to release the timer slot before scheduling again.
  assert.equal(scheduler.schedule(() => {}), 100);
  env.fireAll();
  assert.equal(scheduler.schedule(() => {}), 200);
  env.fireAll();
  assert.equal(scheduler.schedule(() => {}), 300);
  env.fireAll();
  // Capped at 350 (would otherwise be 400)
  assert.equal(scheduler.schedule(() => {}), 350);
  env.fireAll();
  // Still capped at 350
  assert.equal(scheduler.schedule(() => {}), 350);
});

test("schedule() returns null and skips when a timer is already pending", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  const firstDelay = scheduler.schedule(() => {});
  assert.equal(typeof firstDelay, "number");
  // Second call short-circuits (timer still pending).
  assert.equal(scheduler.schedule(() => {}), null);
  // Attempt counter must not have advanced past the first schedule.
  assert.equal(scheduler.getAttempt(), 1);
  assert.equal(env.active().length, 1);
});

test("the registered callback fires with the current attempt number", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    baseDelayMs: 10,
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  const observed = [];
  scheduler.schedule((attempt) => observed.push(attempt));
  env.fireAll();
  scheduler.schedule((attempt) => observed.push(attempt));
  env.fireAll();
  assert.deepEqual(observed, [1, 2]);
});

test("clear() stops a pending timer; subsequent fireAll is a no-op", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  let fired = 0;
  scheduler.schedule(() => { fired += 1; });
  assert.equal(scheduler.isPending(), true);

  scheduler.clear();
  assert.equal(scheduler.isPending(), false);

  env.fireAll();
  assert.equal(fired, 0);
});

test("resetAttempt() restarts the backoff series at the base delay", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  scheduler.schedule(() => {}); // attempt 1 → 100
  env.fireAll();
  scheduler.schedule(() => {}); // attempt 2 → 200
  env.fireAll();
  assert.equal(scheduler.getAttempt(), 2);

  scheduler.resetAttempt();
  assert.equal(scheduler.getAttempt(), 0);

  // Next schedule should be back to base delay.
  assert.equal(scheduler.schedule(() => {}), 100);
});

test("schedule() adds bounded jitter on top of the linear delay", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    // Math.floor(0.5 * min(linear, 2000)) — deterministic jitter for the test.
    random: () => 0.5,
  });

  // Attempt 1: linear 100, jitter floor(0.5 * 100) = 50 → 150.
  assert.equal(scheduler.schedule(() => {}), 150);
  env.fireAll();
  // Attempt 4: linear 400, jitter floor(0.5 * 400) = 200 → 600.
  scheduler.schedule(() => {});
  env.fireAll();
  scheduler.schedule(() => {});
  env.fireAll();
  assert.equal(scheduler.schedule(() => {}), 600);
});

test("isPending() flips with the timer lifecycle", () => {
  const env = makeFakeTimerEnv();
  const scheduler = createRelayReconnectScheduler({
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    random: () => 0,
  });

  assert.equal(scheduler.isPending(), false);
  scheduler.schedule(() => {});
  assert.equal(scheduler.isPending(), true);
  env.fireAll();
  assert.equal(scheduler.isPending(), false);
});
