// FILE: lifecycle.js
// Purpose: Small bootstrap + teardown helpers used by the bridge entry
//          point.
//          - `createNoopDesktopRefresher()` — the no-op shape that
//            bridge.js falls back to when the active provider doesn't
//            declare a `desktopRefresher` capability (Claude, opencode,
//            Cursor today; only Codex ships a companion app).
//          - `shutdown(codex, getSocket, beforeExit)` — graceful teardown
//            that runs caller-supplied cleanup, closes any live
//            WebSocket, shuts down the transport, then exits.
// Layer: Bridge support (pure)
// Exports: createNoopDesktopRefresher, shutdown
// Depends on: ws

const WebSocket = require("ws");

function createNoopDesktopRefresher() {
  return {
    handleInbound() {},
    handleOutbound() {},
    handleTransportReset() {},
  };
}

function shutdown(codex, getSocket, beforeExit = () => {}) {
  beforeExit();

  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  }

  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
}

module.exports = {
  createNoopDesktopRefresher,
  shutdown,
};
