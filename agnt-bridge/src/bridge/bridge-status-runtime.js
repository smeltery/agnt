const { createBridgeRelayHeartbeat } = require("./relay-heartbeat");
const { createRelayReconnectScheduler } = require("./relay-reconnect-scheduler");

function createBridgeStatusRuntime({
  WebSocketCtor,
  initialCodexLaunchState,
  isShuttingDown,
  getSocket,
  onBridgeStatus,
}) {
  const heartbeat = createBridgeRelayHeartbeat();
  const reconnectScheduler = createRelayReconnectScheduler();
  let lastPublishedBridgeStatus = null;
  let lastConnectionStatus = null;
  let codexLaunchState = initialCodexLaunchState;

  function setCodexLaunchState(nextState) {
    codexLaunchState = nextState;
  }

  function getLastPublishedBridgeStatus() {
    return lastPublishedBridgeStatus;
  }

  function publishBridgeStatus(status) {
    const nextStatus = {
      ...status,
      codexLaunchState,
    };
    lastPublishedBridgeStatus = nextStatus;
    onBridgeStatus?.(nextStatus);
  }

  function startBridgeStatusHeartbeat() {
    heartbeat.startStatusHeartbeat(({ wrapStatus }) => {
      if (!lastPublishedBridgeStatus || isShuttingDown()) {
        return;
      }
      onBridgeStatus?.(wrapStatus(lastPublishedBridgeStatus));
    });
  }

  function clearBridgeStatusHeartbeat() {
    heartbeat.clearStatusHeartbeat();
  }

  function markRelayActivity() {
    heartbeat.markActivity();
  }

  function clearRelayWatchdog() {
    heartbeat.clearWatchdog();
  }

  function startRelayWatchdog(trackedSocket) {
    heartbeat.startWatchdog(({ isStale }) => {
      if (isShuttingDown() || getSocket() !== trackedSocket) {
        heartbeat.clearWatchdog();
        return;
      }

      if (trackedSocket.readyState !== WebSocketCtor.OPEN) {
        return;
      }

      if (isStale) {
        console.warn("[agnt] relay heartbeat stalled; forcing reconnect");
        logConnectionStatus("disconnected");
        trackedSocket.terminate();
        return;
      }

      try {
        trackedSocket.ping();
      } catch {
        trackedSocket.terminate();
      }
    });
  }

  function clearReconnectTimer() {
    reconnectScheduler.clear();
  }

  function logConnectionStatus(status) {
    if (lastConnectionStatus === status) {
      return;
    }

    lastConnectionStatus = status;
    publishBridgeStatus({
      state: "running",
      connectionStatus: status,
      pid: process.pid,
      lastError: "",
    });
    console.log(`[agnt] ${status}`);
  }

  return {
    clearBridgeStatusHeartbeat,
    clearReconnectTimer,
    clearRelayWatchdog,
    getLastPublishedBridgeStatus,
    logConnectionStatus,
    markRelayActivity,
    publishBridgeStatus,
    reconnectScheduler,
    setCodexLaunchState,
    startBridgeStatusHeartbeat,
    startRelayWatchdog,
  };
}

module.exports = {
  createBridgeStatusRuntime,
};
