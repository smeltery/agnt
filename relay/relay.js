// FILE: relay.js
// Purpose: Thin self-hostable WebSocket relay for agnt pairing, trusted-session lookup, and encrypted forwarding.
// Layer: Standalone server module
// Exports: setupRelay, getRelayStats, hasActiveMacSession, hasAuthenticatedMacSession, resolveTrustedMacSession, resolvePairingCode

const { createHash } = require("crypto");
const { WebSocket } = require("ws");
const { createTrustedSessionRegistry } = require("./trusted-session-registry");

const CLEANUP_DELAY_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLOSE_CODE_SESSION_UNAVAILABLE = 4002;
const CLOSE_CODE_IPHONE_REPLACED = 4003;
const CLOSE_CODE_MAC_ABSENCE_BUFFER_FULL = 4004;
const MAC_ABSENCE_GRACE_MS = 15_000;

// In-memory session registry for one Mac host and one live mobile client per session.
const sessions = new Map();
const relayMetrics = {
  startedAt: Date.now(),
  acceptedConnections: 0,
  closedConnections: 0,
  heartbeatTerminations: 0,
  macMessagesRelayed: 0,
  mobileMessagesRelayed: 0,
  mobileMessagesRejectedDuringMacAbsence: 0,
};

function normalizeRelayRole(value) {
  return (readHeaderString(value) || "").toLowerCase();
}

function isRelayMobileRole(role) {
  return role === "iphone" || role === "android";
}

function readRelayRole(req, urlPath) {
  const headerRole = normalizeRelayRole(req?.headers?.["x-role"]);
  if (headerRole) {
    return headerRole;
  }

  // Browsers and some mobile WebSocket stacks cannot set custom headers, so
  // accept the same untrusted mobile role value through the relay URL query.
  try {
    return normalizeRelayRole(new URL(urlPath || "/", "http://relay.local").searchParams.get("role"));
  } catch {
    return "";
  }
}

const trustedSessionRegistry = createTrustedSessionRegistry({ hasActiveMacSession });

