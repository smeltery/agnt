// FILE: desktop-ipc-client.js
// Purpose: Owns the low-level length-prefixed Codex Desktop IPC socket client.
// Layer: CLI helper
// Exports: createDesktopIpcClient, isDeliveryFailureError, markDeliveryFailureError
// Depends on: ./desktop-ipc-shared

const {
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  buildIpcRequestEnvelope,
  createFrameReader,
  readString,
  requestIdKey,
  resolveIpcSocketPathCandidates,
  toSocketPathCandidatesResolver,
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
  let lastActivityAt = 0;
  let remainingSocketPaths = [];
  const pendingRequests = new Map();
  const pendingDiscoveries = new Map();
  const frameReader = createFrameReader({
    onFrame: (envelope) => dispatchEnvelope(envelope),
    onOverflow: () => close(),
  });
  const resolveSocketPaths = toSocketPathCandidatesResolver(socketPath || resolveIpcSocketPathCandidates);

  function ensureConnected() {
    if (socket || isConnecting) {
      return;
    }

    remainingSocketPaths = resolveSocketPaths();
    connectNextSocket();
  }

  function connectNextSocket() {
    const nextSocketPath = remainingSocketPaths.shift();
    if (!nextSocketPath) {
      isConnecting = false;
      return;
    }

    isConnecting = true;
    const nextSocket = netModule.createConnection(nextSocketPath);
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
    nextSocket.on("close", () => handleClose(nextSocket));
    nextSocket.on("error", (error) => {
      if ((error?.code === "ENOENT" || error?.code === "ECONNREFUSED")
        && remainingSocketPaths.length > 0) {
        retryNextSocket(nextSocket);
        return;
      }
      if (error?.code !== "ENOENT" && error?.code !== "ECONNREFUSED") {
        console.warn(`${logPrefix} desktop IPC connection failed: ${error.message}`);
      }
    });
  }

  function retryNextSocket(failedSocket) {
    if (socket === failedSocket) {
      socket = null;
    }
    isConnecting = false;
    frameReader.reset();
    failedSocket.destroy();
    connectNextSocket();
  }

  function sendRequest(method, params, { targetClientId, returnEnvelope = false, timeoutMs = requestTimeoutMs } = {}) {
    ensureConnected();
    if (!socket || socket.destroyed) {
      return Promise.reject(markDeliveryFailureError(new Error("Desktop IPC is not connected.")));
    }

    const requestId = `agnt-${now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const envelope = buildIpcRequestEnvelope({
      requestId,
      method,
      params,
      clientId,
      initializing: method === "initialize",
    });

    if (targetClientId) envelope.targetClientId = targetClientId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();

      pendingRequests.set(requestId, {
        returnEnvelope,
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

  function sendBroadcast(method, params, { targetClientIds } = {}) {
    ensureConnected();
    if (!socket || socket.destroyed || !clientId) {
      return false;
    }
    const envelope = {
      type: "broadcast",
      method,
      sourceClientId: clientId,
      params: params || {},
      version: METHOD_VERSION_BY_NAME.get(method) || 1,
    };
    if (Array.isArray(targetClientIds) && targetClientIds.length > 0) {
      envelope.targetClientIds = targetClientIds;
    }
    writeEnvelope(envelope);
    return true;
  }

  function handleData(chunk) {
    if (chunk.length > 0) {
      lastActivityAt = now();
    }
    frameReader.push(chunk);
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

      waiter.resolve(waiter.returnEnvelope ? envelope : envelope.result ?? null);
      return;
    }

    onEnvelope(envelope);
  }

  function handleClose(closedSocket) {
    if (socket && socket !== closedSocket) {
      return;
    }
    socket = null;
    clientId = "";
    isConnecting = false;
    lastActivityAt = 0;
    remainingSocketPaths = [];
    frameReader.reset();
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
    get clientId() {
      return clientId;
    },
    ensureConnected,
    isConnected() {
      return Boolean(socket && !socket.destroyed && clientId);
    },
    hasRecentActivity(maxAgeMs) {
      return Boolean(socket && !socket.destroyed && clientId)
        && lastActivityAt > 0
        && now() - lastActivityAt <= Math.max(0, Number(maxAgeMs) || 0);
    },
    sendRequest,
    sendDiscoveryRequest,
    sendBroadcast,
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
