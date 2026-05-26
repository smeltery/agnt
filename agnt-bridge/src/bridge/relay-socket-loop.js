// FILE: bridge/relay-socket-loop.js
// Purpose: Owns the long-lived WebSocket connection to the relay and the
//          policy that decides "give up vs. reconnect" when it drops.
//          Every per-event side effect (status logging, watchdog start/stop,
//          watcher teardown, secure-transport wiring, app-message delivery)
//          is injected as a callback so bridge.js can keep its orchestration
//          state but stop hand-rolling the socket lifecycle.
// Layer: bridge orchestration
// Exports: createRelaySocketLoop
//
// Why this is its own module: bridge.js used to inline two ~80-line
// functions (connectRelay + scheduleRelayReconnect) alongside provider
// resolution and reconnect bookkeeping. The lifecycle here is mechanical
// (WebSocket events, close-code policy, retry scheduling); the bridge-specific
// behavior is in the callbacks. Splitting the two makes the loop testable
// against a fake WebSocket implementation without booting the relay.
//
// State semantics:
//   - getSocket() returns the *currently tracked* socket. A late event from
//     a stale socket is ignored (matches the `socket === nextSocket` guards
//     the bridge used to keep inline).
//   - connect() is idempotent against isShuttingDown(): a shutdown in
//     progress is a no-op.
//   - On close, shouldShutdownOnClose(code) decides between onShutdown()
//     and scheduling a reconnect via reconnectScheduler. Default policy
//     in bridge.js: codes 4000 and 4001 mean "the relay is rejecting this
//     pairing forever — don't loop".

/**
 * @param {object} opts
 * @param {Function} opts.WebSocketCtor             new-able WebSocket class (injected so tests can fake it).
 * @param {() => string} opts.relaySessionUrl       URL to dial. Captured fresh each connect.
 * @param {() => object} opts.buildHeaders          Builds the request headers each connect (so deviceState updates land).
 * @param {() => boolean} opts.isShuttingDown       Bridge tells the loop to stop reconnecting.
 * @param {object} opts.reconnectScheduler          From createRelayReconnectScheduler — { schedule, clear, resetAttempt, isPending }.
 * @param {(code: number) => boolean} opts.shouldShutdownOnClose
 *                                                  Returns true for close codes that should bypass reconnect.
 * @param {() => void} opts.onShutdown              Fires when shouldShutdownOnClose returns true.
 * @param {(status: "connecting" | "connected" | "disconnected") => void} opts.onStatus
 *                                                  Bridge logs connection state. Called on entry to each phase.
 * @param {() => void} opts.markActivity            Bridge heartbeat: any traffic counts as alive.
 * @param {(socket: object) => void} opts.startWatchdog   Bridge heartbeat: kick off the stale-socket detector.
 * @param {() => void} opts.clearWatchdog                  Bridge heartbeat: cancel the stale-socket detector.
 * @param {(socket: object) => void} opts.onOpen           Bridge wiring after the socket opens (secure transport binding etc.).
 * @param {() => void} opts.onTeardown                     Bridge teardown after a socket closes (stop watchers).
 * @param {(message: string, ctx: { sendControlMessage: (m: object) => void, onApplicationMessage: (m: object) => void }) => boolean} opts.handleIncomingWireMessage
 *                                                          Secure-transport dispatch.
 * @param {(message: object) => void} opts.onApplicationMessage
 *                                                          Decrypted payload → bridge router.
 * @returns {{ connect: () => void, scheduleReconnect: (closeCode: number) => void, getSocket: () => object|null }}
 */
function createRelaySocketLoop({
  WebSocketCtor,
  relaySessionUrl,
  buildHeaders,
  isShuttingDown,
  reconnectScheduler,
  shouldShutdownOnClose,
  onShutdown,
  onStatus,
  markActivity,
  startWatchdog,
  clearWatchdog,
  onOpen,
  onTeardown,
  handleIncomingWireMessage,
  onApplicationMessage,
}) {
  let socket = null;

  function connect() {
    if (isShuttingDown()) return;

    onStatus("connecting");
    const nextSocket = new WebSocketCtor(relaySessionUrl(), {
      // Saves uplink bytes on long history payloads (thread/read,
      // thread/turns/list) where the per-message overhead is small relative
      // to the body. Threshold/concurrency-limit match the wss defaults so
      // we don't trade memory for compression on tiny control frames.
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        threshold: 256,
        concurrencyLimit: 4,
      },
      headers: buildHeaders(),
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      markActivity();
      reconnectScheduler.clear();
      reconnectScheduler.resetAttempt();
      startWatchdog(nextSocket);
      onStatus("connected");
      onOpen(nextSocket);
    });

    nextSocket.on("message", (data) => {
      markActivity();
      const message = typeof data === "string" ? data : data.toString("utf8");
      handleIncomingWireMessage(message, {
        sendControlMessage(controlMessage) {
          if (nextSocket.readyState === WebSocketCtor.OPEN) {
            nextSocket.send(JSON.stringify(controlMessage));
          }
        },
        onApplicationMessage,
      });
    });

    nextSocket.on("ping", markActivity);
    nextSocket.on("pong", markActivity);

    nextSocket.on("close", (code) => {
      // Late events from a socket we already replaced (e.g. terminate-then-
      // reconnect) must not tear down the live socket's watchers.
      if (socket === nextSocket) {
        clearWatchdog();
        socket = null;
      }
      onStatus("disconnected");
      onTeardown();
      scheduleReconnect(code);
    });

    nextSocket.on("error", () => {
      if (socket === nextSocket) {
        clearWatchdog();
      }
      onStatus("disconnected");
    });
  }

  function scheduleReconnect(closeCode) {
    if (isShuttingDown()) return;

    if (shouldShutdownOnClose(closeCode)) {
      onStatus("disconnected");
      onShutdown();
      return;
    }

    if (reconnectScheduler.isPending()) return;

    onStatus("connecting");
    reconnectScheduler.schedule(connect);
  }

  return {
    connect,
    scheduleReconnect,
    getSocket: () => socket,
  };
}

module.exports = { createRelaySocketLoop };
