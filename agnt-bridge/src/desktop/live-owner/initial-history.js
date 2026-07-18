const {
  cloneJSON,
  readString,
} = require("../desktop-ipc-shared");
const { readThreadFromPayload } = require("../desktop-ipc-live-owner-utils");

function createInitialHistoryState({
  cachedThreadsByThreadId,
  conversations,
  defaultMaxAttempts,
  defaultRetryMs,
  dirtyThreadIds,
  initialHistoryAttemptCountByThreadId,
  initialHistoryMaxAttempts,
  initialHistoryRetryAfterByThreadId,
  initialHistoryRetryMs,
  initialHistoryRetryTimersByThreadId,
  logPrefix,
  maxCachedThreads,
  now,
  ownedThreadIds,
  pendingThreadHydrationsByThreadId,
  scheduleSnapshot,
  sendCodexRequest,
  threadsAwaitingInitialHistoryByThreadId,
  upsertConversationFromThread,
}) {
  function shouldDelayInitialSnapshotForHistory(threadId, {
    hasLastBroadcastState = false,
    removeOwnedThread,
  } = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !threadsAwaitingInitialHistoryByThreadId.has(normalizedThreadId)) {
      return false;
    }
    if (hasLastBroadcastState) {
      stopAwaitingInitialHistory(normalizedThreadId);
      return false;
    }
    requestInitialHistoryBaselineIfDue(normalizedThreadId, { removeOwnedThread });
    return ownedThreadIds.has(normalizedThreadId)
      && threadsAwaitingInitialHistoryByThreadId.has(normalizedThreadId);
  }

  function requestInitialHistoryBaselineIfDue(threadId, { removeOwnedThread } = {}) {
    if (pendingThreadHydrationsByThreadId.has(threadId)) {
      return;
    }
    const maxAttempts = Number.isFinite(initialHistoryMaxAttempts)
      ? Math.max(1, Math.floor(initialHistoryMaxAttempts))
      : defaultMaxAttempts;
    const attemptCount = initialHistoryAttemptCountByThreadId.get(threadId) || 0;
    if (attemptCount >= maxAttempts) {
      removeOwnedThread?.(threadId);
      return;
    }
    const currentTime = now();
    const retryAfter = initialHistoryRetryAfterByThreadId.get(threadId) || 0;
    if (currentTime < retryAfter) {
      scheduleInitialHistoryRetryWakeup(threadId, retryAfter - currentTime);
      return;
    }
    clearInitialHistoryRetryWakeup(threadId);
    const retryBaseMs = Number.isFinite(initialHistoryRetryMs)
      ? Math.max(0, initialHistoryRetryMs)
      : defaultRetryMs;
    const retryDelayMs = retryBaseMs * (2 ** Math.min(attemptCount, 5));
    initialHistoryAttemptCountByThreadId.set(threadId, attemptCount + 1);
    initialHistoryRetryAfterByThreadId.set(threadId, currentTime + retryDelayMs);
    hydrateOwnedThreadFromRead(threadId);
  }

  function stopAwaitingInitialHistory(threadId) {
    threadsAwaitingInitialHistoryByThreadId.delete(threadId);
    initialHistoryRetryAfterByThreadId.delete(threadId);
    initialHistoryAttemptCountByThreadId.delete(threadId);
    clearInitialHistoryRetryWakeup(threadId);
  }

  function scheduleInitialHistoryRetryWakeup(threadId, delayMs) {
    if (initialHistoryRetryTimersByThreadId.has(threadId)) {
      return;
    }
    const timer = setTimeout(() => {
      initialHistoryRetryTimersByThreadId.delete(threadId);
      if (ownedThreadIds.has(threadId) && threadsAwaitingInitialHistoryByThreadId.has(threadId)) {
        scheduleSnapshot(threadId);
      }
    }, Math.max(0, delayMs));
    timer.unref?.();
    initialHistoryRetryTimersByThreadId.set(threadId, timer);
  }

  function clearInitialHistoryRetryWakeup(threadId) {
    const timer = initialHistoryRetryTimersByThreadId.get(threadId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    initialHistoryRetryTimersByThreadId.delete(threadId);
  }

  function rememberCachedThread(threadId, thread) {
    cachedThreadsByThreadId.delete(threadId);
    cachedThreadsByThreadId.set(threadId, cloneJSON(thread));
    if (cachedThreadsByThreadId.size <= maxCachedThreads) {
      return;
    }
    for (const cachedThreadId of cachedThreadsByThreadId.keys()) {
      if (cachedThreadsByThreadId.size <= maxCachedThreads) {
        return;
      }
      if (!ownedThreadIds.has(cachedThreadId)) {
        cachedThreadsByThreadId.delete(cachedThreadId);
      }
    }
  }

  function hydrateOwnedThreadFromRead(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || pendingThreadHydrationsByThreadId.has(normalizedThreadId)) {
      return;
    }
    const hydration = Promise.resolve()
      .then(() => sendCodexRequest("thread/read", { threadId: normalizedThreadId }))
      .then((result) => {
        const thread = readThreadFromPayload(result);
        if (!thread?.id) {
          return;
        }
        rememberCachedThread(thread.id, thread);
        if (ownedThreadIds.has(thread.id)) {
          upsertConversationFromThread(thread);
        }
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop IPC live owner thread/read hydration failed for ${normalizedThreadId}: ${error?.message || "unknown error"}`);
      })
      .finally(() => {
        pendingThreadHydrationsByThreadId.delete(normalizedThreadId);
        if (dirtyThreadIds.has(normalizedThreadId) && ownedThreadIds.has(normalizedThreadId)) {
          scheduleSnapshot(normalizedThreadId);
        }
      });
    pendingThreadHydrationsByThreadId.set(normalizedThreadId, hydration);
  }

  return {
    hydrateOwnedThreadFromRead,
    rememberCachedThread,
    requestInitialHistoryBaselineIfDue,
    shouldDelayInitialSnapshotForHistory,
    stopAwaitingInitialHistory,
  };
}

module.exports = {
  createInitialHistoryState,
};
