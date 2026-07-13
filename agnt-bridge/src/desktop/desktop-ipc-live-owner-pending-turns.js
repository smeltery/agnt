// FILE: desktop-ipc-live-owner-pending-turns.js
// Purpose: Owns phone-origin pending turn/start queues and optimistic Desktop snapshots.
// Layer: CLI helper
// Exports: createPendingTurnStartState
// Depends on: ./desktop-ipc-shared, ./desktop-ipc-live-owner-utils

const {
  cloneJSON,
  readString,
  requestIdKey,
} = require("./desktop-ipc-shared");
const {
  normalizeInputEntriesForDesktop,
  sanitizeTurnStartParams,
} = require("./desktop-ipc-live-owner-utils");

function createPendingTurnStartState({
  conversations,
  pendingTurnStartParamsByThreadId,
  pendingTurnStartEntriesByRequestId,
  fallbackTurnIdsByThreadId,
  threadsAwaitingInitialHistoryByThreadId,
  ensureConversation,
  removeOwnedThread,
  scheduleSnapshot,
  now,
}) {
  let optimisticTurnSerial = 0;

  function remember(threadId, params, requestId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const normalizedRequestId = requestIdKey(requestId);
    const existingPending = normalizedRequestId ? pendingTurnStartEntriesByRequestId.get(normalizedRequestId) : null;
    if (existingPending?.threadId === normalizedThreadId) {
      return existingPending.entry?.consumed ? null : existingPending.entry;
    }
    const input = Array.isArray(params?.input) ? params.input : [];
    if (input.length === 0) {
      return null;
    }
    const sanitizedParams = sanitizeTurnStartParams(cloneJSON(params));
    sanitizedParams.input = normalizeInputEntriesForDesktop(sanitizedParams.input);
    const entry = { params: sanitizedParams, requestId: normalizedRequestId || null };
    const queue = pendingTurnStartParamsByThreadId.get(normalizedThreadId) || [];
    queue.push(entry);
    pendingTurnStartParamsByThreadId.set(normalizedThreadId, queue);
    if (normalizedRequestId) {
      pendingTurnStartEntriesByRequestId.set(normalizedRequestId, {
        threadId: normalizedThreadId,
        entry,
      });
    }
    return entry;
  }

  function discard(threadId, entry) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !entry) {
      return;
    }
    const didRemoveOptimisticTurn = removeOptimistic(normalizedThreadId, entry);
    const queue = pendingTurnStartParamsByThreadId.get(normalizedThreadId);
    if (!queue) {
      if (didRemoveOptimisticTurn) {
        scheduleSnapshot(normalizedThreadId);
      }
      return;
    }
    const index = queue.indexOf(entry);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      pendingTurnStartParamsByThreadId.delete(normalizedThreadId);
    }
    refreshFallback(normalizedThreadId);
    if (didRemoveOptimisticTurn) {
      scheduleSnapshot(normalizedThreadId);
    }
  }

  function resolveResponse(responseId, message) {
    const pending = pendingTurnStartEntriesByRequestId.get(responseId);
    if (!pending) {
      return;
    }
    pendingTurnStartEntriesByRequestId.delete(responseId);
    if (message.error) {
      discard(pending.threadId, pending.entry);
      const remainingStarts = pendingTurnStartParamsByThreadId.get(pending.threadId) || [];
      if (remainingStarts.length === 0
        && threadsAwaitingInitialHistoryByThreadId.has(pending.threadId)) {
        removeOwnedThread(pending.threadId);
      }
    }
  }

  function insertOptimistic(threadId, entry) {
    const normalizedThreadId = readString(threadId);
    const params = entry?.params;
    const input = Array.isArray(params?.input) ? params.input : [];
    if (!normalizedThreadId || entry?.consumed || !params || input.length === 0) {
      return null;
    }

    const conversation = ensureConversation(normalizedThreadId, {
      cwd: readString(params.cwd),
    });
    if (!conversation) {
      return null;
    }

    const optimisticTurnId = ensureOptimisticTurnId(normalizedThreadId, entry);
    if (!readString(fallbackTurnIdsByThreadId.get(normalizedThreadId))) {
      fallbackTurnIdsByThreadId.set(normalizedThreadId, optimisticTurnId);
    }
    if (conversation.turns.some((turn) => (
      (readString(turn?.turnId) || readString(turn?.id)) === optimisticTurnId
    ))) {
      return optimisticTurnId;
    }

    const timestamp = now();
    const turnParams = cloneJSON(params);
    turnParams.threadId = normalizedThreadId;
    turnParams.cwd = readString(params.cwd) || conversation.cwd || null;

    conversation.turns.push({
      id: optimisticTurnId,
      turnId: optimisticTurnId,
      params: turnParams,
      turnStartedAtMs: timestamp,
      durationMs: null,
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      status: "inProgress",
      error: null,
      diff: null,
      hookRuns: [],
      commandExecutionStartedAtMsById: {},
      items: [],
      agntOptimisticPendingTurn: true,
    });
    conversation.hasUnreadTurn = true;
    conversation.updatedAt = timestamp;
    return optimisticTurnId;
  }

  function refreshFallback(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || readString(fallbackTurnIdsByThreadId.get(normalizedThreadId))) {
      return;
    }
    const queue = pendingTurnStartParamsByThreadId.get(normalizedThreadId);
    const nextEntry = Array.isArray(queue)
      ? queue.find((entry) => readString(entry?.optimisticTurnId))
      : null;
    const nextOptimisticTurnId = readString(nextEntry?.optimisticTurnId);
    if (nextOptimisticTurnId) {
      fallbackTurnIdsByThreadId.set(normalizedThreadId, nextOptimisticTurnId);
    }
  }

  function ensureOptimisticTurnId(threadId, entry) {
    if (entry.optimisticTurnId) {
      return entry.optimisticTurnId;
    }
    optimisticTurnSerial += 1;
    const requestSegment = readString(entry.requestId) || `local-${optimisticTurnSerial}`;
    entry.optimisticTurnId = `agnt-pending-turn:${threadId}:${requestSegment}`;
    return entry.optimisticTurnId;
  }

  function removeOptimistic(threadId, entry) {
    const optimisticTurnId = readString(entry?.optimisticTurnId);
    const conversation = optimisticTurnId ? conversations.get(threadId) : null;
    if (!conversation || !Array.isArray(conversation.turns)) {
      return false;
    }
    const index = conversation.turns.findIndex((turn) => (
      turn?.agntOptimisticPendingTurn
        && (readString(turn.turnId) || readString(turn.id)) === optimisticTurnId
    ));
    if (index < 0) {
      return false;
    }
    conversation.turns.splice(index, 1);
    if (readString(fallbackTurnIdsByThreadId.get(threadId)) === optimisticTurnId) {
      fallbackTurnIdsByThreadId.delete(threadId);
    }
    conversation.updatedAt = now();
    return true;
  }

  function hasRequestId(requestId) {
    return pendingTurnStartEntriesByRequestId.has(requestIdKey(requestId));
  }

  function hasPendingThread(threadId) {
    return pendingTurnStartParamsByThreadId.has(threadId);
  }

  function removeThread(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    pendingTurnStartParamsByThreadId.delete(normalizedThreadId);
    for (const [requestId, pending] of Array.from(pendingTurnStartEntriesByRequestId.entries())) {
      if (pending.threadId === normalizedThreadId) {
        pendingTurnStartEntriesByRequestId.delete(requestId);
      }
    }
  }

  function clear() {
    pendingTurnStartParamsByThreadId.clear();
    pendingTurnStartEntriesByRequestId.clear();
    optimisticTurnSerial = 0;
  }

  return {
    clear,
    discard,
    hasPendingThread,
    hasRequestId,
    insertOptimistic,
    refreshFallback,
    remember,
    removeThread,
    resolveResponse,
  };
}

module.exports = {
  createPendingTurnStartState,
};
