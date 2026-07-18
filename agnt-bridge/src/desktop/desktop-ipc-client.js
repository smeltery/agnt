// FILE: desktop-ipc-client.js
// Purpose: Owns the low-level length-prefixed Codex Desktop IPC socket client.
// Layer: CLI helper
// Exports: createDesktopIpcClient, isDeliveryFailureError, markDeliveryFailureError
// Depends on: ./desktop-ipc-shared

const {
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  readString,
  requestIdKey,
  safeParseJSON,
  writeFrame,
} = require("./desktop-ipc-shared");

function createDesktopIpcClient({
  socketPath,
  netModule,
  now,
  requestTimeoutMs,
  logPrefix,
  onEnvelope,
  onConnected,
  onDisconnect,
}) {
  let socket = null;
  let clientId = "";
  let isConnecting = false;
  let readBuffer = Buffer.alloc(0);
  const pendingRequests = new Map();
  const pendingDiscoveries = new Map();

  function ensureConnected() {
    if (socket || isConnecting) {
      return;
    }

    isConnecting = true;
    const nextSocket = netModule.createConnection(socketPath);
    socket = nextSocket;

    nextSocket.on("connect", () => {
      isConnecting = false;
      sendRequest("initialize", { clientType: "agnt-bridge" })
        .then((result) => {
          clientId = readString(result?.clientId) || clientId;
          onConnected?.(clientId);
        })
        .catch((error) => {
          console.warn(`${logPrefix} desktop IPC initialize failed: ${error.message}`);
          close();
        });
    });
    nextSocket.on("data", handleData);
    nextSocket.on("close", handleClose);
    nextSocket.on("error", (error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ECONNREFUSED") {
        console.warn(`${logPrefix} desktop IPC connection failed: ${error.message}`);
      }
    });
  }

  function sendRequest(method, params) {
    ensureConnected();
    if (!socket || socket.destroyed) {
      return Promise.reject(markDeliveryFailureError(new Error("Desktop IPC is not connected.")));
    }

    const requestId = `agnt-${now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const envelope = {
      type: "request",
      requestId,
      sourceClientId: method === "initialize" ? "initializing-client" : clientId || "agnt-bridge",
      version: METHOD_VERSION_BY_NAME.get(method) || 1,
      method,
      params: params || {},
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, requestTimeoutMs);
      timeout.unref?.();

      pendingRequests.set(requestId, {
        method,
        resolve,
        reject,
        timeout,
      });
      writeFrame(socket, JSON.stringify(envelope), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(markDeliveryFailureError(error));
      });
    });
  }

  // Resolves true/false from a discovery answer, or null when nobody answers in
  // time, so callers can fall back to their own timers.
  function sendDiscoveryRequest(request, timeoutMs) {
    ensureConnected();
    if (!socket || socket.destroyed) {
      return Promise.resolve(null);
    }

    const requestId = `agnt-discovery-${now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingDiscoveries.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timeout.unref?.();

      pendingDiscoveries.set(requestId, {
        resolve,
        timeout,
      });
      writeEnvelope({
        type: "client-discovery-request",
        requestId,
        request,
      }, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        pendingDiscoveries.delete(requestId);
        resolve(null);
      });
    });
  }

  function handleData(chunk) {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    while (readBuffer.length >= FRAME_HEADER_BYTES) {
      const frameLength = readBuffer.readUInt32LE(0);
      if (frameLength > MAX_FRAME_BYTES) {
        close();
        return;
      }
      if (readBuffer.length < FRAME_HEADER_BYTES + frameLength) {
        return;
      }

      const payload = readBuffer.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength).toString("utf8");
      readBuffer = readBuffer.slice(FRAME_HEADER_BYTES + frameLength);
      const envelope = safeParseJSON(payload);
      if (envelope) {
        dispatchEnvelope(envelope);
      }
    }
  }

  function dispatchEnvelope(envelope) {
    if (envelope.type === "client-discovery-request") {
      writeEnvelope({
        type: "client-discovery-response",
        requestId: envelope.requestId,
        response: {
          canHandle: false,
        },
      });
      return;
    }

    if (envelope.type === "client-discovery-response") {
      const requestId = requestIdKey(envelope.requestId);
      const pendingDiscovery = requestId ? pendingDiscoveries.get(requestId) : null;
      if (pendingDiscovery) {
        pendingDiscoveries.delete(requestId);
        clearTimeout(pendingDiscovery.timeout);
        pendingDiscovery.resolve(Boolean(envelope.response?.canHandle));
      }
      return;
    }

    if (envelope.type === "response") {
      const requestId = requestIdKey(envelope.requestId);
      const waiter = requestId ? pendingRequests.get(requestId) : null;
      if (!waiter) {
        return;
      }

      pendingRequests.delete(requestId);
      clearTimeout(waiter.timeout);
      if (envelope.resultType === "error") {
        const error = new Error(envelope.error || `Desktop IPC request failed: ${waiter.method}`);
        // A no-handler routing error means the request never reached any client,
        // so callers may safely retry it against the local app-server. Codex
        // Desktop's router reports this case as "no-client-found".
        if (/no codex ipc client can handle|no-client-found/i.test(error.message)) {
          markDeliveryFailureError(error);
        }
        waiter.reject(error);
        return;
      }

      waiter.resolve(envelope.result ?? null);
      return;
    }

    onEnvelope(envelope);
  }

  function handleClose() {
    socket = null;
    clientId = "";
    isConnecting = false;
    readBuffer = Buffer.alloc(0);
    for (const waiter of pendingRequests.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Desktop IPC connection closed."));
    }
    pendingRequests.clear();
    for (const pendingDiscovery of pendingDiscoveries.values()) {
      clearTimeout(pendingDiscovery.timeout);
      pendingDiscovery.resolve(null);
    }
    pendingDiscoveries.clear();
    onDisconnect();
  }

  function close() {
    if (!socket) {
      return;
    }

    const nextSocket = socket;
    socket = null;
    nextSocket.destroy();
  }

  function writeEnvelope(envelope, callback = () => {}) {
    if (!socket || socket.destroyed) {
      callback(new Error("Desktop IPC is not connected."));
      return;
    }

    writeFrame(socket, JSON.stringify(envelope), callback);
  }

  return {
    ensureConnected,
    sendRequest,
    sendDiscoveryRequest,
    close,
  };
}

function markDeliveryFailureError(error) {
  error.agntDeliveryFailed = true;
  return error;
}

function isDeliveryFailureError(error) {
  return error?.agntDeliveryFailed === true;
}

module.exports = {
  createDesktopIpcClient,
  isDeliveryFailureError,
  markDeliveryFailureError,
};
