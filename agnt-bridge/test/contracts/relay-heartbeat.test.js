// FILE: contracts/relay-heartbeat.test.js
// Purpose: Pins the relay watchdog state machine that keeps the daemon
//          self-healing across macOS sleep/wake. Load-bearing invariants:
//          1. Watchdog interval fires onTick({isStale}) honestly — true
//             when last activity is older than staleAfterMs, false
//             otherwise.
//          2. markActivity() updates the timestamp the next isStale read
//             observes.
//          3. clearWatchdog() / clearStatusHeartbeat() actually stop the
//             interval — no leaked timers.
//          4. Status heartbeat passes the running status through
//             wrapStatus, which downgrades "connected" → "disconnected"
//             when the underlying timestamp is stale.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RELAY_WATCHDOG_STALE_AFTER_MS,
  STALE_RELAY_STATUS_MESSAGE,
  hasRelayConnectionGoneStale,
  buildHeartbeatBridgeStatus,
  createBridgeRelayHeartbeat,
} = require("../../src/bridge/relay-heartbeat");

// ─── pure helpers ───────────────────────────────────────────────────────────

test("hasRelayConnectionGoneStale is true when now - lastActivityAt >= staleAfterMs", () => {
  assert.equal(
    hasRelayConnectionGoneStale(0, { now: RELAY_WATCHDOG_STALE_AFTER_MS, staleAfterMs: RELAY_WATCHDOG_STALE_AFTER_MS }),
    true,
  );
  assert.equal(
    hasRelayConnectionGoneStale(0, { now: RELAY_WATCHDOG_STALE_AFTER_MS - 1, staleAfterMs: RELAY_WATCHDOG_STALE_AFTER_MS }),
    false,
  );
});

test("hasRelayConnectionGoneStale rejects non-finite inputs without throwing", () => {
  assert.equal(hasRelayConnectionGoneStale(NaN), false);
  assert.equal(hasRelayConnectionGoneStale(Infinity), false);
  assert.equal(hasRelayConnectionGoneStale(0, { now: NaN }), false);
});

test("buildHeartbeatBridgeStatus passes non-connected statuses through unchanged", () => {
  const status = { connectionStatus: "disconnected", lastError: "boom" };
  assert.equal(buildHeartbeatBridgeStatus(status, 0, { now: 1_000_000, staleAfterMs: 70_000 }), status);
});

test("buildHeartbeatBridgeStatus passes fresh connected statuses through unchanged", () => {
  const status = { connectionStatus: "connected" };
  assert.equal(buildHeartbeatBridgeStatus(status, 1_000, { now: 1_500, staleAfterMs: 70_000 }), status);
});

test("buildHeartbeatBridgeStatus downgrades stale connected statuses to disconnected", () => {
  const status = { connectionStatus: "connected", lastError: "" };
  const downgraded = buildHeartbeatBridgeStatus(status, 0, {
    now: 100_000,
    staleAfterMs: 50_000,
  });
  assert.notEqual(downgraded, status);
  assert.equal(downgraded.connectionStatus, "disconnected");
  assert.equal(downgraded.lastError, STALE_RELAY_STATUS_MESSAGE);
});

test("buildHeartbeatBridgeStatus is tolerant of malformed status", () => {
  assert.equal(buildHeartbeatBridgeStatus(null, 0), null);
  assert.equal(buildHeartbeatBridgeStatus(undefined, 0), undefined);
});

// ─── createBridgeRelayHeartbeat — fake timer harness ────────────────────────

function makeFakeTimerEnv() {
  let nowValue = 1_000_000;
  const handles = [];

  return {
    now: () => nowValue,
    advance(ms) { nowValue += ms; },
    setIntervalImpl(fn, interval) {
      const handle = { fn, interval, unref() {}, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearIntervalImpl(handle) {
      handle.cleared = true;
    },
    fireAll() {
      for (const h of handles) {
        if (!h.cleared) h.fn();
      }
    },
    active: () => handles.filter((h) => !h.cleared),
  };
}

test("createBridgeRelayHeartbeat: watchdog onTick sees isStale=false fresh and isStale=true after time passes", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    pingIntervalMs: 10,
    staleAfterMs: 50,
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  const ticks = [];
  heartbeat.startWatchdog(({ isStale }) => ticks.push(isStale));

  // First tick — markActivity was called inside startWatchdog with current now,
  // so isStale must be false.
  env.fireAll();
  assert.deepEqual(ticks, [false]);

  // Advance time past the stale window and tick again.
  env.advance(60);
  env.fireAll();
  assert.deepEqual(ticks, [false, true]);

  // markActivity should reset.
  heartbeat.markActivity();
  env.fireAll();
  assert.deepEqual(ticks, [false, true, false]);
});

test("createBridgeRelayHeartbeat: clearWatchdog stops the interval; subsequent firings are no-ops", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  let ticks = 0;
  heartbeat.startWatchdog(() => { ticks += 1; });
  assert.equal(env.active().length, 1);

  heartbeat.clearWatchdog();
  assert.equal(env.active().length, 0);

  // Even if a stale firer existed, fireAll skips cleared handles.
  env.fireAll();
  assert.equal(ticks, 0);
});

test("createBridgeRelayHeartbeat: startWatchdog called twice clears the previous handle", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  heartbeat.startWatchdog(() => {});
  heartbeat.startWatchdog(() => {});
  // Only the newest handle should still be active.
  assert.equal(env.active().length, 1);
});

test("createBridgeRelayHeartbeat: status heartbeat passes wrapStatus that downgrades stale connections", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    statusHeartbeatIntervalMs: 5,
    staleAfterMs: 50,
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  const published = [];
  heartbeat.startStatusHeartbeat(({ wrapStatus }) => {
    published.push(wrapStatus({ connectionStatus: "connected" }));
  });

  // No markActivity yet, so timestamp is 0 — stale.
  env.fireAll();
  assert.equal(published.at(-1).connectionStatus, "disconnected");
  assert.equal(published.at(-1).lastError, STALE_RELAY_STATUS_MESSAGE);

  // After markActivity, the next tick should pass through as connected.
  heartbeat.markActivity();
  env.fireAll();
  assert.equal(published.at(-1).connectionStatus, "connected");
});

test("createBridgeRelayHeartbeat: startStatusHeartbeat is idempotent (no double-timer)", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  heartbeat.startStatusHeartbeat(() => {});
  heartbeat.startStatusHeartbeat(() => {});
  assert.equal(env.active().length, 1);
});

test("createBridgeRelayHeartbeat: clearStatusHeartbeat removes the heartbeat timer", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  heartbeat.startStatusHeartbeat(() => {});
  heartbeat.clearStatusHeartbeat();
  assert.equal(env.active().length, 0);
});

test("createBridgeRelayHeartbeat: getLastActivityAt reflects the last markActivity call", () => {
  const env = makeFakeTimerEnv();
  const heartbeat = createBridgeRelayHeartbeat({
    setIntervalImpl: env.setIntervalImpl,
    clearIntervalImpl: env.clearIntervalImpl,
    nowImpl: env.now,
  });

  assert.equal(heartbeat.getLastActivityAt(), 0);
  heartbeat.markActivity();
  assert.equal(heartbeat.getLastActivityAt(), 1_000_000);
  env.advance(123);
  heartbeat.markActivity();
  assert.equal(heartbeat.getLastActivityAt(), 1_000_123);
});
