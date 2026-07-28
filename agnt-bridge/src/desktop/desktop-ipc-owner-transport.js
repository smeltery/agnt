// FILE: desktop-ipc-owner-transport.js
// Purpose: Framed IPC client and fallback router for the bridge's Desktop stream-owner role.
// Layer: CLI helper
// Exports: createDesktopOwnerIpcClient, createDesktopIpcRouterServer
// Depends on: crypto, fs, path, ./desktop-ipc-shared

const { randomUUID } = require("crypto");

const {
  buildIpcRequestEnvelope,
  createFrameReader,
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  readString,
  requestIdKey,
  resolveIpcSocketPathCandidates,
  toSocketPathCandidatesResolver,
  writeFrame,
} = require("./desktop-ipc-shared");
const { createDesktopIpcRouterServer } = require("./ipc-owner/router");

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;

function createDesktopOwnerIpcClient({
  socketPath,
  netModule,
  now,
  requestTimeoutMs,
  reconnectMs,
  logPrefix,
  startRouterWhenMissing = true,
  onConnected,
  onBroadcast,
  canHandleRequest,
  handleRequest,
}) {
  let socket = null;
  let isConnecting = false;
  let isInitialized = false;
  let clientId = "";
  let remainingSocketPaths = [];
  let reconnectTimer = null;
  let shouldReconnect = false;
  const resolveSocketPaths = toSocketPathCandidatesResolver(socketPath || resolveIpcSocketPathCandidates);
  const frameReader = createFrameReader({
    onFrame: (envelope) => dispatchEnvelope(envelope),
    onOverflow: () => closeSocket(),
  });
  const routerSocketPath = resolveSocketPaths()[0];
  const localRouter = startRouterWhenMissing
    ? createDesktopIpcRouterServer({
      socketPath: routerSocketPath,
      netModule,
      now,
      requestTimeoutMs,
      discoveryTimeoutMs: Math.min(requestTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS),
      logPrefix,
    })
    : null;
  const pendingResponses = new Map();

  function ensureConnected() {
    shouldReconnect = true;
    if (socket || isConnecting) {
      return;
    }
    clearReconnectTimer();
    remainingSocketPaths = resolveSocketPaths();
    connectNextSocket();
  }

  function connectNextSocket() {
    const nextSocketPath = remainingSocketPaths.shift();
    if (!nextSocketPath) {
      isConnecting = false;
      startLocalRouterAfterMissingSocket("ENOENT");
      return;
    }

    isConnecting = true;
    const nextSocket = netModule.createConnection(nextSocketPath);
    socket = nextSocket;

    nextSocket.on("connect", () => {
      isConnecting = false;
      sendRequest("initialize", { clientType: "agnt-bridge" }, { initializing: true })
        .then((result) => {
          clientId = readString(result?.clientId) || clientId;
          isInitialized = true;
          onConnected?.(clientId);
        })
        .catch((error) => {
          console.warn(`${logPrefix} desktop IPC live owner initialize failed: ${error.message}`);
          closeSocket();
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
      if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") {
        startLocalRouterAfterMissingSocket(error.code);
        return;
      }
      if (error?.code !== "ENOENT" && error?.code !== "ECONNREFUSED") {
        console.warn(`${logPrefix} desktop IPC live owner connection failed: ${error.message}`);
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

  function startLocalRouterAfterMissingSocket(reasonCode) {
    if (!localRouter || localRouter.isStarted) {
      return;
    }
    localRouter.start({ removeStaleSocket: reasonCode === "ECONNREFUSED" })
      .then(() => {
        if (!shouldReconnect) {
          return;
        }
        closeSocket();
        isConnecting = false;
        clearReconnectTimer();
        ensureConnected();
      })
      .catch((error) => {
        if (error?.code !== "EADDRINUSE") {
          console.warn(`${logPrefix} desktop IPC router fallback failed: ${error.message}`);
        }
      });
  }

  function sendBroadcast(method, params) {
    ensureConnected();
    if (!socket || socket.destroyed || !isInitialized) {
      return false;
    }
    const envelope = {
      type: "broadcast",
      method,
      sourceClientId: clientId,
      params: params || {},
      version: METHOD_VERSION_BY_NAME.get(method) || 1,
    };
    return writeEnvelope(envelope);
  }

  function sendRequest(method, params, { initializing = false } = {}) {
    ensureConnected();
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("Desktop IPC is not connected."));
    }
    const requestId = `agnt-owner-${now().toString(36)}-${randomUUID()}`;
    const envelope = buildIpcRequestEnvelope({
      requestId,
      method,
      params,
      clientId,
      initializing,
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResponses.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, requestTimeoutMs);
      timeout.unref?.();
      pendingResponses.set(requestId, {
        method,
        resolve,
        reject,
        timeout,
      });
      if (!writeEnvelope(envelope)) {
        clearTimeout(timeout);
        pendingResponses.delete(requestId);
        reject(new Error("Desktop IPC write failed."));
      }
    });
  }

  function handleData(chunk) {
    frameReader.push(chunk);
  }

  function dispatchEnvelope(envelope) {
    if (envelope.type === "response") {
      handleResponse(envelope);
      return;
    }
    if (envelope.type === "broadcast") {
      onBroadcast?.(envelope);
      return;
    }
    if (envelope.type === "client-discovery-request") {
      const canHandle = Boolean(canHandleRequest?.(envelope));
      writeEnvelope({
        type: "client-discovery-response",
        requestId: envelope.requestId,
        response: { canHandle },
      });
      return;
    }
    if (envelope.type === "request") {
      handleIncomingRequest(envelope);
    }
  }

  function handleResponse(envelope) {
    const requestId = requestIdKey(envelope.requestId);
    const waiter = requestId ? pendingResponses.get(requestId) : null;
    if (!waiter) {
      return;
    }
    pendingResponses.delete(requestId);
    clearTimeout(waiter.timeout);
    if (envelope.resultType === "error") {
      waiter.reject(new Error(envelope.error || `Desktop IPC request failed: ${waiter.method}`));
      return;
    }
    waiter.resolve(envelope.result ?? null);
  }

  function handleIncomingRequest(envelope) {
    Promise.resolve()
      .then(() => handleRequest(envelope))
      .then((result) => {
        writeEnvelope({
          type: "response",
          requestId: envelope.requestId,
          resultType: "success",
          method: envelope.method,
          handledByClientId: clientId,
          result: result ?? null,
        });
      })
      .catch((error) => {
        writeEnvelope({
          type: "response",
          requestId: envelope.requestId,
          resultType: "error",
          method: envelope.method,
          handledByClientId: clientId,
          error: error?.message || "agnt IPC owner request failed.",
        });
      });
  }

  function handleClose(closedSocket) {
    if (socket && socket !== closedSocket) {
      return;
    }
    socket = null;
    isConnecting = false;
    isInitialized = false;
    clientId = "";
    remainingSocketPaths = [];
    frameReader.reset();
    for (const waiter of pendingResponses.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Desktop IPC connection closed."));
    }
    pendingResponses.clear();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!shouldReconnect || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected();
    }, reconnectMs);
    reconnectTimer.unref?.();
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function closeSocket() {
    if (!socket) {
      return;
    }
    const closingSocket = socket;
    socket = null;
    closingSocket.destroy();
  }

  function close() {
    shouldReconnect = false;
    clearReconnectTimer();
    closeSocket();
    localRouter?.close();
    for (const waiter of pendingResponses.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Desktop IPC live owner stopped."));
    }
    pendingResponses.clear();
  }

  function writeEnvelope(envelope) {
    if (!socket || socket.destroyed) {
      return false;
    }
    try {
      writeFrame(socket, JSON.stringify(envelope));
      return true;
    } catch {
      closeSocket();
      return false;
    }
  }

  return {
    ensureConnected,
    sendBroadcast,
    close,
    get clientId() {
      return clientId;
    },
  };
}

module.exports = {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  createDesktopIpcRouterServer,
  createDesktopOwnerIpcClient,
};