// Attaches relay behavior to a ws WebSocketServer instance.
function setupRelay(
  wss,
  {
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    macAbsenceGraceMs = MAC_ABSENCE_GRACE_MS,
  } = {}
) {
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._relayAlive === false) {
        relayMetrics.heartbeatTerminations += 1;
        console.warn(
          `[relay] heartbeat terminated ${ws._relayRole || "unknown"} `
          + `${relaySessionLogLabel(ws._relaySessionId || "")}`
        );
        ws.terminate();
        continue;
      }
      ws._relayAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws, req) => {
    const urlPath = req.url || "";
    const match = urlPath.match(/^\/relay\/([^/?]+)/);
    const sessionId = match?.[1];
    const role = readRelayRole(req, urlPath);
    relayMetrics.acceptedConnections += 1;
    ws._relaySessionId = sessionId;
    ws._relayRole = role;

    if (!sessionId || (role !== "mac" && !isRelayMobileRole(role))) {
      ws.close(4000, "Missing sessionId or invalid role");
      return;
    }

    ws._relayAlive = true;
    ws.on("pong", () => {
      ws._relayAlive = true;
    });

    // Only the Mac host is allowed to create a fresh session room.
    if (isRelayMobileRole(role) && !sessions.has(sessionId)) {
      ws.close(CLOSE_CODE_SESSION_UNAVAILABLE, "Mac session not available");
      return;
    }

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        mac: null,
        macRegistration: null,
        clients: new Set(),
        cleanupTimer: null,
        macAbsenceTimer: null,
        notificationSecret: null,
      });
    }

    const session = sessions.get(sessionId);

    if (isRelayMobileRole(role) && !canAcceptMobileClientConnection(session)) {
      ws.close(CLOSE_CODE_SESSION_UNAVAILABLE, "Mac session not available");
      return;
    }

    if (session.cleanupTimer) {
      clearTimeoutFn(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    if (role === "mac") {
      clearMacAbsenceTimer(session, { clearTimeoutFn });
      // The relay keeps a per-session push secret so first-time device registration
      // cannot be claimed by someone who only knows the session id.
      session.notificationSecret = readHeaderString(req.headers["x-notification-secret"]);
      session.macRegistration = trustedSessionRegistry.readMacRegistrationHeaders(req.headers, sessionId);
      if (session.mac && session.mac.readyState === WebSocket.OPEN) {
        session.mac.close(4001, "Replaced by new Mac connection");
      }
      session.mac = ws;
      trustedSessionRegistry.registerLiveMacSession(session.macRegistration);
      console.log(`[relay] Mac connected -> ${relaySessionLogLabel(sessionId)}`);
    } else {
      // Keep one live mobile RPC client per session to avoid competing sockets.
      for (const existingClient of session.clients) {
        if (existingClient === ws) {
          continue;
        }
        if (
          existingClient.readyState === WebSocket.OPEN
          || existingClient.readyState === WebSocket.CONNECTING
        ) {
          existingClient.close(
            CLOSE_CODE_IPHONE_REPLACED,
            "Replaced by newer mobile connection"
          );
        }
        session.clients.delete(existingClient);
      }

      session.clients.add(ws);
      console.log(
        `[relay] Mobile connected (${role}) -> ${relaySessionLogLabel(sessionId)} `
        + `(${session.clients.size} client(s))`
      );
    }

    ws.on("message", (data) => {
      const msg = typeof data === "string" ? data : data.toString("utf-8");
      if (role === "mac" && trustedSessionRegistry.applyMacRegistrationMessage(session, sessionId, msg)) {
        return;
      }

      if (role === "mac") {
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            relayMetrics.macMessagesRelayed += 1;
            client.send(msg);
          }
        }
      } else if (session.mac?.readyState === WebSocket.OPEN) {
        relayMetrics.mobileMessagesRelayed += 1;
        session.mac.send(msg);
      } else {
        // The relay cannot prove a buffered request really reached the bridge after
        // a reconnect, so fail fast with an explicit retry-required close instead
        // of silently dropping queued client work during a later flush.
        relayMetrics.mobileMessagesRejectedDuringMacAbsence += 1;
        ws.close(CLOSE_CODE_MAC_ABSENCE_BUFFER_FULL, "Mac temporarily unavailable");
      }
    });

    ws.on("close", () => {
      relayMetrics.closedConnections += 1;
      if (role === "mac") {
        if (session.mac === ws) {
          session.mac = null;
          trustedSessionRegistry.unregisterLiveMacSession(session.macRegistration, sessionId);
          console.log(`[relay] Mac disconnected -> ${relaySessionLogLabel(sessionId)}`);
          if (session.clients.size > 0) {
            scheduleMacAbsenceTimeout(sessionId, {
              macAbsenceGraceMs,
              setTimeoutFn,
              clearTimeoutFn,
            });
          } else {
            scheduleCleanup(sessionId, { setTimeoutFn });
          }
        }
      } else {
        session.clients.delete(ws);
        console.log(
          `[relay] Mobile disconnected (${role}) -> ${relaySessionLogLabel(sessionId)} `
          + `(${session.clients.size} remaining)`
        );
      }
      scheduleCleanup(sessionId, { setTimeoutFn });
    });

    ws.on("error", (err) => {
      console.error(
        `[relay] WebSocket error (${role}, ${relaySessionLogLabel(sessionId)}):`,
        err.message
      );
    });
  });
}

function scheduleCleanup(sessionId, { setTimeoutFn = setTimeout } = {}) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  if (session.mac || session.clients.size > 0 || session.cleanupTimer || session.macAbsenceTimer) {
    return;
  }

  session.cleanupTimer = setTimeoutFn(() => {
    const activeSession = sessions.get(sessionId);
    if (
      activeSession
      && !activeSession.mac
      && activeSession.clients.size === 0
      && !activeSession.macAbsenceTimer
    ) {
      trustedSessionRegistry.unregisterLiveMacSession(activeSession.macRegistration, sessionId);
      sessions.delete(sessionId);
      console.log(`[relay] ${relaySessionLogLabel(sessionId)} cleaned up`);
    }
  }, CLEANUP_DELAY_MS);
  session.cleanupTimer.unref?.();
}

