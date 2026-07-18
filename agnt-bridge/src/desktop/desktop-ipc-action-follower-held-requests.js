// FILE: desktop-ipc-action-follower-held-requests.js
// Purpose: Holds phone follower requests while Desktop ownership is still being probed.
// Layer: CLI helper
// Exports: createHeldFollowerRequestState
// Depends on: ./desktop-ipc-action-follower-support, ./desktop-ipc-shared

const {
  buildDesktopFollowerRoute,
} = require("./desktop-ipc-action-follower-support");
const {
  readString,
  safeParseJSON,
} = require("./desktop-ipc-shared");

function createHeldFollowerRequestState({
  activeThreads,
  forwardToLocalCodex,
  hasLiveOwnerThread,
  hasRawState,
  isLocallyOwnedThread,
  ipc,
  methodVersionByName,
  now,
  ownershipProbeTimeoutMs,
  sendApplicationResponse,
  submitDesktopFollowerRequest,
}) {
  const heldFollowerRequestsByThreadId = new Map();
  const ownershipProbeDeadlinesByThreadId = new Map();
  const pendingOwnershipProbeTokensByThreadId = new Map();
  const desktopOwnedByProbeThreadIds = new Set();
  let nextOwnershipProbeToken = 0;

  function setProbeDeadline(threadId) {
    ownershipProbeDeadlinesByThreadId.set(threadId, now() + ownershipProbeTimeoutMs);
  }

  function shouldHold(message, threadId) {
    if (typeof forwardToLocalCodex !== "function" || message?.id == null) {
      return false;
    }
    if (!threadId
      || !activeThreads.has(threadId)
      || hasRawState(threadId)
      || hasLiveOwnerThread(threadId)
      || isLocallyOwnedThread(threadId)) {
      return false;
    }
    const probeDeadline = ownershipProbeDeadlinesByThreadId.get(threadId);
    if (!probeDeadline || now() > probeDeadline) {
      ownershipProbeDeadlinesByThreadId.delete(threadId);
      return false;
    }
    return true;
  }

  function probeDesktopOwnership(route) {
    const threadId = route.threadId;
    if (pendingOwnershipProbeTokensByThreadId.has(threadId)) {
      return;
    }
    const probeToken = ++nextOwnershipProbeToken;
    pendingOwnershipProbeTokensByThreadId.set(threadId, probeToken);
    ipc.sendDiscoveryRequest({
      type: "request",
      method: route.method,
      version: methodVersionByName.get(route.method) || 1,
      params: route.params,
    }, ownershipProbeTimeoutMs)
      .then((canHandle) => {
        if (pendingOwnershipProbeTokensByThreadId.get(threadId) !== probeToken) {
          return;
        }
        pendingOwnershipProbeTokensByThreadId.delete(threadId);
        if (hasLiveOwnerThread(threadId) || isLocallyOwnedThread(threadId)) {
          return;
        }
        if (canHandle === true) {
          desktopOwnedByProbeThreadIds.add(threadId);
          release(threadId, { toDesktop: true });
        }
      });
  }

  function probeHeldRequests() {
    for (const [threadId, queue] of heldFollowerRequestsByThreadId.entries()) {
      if (!queue || queue.length === 0 || hasLiveOwnerThread(threadId)) {
        continue;
      }
      const message = safeParseJSON(queue[0].rawMessage);
      const route = message ? buildDesktopFollowerRoute(message) : null;
      if (route && shouldHold(message, threadId)) {
        probeDesktopOwnership(route);
      }
    }
  }

  function isDesktopRoutable(threadId) {
    return !hasLiveOwnerThread(threadId)
      && !isLocallyOwnedThread(threadId)
      && (hasRawState(threadId) || desktopOwnedByProbeThreadIds.has(threadId));
  }

  function hold(threadId, rawMessage) {
    const probeDeadline = ownershipProbeDeadlinesByThreadId.get(threadId) || 0;
    const message = safeParseJSON(rawMessage);
    const method = readString(message?.method);
    const entry = {
      rawMessage,
      timer: setTimeout(() => {
        const queue = heldFollowerRequestsByThreadId.get(threadId) || [];
        const index = queue.indexOf(entry);
        if (index < 0) {
          return;
        }
        queue.splice(index, 1);
        if (queue.length === 0) {
          heldFollowerRequestsByThreadId.delete(threadId);
        }
        routeExpiredThroughBus(rawMessage);
      }, Math.max(0, probeDeadline - now())),
    };
    entry.timer.unref?.();
    const queue = heldFollowerRequestsByThreadId.get(threadId) || [];
    if (method === "turn/start") {
      rejectQueuedTurnStarts(queue);
    }
    queue.push(entry);
    heldFollowerRequestsByThreadId.set(threadId, queue);
  }

  function rejectQueuedTurnStarts(queue) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      const message = safeParseJSON(entry.rawMessage);
      if (readString(message?.method) !== "turn/start") {
        continue;
      }
      queue.splice(index, 1);
      clearTimeout(entry.timer);
      rejectMessage(message, "Superseded by a newer held turn/start request.");
    }
  }

  function routeExpiredThroughBus(rawMessage) {
    const message = safeParseJSON(rawMessage);
    const route = message ? buildDesktopFollowerRoute(message) : null;
    if (route) {
      pendingOwnershipProbeTokensByThreadId.delete(route.threadId);
    }
    if (!route || hasLiveOwnerThread(route.threadId) || isLocallyOwnedThread(route.threadId)) {
      forwardToLocalCodex(rawMessage);
      return;
    }
    submitDesktopFollowerRequest(route, message);
  }

  function release(threadId, { toDesktop } = {}) {
    const queue = heldFollowerRequestsByThreadId.get(threadId);
    if (!queue || queue.length === 0) {
      heldFollowerRequestsByThreadId.delete(threadId);
      return;
    }

    heldFollowerRequestsByThreadId.delete(threadId);
    let releasedTurnStart = false;
    for (const entry of queue) {
      clearTimeout(entry.timer);
      const originalMessage = safeParseJSON(entry.rawMessage);
      if (readString(originalMessage?.method) === "turn/start") {
        if (releasedTurnStart) {
          rejectMessage(originalMessage, "Superseded by another held turn/start request.");
          continue;
        }
        releasedTurnStart = true;
      }
      const message = toDesktop ? originalMessage : null;
      const route = message ? buildDesktopFollowerRoute(message) : null;
      if (route && isDesktopRoutable(route.threadId)) {
        submitDesktopFollowerRequest(route, message);
      } else {
        forwardToLocalCodex?.(entry.rawMessage);
      }
    }
  }

  function reject(threadId, reason) {
    const queue = heldFollowerRequestsByThreadId.get(threadId);
    if (!queue || queue.length === 0) {
      heldFollowerRequestsByThreadId.delete(threadId);
      return;
    }
    heldFollowerRequestsByThreadId.delete(threadId);
    for (const entry of queue) {
      clearTimeout(entry.timer);
      rejectMessage(safeParseJSON(entry.rawMessage), reason);
    }
  }

  function rejectMessage(message, reason) {
    if (message?.id == null) {
      return;
    }
    sendApplicationResponse(JSON.stringify({
      id: message.id,
      error: {
        code: -32000,
        message: reason,
      },
    }));
  }

  function forgetThread(threadId) {
    ownershipProbeDeadlinesByThreadId.delete(threadId);
    pendingOwnershipProbeTokensByThreadId.delete(threadId);
    desktopOwnedByProbeThreadIds.delete(threadId);
  }

  function clearConnectionProbeState() {
    pendingOwnershipProbeTokensByThreadId.clear();
    desktopOwnedByProbeThreadIds.clear();
  }

  function clearAll() {
    ownershipProbeDeadlinesByThreadId.clear();
    pendingOwnershipProbeTokensByThreadId.clear();
    desktopOwnedByProbeThreadIds.clear();
    for (const queue of heldFollowerRequestsByThreadId.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
      }
    }
    heldFollowerRequestsByThreadId.clear();
    nextOwnershipProbeToken = 0;
  }

  return {
    clearAll,
    clearConnectionProbeState,
    forgetThread,
    hold,
    isDesktopRoutable,
    probeDesktopOwnership,
    probeHeldRequests,
    reject,
    release,
    setProbeDeadline,
    shouldHold,
  };
}

module.exports = {
  createHeldFollowerRequestState,
};
