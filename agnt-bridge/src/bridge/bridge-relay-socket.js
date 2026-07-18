const { createRelaySocketLoop } = require("./relay-socket-loop");
const { buildMacRegistrationHeaders } = require("./mac-registration");
const { shutdown } = require("./lifecycle");

const RELAY_TERMINAL_CLOSE_CODES = new Set([4000, 4001]);

function createBridgeRelaySocketLoop({
  WebSocketCtor,
  bridgeStatus,
  bridgeWakeAssertion,
  codex,
  contextUsageWatcher,
  desktopIpcActionFollower,
  desktopIpcLiveOwner,
  desktopRefresher,
  getDeviceState,
  getPairingSession,
  getRelaySessionUrl,
  handleApplicationMessage,
  isShuttingDown,
  markShuttingDown,
  notificationSecret,
  rolloutLiveMirror,
  secureTransport,
  sendRelayRegistrationUpdate,
  sendRelayWireMessage,
}) {
  let socketLoop = null;
  socketLoop = createRelaySocketLoop({
    WebSocketCtor,
    relaySessionUrl: getRelaySessionUrl,
    buildHeaders: () => ({
      "x-role": "mac",
      "x-notification-secret": notificationSecret,
      ...buildMacRegistrationHeaders(getDeviceState(), getPairingSession()),
    }),
    isShuttingDown,
    reconnectScheduler: bridgeStatus.reconnectScheduler,
    shouldShutdownOnClose: (code) => RELAY_TERMINAL_CLOSE_CODES.has(code),
    onShutdown: () => {
      shutdown(codex, () => socketLoop.getSocket(), () => {
        markShuttingDown();
        bridgeWakeAssertion.stop();
        bridgeStatus.clearReconnectTimer();
        bridgeStatus.clearRelayWatchdog();
        bridgeStatus.clearBridgeStatusHeartbeat();
      });
    },
    onStatus: bridgeStatus.logConnectionStatus,
    markActivity: bridgeStatus.markRelayActivity,
    startWatchdog: bridgeStatus.startRelayWatchdog,
    clearWatchdog: bridgeStatus.clearRelayWatchdog,
    onOpen: () => {
      secureTransport.bindLiveSendWireMessage(sendRelayWireMessage);
      sendRelayRegistrationUpdate(getDeviceState());
    },
    onTeardown: () => {
      contextUsageWatcher.stop();
      rolloutLiveMirror?.stopAll();
      desktopIpcLiveOwner?.stopAll();
      desktopIpcActionFollower?.stopAll();
      desktopRefresher.handleTransportReset();
    },
    handleIncomingWireMessage: (message, ctx) => secureTransport.handleIncomingWireMessage(message, ctx),
    onApplicationMessage: handleApplicationMessage,
  });

  return socketLoop;
}

module.exports = {
  createBridgeRelaySocketLoop,
};