function scheduleMacAbsenceTimeout(
  sessionId,
  {
    macAbsenceGraceMs,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}
) {
  const session = sessions.get(sessionId);
  if (!session || session.mac || session.macAbsenceTimer) {
    return;
  }

  session.macAbsenceTimer = setTimeoutFn(() => {
    const activeSession = sessions.get(sessionId);
    if (!activeSession) {
      return;
    }

    activeSession.macAbsenceTimer = null;
    activeSession.notificationSecret = null;
    trustedSessionRegistry.unregisterLiveMacSession(activeSession.macRegistration, sessionId);
    closeSessionClients(activeSession, CLOSE_CODE_SESSION_UNAVAILABLE, "Mac disconnected");
    scheduleCleanup(sessionId, { setTimeoutFn });
  }, macAbsenceGraceMs);
  session.macAbsenceTimer.unref?.();

  if (session.cleanupTimer) {
    clearTimeoutFn(session.cleanupTimer);
    session.cleanupTimer = null;
  }
}

function clearMacAbsenceTimer(session, { clearTimeoutFn = clearTimeout } = {}) {
  if (!session?.macAbsenceTimer) {
    return;
  }

  clearTimeoutFn(session.macAbsenceTimer);
  session.macAbsenceTimer = null;
}

function canAcceptMobileClientConnection(session) {
  if (!session) {
    return false;
  }

  if (session.mac?.readyState === WebSocket.OPEN) {
    return true;
  }

  // Lets the phone rejoin the same relay session while the Mac is still inside
  // the temporary-absence grace window instead of forcing a full disconnect flow.
  return Boolean(session.macAbsenceTimer);
}

function closeSessionClients(session, code, reason) {
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(code, reason);
    }
  }
}

function relaySessionLogLabel(sessionId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return "session=[redacted]";
  }

  const digest = createHash("sha256")
    .update(normalizedSessionId)
    .digest("hex")
    .slice(0, 8);
  return `session#${digest}`;
}

// Exposes lightweight runtime stats for health/status endpoints.
function getRelayStats() {
  let totalClients = 0;
  let sessionsWithMac = 0;
  let sessionsWithOpenMac = 0;
  let sessionsWithStaleMac = 0;
  let sessionsWithClients = 0;
  let cleanupPending = 0;
  let macAbsencePending = 0;

  for (const session of sessions.values()) {
    totalClients += session.clients.size;
    if (session.clients.size > 0) {
      sessionsWithClients += 1;
    }
    if (session.mac) {
      sessionsWithMac += 1;
      if (session.mac.readyState === WebSocket.OPEN) {
        sessionsWithOpenMac += 1;
      } else {
        sessionsWithStaleMac += 1;
      }
    }
    if (session.cleanupTimer) {
      cleanupPending += 1;
    }
    if (session.macAbsenceTimer) {
      macAbsencePending += 1;
    }
  }

  return {
    activeSessions: sessions.size,
    sessionsWithMac,
    sessionsWithOpenMac,
    sessionsWithStaleMac,
    sessionsWithClients,
    totalClients,
    pairingCodes: trustedSessionRegistry.pairingCodeCount(),
    cleanupPending,
    macAbsencePending,
    uptimeSeconds: Math.round((Date.now() - relayMetrics.startedAt) / 1000),
    acceptedConnections: relayMetrics.acceptedConnections,
    closedConnections: relayMetrics.closedConnections,
    heartbeatTerminations: relayMetrics.heartbeatTerminations,
    macMessagesRelayed: relayMetrics.macMessagesRelayed,
    mobileMessagesRelayed: relayMetrics.mobileMessagesRelayed,
    mobileMessagesRejectedDuringMacAbsence: relayMetrics.mobileMessagesRejectedDuringMacAbsence,
  };
}

// Lets the push-registration side verify that a session still belongs to a live Mac bridge.
function hasActiveMacSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return false;
  }

  const session = sessions.get(sessionId.trim());
  return Boolean(session?.mac && session.mac.readyState === WebSocket.OPEN);
}

// Used by: relay/server.js push registration gate.
function hasAuthenticatedMacSession(sessionId, notificationSecret) {
  if (!hasActiveMacSession(sessionId)) {
    return false;
  }

  const session = sessions.get(sessionId.trim());
  return session?.notificationSecret === readHeaderString(notificationSecret);
}

function resolvePairingCode(request) {
  return trustedSessionRegistry.resolvePairingCode(request);
}

function resolveTrustedMacSession(request) {
  return trustedSessionRegistry.resolveTrustedMacSession(request);
}

function readHeaderString(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

module.exports = {
  setupRelay,
  getRelayStats,
  hasActiveMacSession,
  hasAuthenticatedMacSession,
  resolvePairingCode,
  resolveTrustedMacSession,
};
