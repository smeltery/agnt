const {
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  cloneJSON,
  readString,
} = require("../desktop-ipc-shared");
const {
  AGNT_LIVE_OWNER_SOURCE,
  THREAD_STREAM_STATE_CHANGED,
} = require("../desktop-ipc-live-owner-support");
const { createEmptyConversationState } = require("../desktop-ipc-conversation-adapter");

function createOwnedThreadState({
  announcedReadStateThreadIds,
  cachedThreadsByThreadId,
  conversations,
  dirtyThreadIds,
  fallbackTurnIdsByThreadId,
  followerRequestsRef,
  followerRuntimeOverridesByThreadId,
  hostId,
  ipc,
  lastBroadcastStatesByThreadId,
  listMetadataRef,
  now,
  ownedThreadIds,
  pendingThreadHydrationsByThreadId,
  pendingTurnStarts,
  queuedFollowUpsByThreadId,
  runningQueuedFollowUpThreadIds,
  stopAwaitingInitialHistory,
  streamRevisionsByThreadId,
}) {
  function markOwnedThread(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    ownedThreadIds.add(normalizedThreadId);
    ipc.ensureConnected();
  }

  function removeOwnedThread(threadId, { broadcastRemoval = false, reason = "", skipArchiveMetadataBroadcast = false } = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    if (broadcastRemoval && ownedThreadIds.has(normalizedThreadId)) {
      broadcastRemovedConversationState(normalizedThreadId, {
        reason,
        skipArchiveMetadataBroadcast,
      });
    }
    ownedThreadIds.delete(normalizedThreadId);
    conversations.delete(normalizedThreadId);
    cachedThreadsByThreadId.delete(normalizedThreadId);
    pendingThreadHydrationsByThreadId.delete(normalizedThreadId);
    stopAwaitingInitialHistory(normalizedThreadId);
    lastBroadcastStatesByThreadId.delete(normalizedThreadId);
    fallbackTurnIdsByThreadId.delete(normalizedThreadId);
    streamRevisionsByThreadId.delete(normalizedThreadId);
    const droppedQueuedFollowUps = (queuedFollowUpsByThreadId.get(normalizedThreadId) || []).length > 0;
    queuedFollowUpsByThreadId.delete(normalizedThreadId);
    if (droppedQueuedFollowUps) {
      followerRequestsRef.current?.broadcastQueuedFollowUps(normalizedThreadId);
    }
    runningQueuedFollowUpThreadIds.delete(normalizedThreadId);
    announcedReadStateThreadIds.delete(normalizedThreadId);
    listMetadataRef.current?.forgetThread(normalizedThreadId);
    pendingTurnStarts.removeThread(normalizedThreadId);
    followerRuntimeOverridesByThreadId.delete(normalizedThreadId);
    dirtyThreadIds.delete(normalizedThreadId);
  }

  function broadcastRemovedConversationState(threadId, { reason = "", skipArchiveMetadataBroadcast = false } = {}) {
    const listMetadata = listMetadataRef.current;
    const previousState = conversations.get(threadId)
      || lastBroadcastStatesByThreadId.get(threadId)
      || createEmptyConversationState(threadId, { hostId, now });
    if (reason === "thread/archive" && !skipArchiveMetadataBroadcast) {
      listMetadata?.broadcastThreadArchived(threadId, readString(previousState?.cwd));
    }
    const removedState = {
      ...cloneJSON(previousState),
      id: threadId,
      hostId,
      turns: [],
      requests: [],
      hasUnreadTurn: false,
      unreadMessageCount: 0,
      updatedAt: now(),
      agntRemoved: true,
      agntRemovalReason: reason || null,
      archived: reason === "thread/archive" || Boolean(previousState?.archived),
      unsubscribed: reason === "thread/unsubscribe" || Boolean(previousState?.unsubscribed),
    };
    ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
      conversationId: threadId,
      version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
      agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
      agntOwnerReleased: true,
      change: {
        type: "snapshot",
        conversationState: removedState,
      },
    });
  }

  return {
    markOwnedThread,
    removeOwnedThread,
  };
}

module.exports = {
  createOwnedThreadState,
};
