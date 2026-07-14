// FILE: ipc-owner/router.js
// Purpose: Fallback Desktop IPC router for local owner/follower clients.

const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  CLIENT_STATUS_CHANGED,
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  normalizeToken,
  readString,
  requestIdKey,
  safeParseJSON,
  writeFrame,
} = require("../desktop-ipc-shared");

function createDesktopIpcRouterServer({
  socketPath,
  netModule,
  now,
  requestTimeoutMs,
  discoveryTimeoutMs,
  logPrefix,
}) {
  let server = null;
  let started = false;
  let starting = null;
  let closed = false;
  let nextClientSeq = 1;
  const clientsById = new Map();
  const pendingDiscoveryResponses = new Map();
  const pendingRoutedResponses = new Map();

  function start({ removeStaleSocket = false } = {}) {
    if (started) {
      return Promise.resolve();
    }
    if (starting) {
      return starting;
    }
    closed = false;
    starting = new Promise((resolve, reject) => {
      try {
        prepareSocketPathForListen(socketPath, { removeStaleSocket });
      } catch (error) {
        starting = null;
        reject(error);
        return;
      }

      const nextServer = netModule.createServer((socket) => attachClient(socket));
      server = nextServer;
      nextServer.on("error", (error) => {
        starting = null;
        server = null;
        reject(error);
      });
      nextServer.listen(socketPath, () => {
        started = true;
        starting = null;
        nextServer.removeAllListeners("error");
        nextServer.on("error", (error) => {
          console.warn(`${logPrefix} desktop IPC router fallback error: ${error.message}`);
        });
        resolve();
      });
      nextServer.unref?.();
    });
    return starting;
  }

  function attachClient(socket) {
    const client = {
      id: "",
      type: "",
      socket,
      buffer: Buffer.alloc(0),
      initialized: false,
    };
    socket.on("data", (chunk) => handleClientData(client, chunk));
    socket.on("close", () => removeClient(client));
    socket.on("error", () => removeClient(client));
  }

  function handleClientData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (client.buffer.length >= FRAME_HEADER_BYTES) {
      const frameLength = client.buffer.readUInt32LE(0);
      if (frameLength > MAX_FRAME_BYTES) {
        client.socket.destroy();
        return;
      }
      if (client.buffer.length < FRAME_HEADER_BYTES + frameLength) {
        return;
      }

      const payload = client.buffer.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength).toString("utf8");
      client.buffer = client.buffer.slice(FRAME_HEADER_BYTES + frameLength);
      const envelope = safeParseJSON(payload);
      if (envelope) {
        dispatchClientEnvelope(client, envelope);
      }
    }
  }

  function dispatchClientEnvelope(client, envelope) {
    if (envelope.type === "request" && envelope.method === "initialize") {
      initializeClient(client, envelope);
      return;
    }
    if (envelope.type === "broadcast") {
      relayBroadcast(client, envelope);
      return;
    }
    if (envelope.type === "request") {
      routeClientRequest(client, envelope);
      return;
    }
    if (envelope.type === "response") {
      routeClientResponse(client, envelope);
      return;
    }
    if (envelope.type === "client-discovery-request") {
      answerClientDiscoveryRequest(client, envelope);
      return;
    }
    if (envelope.type === "client-discovery-response") {
      resolveDiscoveryResponse(envelope);
    }
  }

  function initializeClient(client, envelope) {
    if (!client.id) {
      client.id = `agnt-router-${now().toString(36)}-${nextClientSeq}`;
      nextClientSeq += 1;
      clientsById.set(client.id, client);
    }
    client.initialized = true;
    client.type = readString(envelope.params?.clientType) || readString(envelope.params?.client_type);
    writeEnvelopeToClient(client, {
      type: "response",
      requestId: envelope.requestId,
      resultType: "success",
      method: "initialize",
      handledByClientId: "agnt-ipc-router",
      result: { clientId: client.id },
    });
    relayBroadcast(client, {
      type: "broadcast",
      method: CLIENT_STATUS_CHANGED,
      sourceClientId: client.id,
      version: METHOD_VERSION_BY_NAME.get(CLIENT_STATUS_CHANGED) || 1,
      params: {
        clientId: client.id,
        clientType: client.type,
        status: "connected",
      },
    });
  }

  function relayBroadcast(sender, envelope) {
    const normalizedEnvelope = {
      ...envelope,
      sourceClientId: readString(envelope.sourceClientId) || sender.id,
      version: envelope.version || METHOD_VERSION_BY_NAME.get(envelope.method) || 1,
    };
    for (const client of clientsById.values()) {
      if (!client.initialized || client === sender) {
        continue;
      }
      writeEnvelopeToClient(client, normalizedEnvelope);
    }
  }

  async function routeClientRequest(sender, envelope) {
    const target = await discoverTargetForRequest(sender, envelope);
    if (!target) {
      writeEnvelopeToClient(sender, {
        type: "response",
        requestId: envelope.requestId,
        resultType: "error",
        method: envelope.method,
        handledByClientId: "",
        error: `No Codex IPC client can handle ${envelope.method}.`,
      });
      return;
    }
    const requestId = requestIdKey(envelope.requestId);
    if (!requestId) {
      writeEnvelopeToClient(sender, {
        type: "response",
        requestId: envelope.requestId,
        resultType: "error",
        method: envelope.method,
        handledByClientId: target.id,
        error: "Missing requestId.",
      });
      return;
    }

    // JSON-RPC request ids are only unique per connection, so forward a rewritten
    // router-scoped id to keep concurrent same-id requests from colliding.
    const routedRequestId = `agnt-routed-${now().toString(36)}-${randomUUID()}`;
    const routeKey = routedResponseKey(target.id, routedRequestId);
    const timeout = setTimeout(() => {
      pendingRoutedResponses.delete(routeKey);
      writeEnvelopeToClient(sender, {
        type: "response",
        requestId: envelope.requestId,
        resultType: "error",
        method: envelope.method,
        handledByClientId: target.id,
        error: `Codex IPC routed request timed out: ${envelope.method}`,
      });
    }, requestTimeoutMs);
    timeout.unref?.();
    pendingRoutedResponses.set(routeKey, {
      sender,
      senderRequestId: envelope.requestId,
      timeout,
    });
    if (!writeEnvelopeToClient(target, {
      ...envelope,
      requestId: routedRequestId,
      sourceClientId: sender.id,
    })) {
      clearTimeout(timeout);
      pendingRoutedResponses.delete(routeKey);
      writeEnvelopeToClient(sender, {
        type: "response",
        requestId: envelope.requestId,
        resultType: "error",
        method: envelope.method,
        handledByClientId: target.id,
        error: "Codex IPC routed request write failed.",
      });
    }
  }

  function routeClientResponse(client, envelope) {
    const routeKey = routedResponseKey(client.id, requestIdKey(envelope.requestId));
    const route = pendingRoutedResponses.get(routeKey);
    if (!route) {
      return;
    }
    pendingRoutedResponses.delete(routeKey);
    clearTimeout(route.timeout);
    writeEnvelopeToClient(route.sender, {
      ...envelope,
      requestId: route.senderRequestId,
    });
  }

  async function answerClientDiscoveryRequest(sender, envelope) {
    const target = await discoverTargetForRequest(sender, envelope.request || envelope);
    writeEnvelopeToClient(sender, {
      type: "client-discovery-response",
      requestId: envelope.requestId,
      response: {
        canHandle: Boolean(target),
      },
    });
  }

  async function discoverTargetForRequest(sender, request) {
    const candidates = Array.from(clientsById.values()).filter((client) => (
      client.initialized && client !== sender && !client.socket.destroyed
    ));
    const results = await Promise.all(candidates.map(async (candidate, index) => {
      const canHandle = await askClientCanHandle(candidate, request);
      return canHandle ? { client: candidate, index } : null;
    }));
    return results
      .filter(Boolean)
      .sort(compareDiscoveryTargets)[0]?.client || null;
  }

  function compareDiscoveryTargets(left, right) {
    const priorityDelta = discoveryTargetPriority(left.client) - discoveryTargetPriority(right.client);
    return priorityDelta || left.index - right.index;
  }

  function discoveryTargetPriority(client) {
    // If both sides claim a follower request, the bridge's tagged live owner wins
    // over stale Desktop state to keep phone-owned streams on the local runtime.
    return normalizeToken(client?.type) === "agntbridge" ? 0 : 1;
  }

  function askClientCanHandle(client, request) {
    const requestId = `agnt-router-discovery-${now().toString(36)}-${randomUUID()}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingDiscoveryResponses.delete(requestId);
        resolve(false);
      }, discoveryTimeoutMs);
      timeout.unref?.();
      pendingDiscoveryResponses.set(requestId, {
        resolve,
        timeout,
      });
      if (!writeEnvelopeToClient(client, {
        type: "client-discovery-request",
        requestId,
        request,
      })) {
        clearTimeout(timeout);
        pendingDiscoveryResponses.delete(requestId);
        resolve(false);
      }
    });
  }

  function resolveDiscoveryResponse(envelope) {
    const requestId = requestIdKey(envelope.requestId);
    const pending = requestId ? pendingDiscoveryResponses.get(requestId) : null;
    if (!pending) {
      return;
    }
    pendingDiscoveryResponses.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(Boolean(envelope.response?.canHandle));
  }

  function removeClient(client) {
    if (client.id) {
      clientsById.delete(client.id);
      relayBroadcast(client, {
        type: "broadcast",
        method: CLIENT_STATUS_CHANGED,
        sourceClientId: client.id,
        version: METHOD_VERSION_BY_NAME.get(CLIENT_STATUS_CHANGED) || 1,
        params: {
          clientId: client.id,
          clientType: client.type,
          status: "disconnected",
        },
      });
    }
    for (const [routeKey, route] of Array.from(pendingRoutedResponses.entries())) {
      if (!routeKey.startsWith(`${client.id}:`)) {
        continue;
      }
      pendingRoutedResponses.delete(routeKey);
      clearTimeout(route.timeout);
      writeEnvelopeToClient(route.sender, {
        type: "response",
        requestId: route.senderRequestId,
        resultType: "error",
        method: "",
        handledByClientId: client.id,
        error: "Codex IPC target disconnected.",
      });
    }
  }

  function close() {
    const shouldRemoveSocketPath = started || server;
    closed = true;
    started = false;
    starting = null;
    for (const pending of pendingDiscoveryResponses.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    pendingDiscoveryResponses.clear();
    for (const route of pendingRoutedResponses.values()) {
      clearTimeout(route.timeout);
    }
    pendingRoutedResponses.clear();
    for (const client of clientsById.values()) {
      client.socket.destroy();
    }
    clientsById.clear();
    if (server) {
      server.close();
      server = null;
    }
    if (shouldRemoveSocketPath) {
      removeSocketPathAfterClose(socketPath);
    }
  }

  function writeEnvelopeToClient(client, envelope) {
    if (!client?.socket || client.socket.destroyed) {
      return false;
    }
    try {
      writeFrame(client.socket, JSON.stringify(envelope));
      return true;
    } catch {
      client.socket.destroy();
      return false;
    }
  }

  return {
    start,
    close,
    get isStarted() {
      return started && !closed;
    },
  };
}

function routedResponseKey(clientId, requestId) {
  return `${clientId}:${requestId}`;
}

function prepareSocketPathForListen(socketPath, { removeStaleSocket = false } = {}) {
  if (process.platform === "win32") {
    return;
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (removeStaleSocket && fs.existsSync(socketPath)) {
    const socketStat = fs.lstatSync(socketPath);
    if (!socketStat.isSocket()) {
      throw new Error(`Refusing to replace non-socket Codex IPC path: ${socketPath}`);
    }
    fs.unlinkSync(socketPath);
  }
}

function removeSocketPathAfterClose(socketPath) {
  if (process.platform === "win32") {
    return;
  }
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Best-effort cleanup only; the next fallback start can remove stale sockets.
  }
}

module.exports = { createDesktopIpcRouterServer };
