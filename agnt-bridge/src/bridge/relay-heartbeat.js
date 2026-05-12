// FILE: relay-heartbeat.js
// Purpose: Owns the relay socket's liveness state machine. Two intervals
//          cooperate to keep the daemon self-healing across macOS sleep /
//          wake cycles:
//          1. The relay watchdog pings the upstream every 10 s and forces
//             a reconnect when the last inbound activity is older than the
//             stale-after threshold (default 70 s).
//          2. The bridge status heartbeat re-publishes the last bridge
//             status every 5 s, downgrading "connected" → "disconnected"
//             when the watchdog's timestamp says the socket is stale.
//          Pure helpers (`hasRelayConnectionGoneStale`,
//          `buildHeartbeatBridgeStatus`) are exported alongside the
//          state-bearing factory so existing tests can pin the rules in
//          isolation.
// Layer: Bridge support (state-bearing factory)
// Exports:
//   - createBridgeRelayHeartbeat
//   - hasRelayConnectionGoneStale
//   - buildHeartbeatBridgeStatus
//   - RELAY_WATCHDOG_PING_INTERVAL_MS, RELAY_WATCHDOG_STALE_AFTER_MS,
//     BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS, STALE_RELAY_STATUS_MESSAGE

const RELAY_WATCHDOG_PING_INTERVAL_MS = 10_000;
// Keep the watchdog above the relay heartbeat cadence so quiet healthy sockets survive idle gaps.
const RELAY_WATCHDOG_STALE_AFTER_MS = 70_000;
const BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_RELAY_STATUS_MESSAGE = "Relay heartbeat stalled; reconnect pending.";

function hasRelayConnectionGoneStale(
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
  } = {}
) {
  return Number.isFinite(lastActivityAt)
    && Number.isFinite(now)
    && now - lastActivityAt >= staleAfterMs;
}

// Keeps persisted daemon status honest by downgrading stale "connected" snapshots.
function buildHeartbeatBridgeStatus(
  status,
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
    staleMessage = STALE_RELAY_STATUS_MESSAGE,
  } = {}
) {
  if (!status || typeof status !== "object") {
    return status;
  }

  if (status.connectionStatus !== "connected") {
    return status;
  }

  if (!hasRelayConnectionGoneStale(lastActivityAt, { now, staleAfterMs })) {
    return status;
  }

  return {
    ...status,
    connectionStatus: "disconnected",
    lastError: staleMessage,
  };
}

function createBridgeRelayHeartbeat({
  pingIntervalMs = RELAY_WATCHDOG_PING_INTERVAL_MS,
  staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
  statusHeartbeatIntervalMs = BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS,
  staleMessage = STALE_RELAY_STATUS_MESSAGE,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  nowImpl = Date.now,
} = {}) {
  let lastActivityAt = 0;
  let watchdogTimer = null;
  let statusHeartbeatTimer = null;

  function markActivity() {
    lastActivityAt = nowImpl();
  }

  function getLastActivityAt() {
    return lastActivityAt;
  }

  function isStale() {
    return hasRelayConnectionGoneStale(lastActivityAt, {
      now: nowImpl(),
      staleAfterMs,
    });
  }

  function clearWatchdog() {
    if (!watchdogTimer) return;
    clearIntervalImpl(watchdogTimer);
    watchdogTimer = null;
  }

  function startWatchdog(onTick) {
    clearWatchdog();
    markActivity();
    watchdogTimer = setIntervalImpl(() => {
      onTick({ isStale: isStale() });
    }, pingIntervalMs);
    watchdogTimer.unref?.();
  }

  function clearStatusHeartbeat() {
    if (!statusHeartbeatTimer) return;
    clearIntervalImpl(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  function startStatusHeartbeat(onTick) {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setIntervalImpl(() => {
      onTick({
        wrapStatus: (status) => buildHeartbeatBridgeStatus(status, lastActivityAt, {
          now: nowImpl(),
          staleAfterMs,
          staleMessage,
        }),
      });
    }, statusHeartbeatIntervalMs);
    statusHeartbeatTimer.unref?.();
  }

  return {
    markActivity,
    getLastActivityAt,
    isStale,
    startWatchdog,
    clearWatchdog,
    startStatusHeartbeat,
    clearStatusHeartbeat,
  };
}

module.exports = {
  RELAY_WATCHDOG_PING_INTERVAL_MS,
  RELAY_WATCHDOG_STALE_AFTER_MS,
  BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS,
  STALE_RELAY_STATUS_MESSAGE,
  hasRelayConnectionGoneStale,
  buildHeartbeatBridgeStatus,
  createBridgeRelayHeartbeat,
};
