const {
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  cloneJSON,
} = require("../desktop-ipc-shared");
const {
  AGNT_LIVE_OWNER_SOURCE,
  THREAD_STREAM_STATE_CHANGED,
} = require("../desktop-ipc-live-owner-support");
const {
  applyPatchesToBaselineState,
  buildConversationStatePatches,
} = require("../desktop-ipc-state-patches");

function createLiveOwnerSnapshotState({
  conversations,
  dirtyThreadIds,
  hostId,
  ipc,
  lastBroadcastStatesByThreadId,
  maxPatchBytes,
  maxPatchCount,
  ownedThreadIds,
  runtimeSettingsStore,
  shouldDelayInitialSnapshotForHistory,
  snapshotDebounceMs,
  streamRevisionsByThreadId,
}) {
  let snapshotTimer = null;

  function scheduleSnapshot(threadId) {
    const normalizedThreadId = typeof threadId === "string" ? threadId : "";
    if (!normalizedThreadId || !ownedThreadIds.has(normalizedThreadId)) {
      return;
    }
    dirtyThreadIds.add(normalizedThreadId);
    ipc.ensureConnected();
    if (snapshotTimer) {
      return;
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      flushSnapshots();
    }, Math.max(0, snapshotDebounceMs));
    snapshotTimer.unref?.();
  }

  function flushSnapshots() {
    const pendingThreadIds = Array.from(dirtyThreadIds);
    dirtyThreadIds.clear();
    for (const threadId of pendingThreadIds) {
      if (shouldDelayInitialSnapshotForHistory(threadId)) {
        dirtyThreadIds.add(threadId);
        continue;
      }
      if (!broadcastConversationState(threadId)) {
        dirtyThreadIds.add(threadId);
      }
    }
  }

  function broadcastAllOwnedSnapshots() {
    for (const threadId of ownedThreadIds) {
      if (shouldDelayInitialSnapshotForHistory(threadId)) {
        dirtyThreadIds.add(threadId);
        continue;
      }
      if (broadcastConversationState(threadId, { forceSnapshot: true })) {
        dirtyThreadIds.delete(threadId);
      } else {
        dirtyThreadIds.add(threadId);
      }
    }
  }

  function broadcastConversationState(threadId, { forceSnapshot = false } = {}) {
    const conversationState = conversations.get(threadId);
    if (!conversationState || !ownedThreadIds.has(threadId)) {
      return true;
    }
    runtimeSettingsStore?.attachToConversation?.(threadId, conversationState);
    if (shouldDelayInitialSnapshotForHistory(threadId)) {
      return false;
    }
    const currentRevision = streamRevisionsByThreadId.get(threadId) ?? 0;
    const previousState = lastBroadcastStatesByThreadId.get(threadId) || null;
    if (!forceSnapshot && previousState) {
      const patches = buildConversationStatePatches(previousState, conversationState, {
        maxPatchCount,
        maxPatchBytes,
      });
      if (patches && patches.length === 0) {
        return true;
      }
      if (patches && ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
        conversationId: threadId,
        hostId,
        version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
        agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
        change: {
          type: "patches",
          baseRevision: currentRevision,
          revision: currentRevision + 1,
          patches,
        },
      })) {
        streamRevisionsByThreadId.set(threadId, currentRevision + 1);
        if (!applyPatchesToBaselineState(previousState, patches)) {
          lastBroadcastStatesByThreadId.set(threadId, cloneJSON(conversationState));
        }
        return true;
      }
    }

    if (ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
      conversationId: threadId,
      hostId,
      version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
      agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
      change: {
        type: "snapshot",
        revision: currentRevision + 1,
        conversationState,
      },
    })) {
      streamRevisionsByThreadId.set(threadId, currentRevision + 1);
      lastBroadcastStatesByThreadId.set(threadId, cloneJSON(conversationState));
      return true;
    }
    return false;
  }

  function clearTimer() {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
  }

  return {
    broadcastAllOwnedSnapshots,
    broadcastConversationState,
    clearTimer,
    flushSnapshots,
    scheduleSnapshot,
  };
}

module.exports = {
  createLiveOwnerSnapshotState,
};
