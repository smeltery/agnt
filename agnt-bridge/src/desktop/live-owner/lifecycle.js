const {
  CLIENT_STATUS_CHANGED,
  THREAD_STREAM_FOLLOWING_CHANGED,
  conversationSnapshotShowsActiveTurn,
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const {
  THREAD_STREAM_STATE_CHANGED,
  isPeerOwnershipBroadcast,
} = require("../desktop-ipc-live-owner-support");

function createLiveOwnerLifecycle({
  announcedReadStateThreadIds,
  pendingReadStateByThreadId,
  cachedThreadsByThreadId,
  conversations,
  dirtyThreadIds,
  fallbackTurnIdsByThreadId,
  followerRequests,
  followerRuntimeOverridesByThreadId,
  followerTracker,
  initialHistoryAttemptCountByThreadId,
  initialHistoryRetryAfterByThreadId,
  initialHistoryRetryTimersByThreadId,
  ipc,
  lastBroadcastStatesByThreadId,
  listMetadata,
  ownedThreadIds,
  pendingThreadHydrationsByThreadId,
  pendingThreadReadRequestIds,
  pendingThreadStartRequestIds,
  pendingTurnStarts,
  queuedFollowUpsByThreadId,
  removeOwnedThread,
  runningQueuedFollowUpThreadIds,
  snapshotState,
  streamRevisionsByThreadId,
  threadsAwaitingInitialHistoryByThreadId,
}) {
  function stopAll() {
    snapshotState.clearTimer();
    dirtyThreadIds.clear();
    pendingThreadStartRequestIds.clear();
    pendingThreadReadRequestIds.clear();
    pendingThreadHydrationsByThreadId.clear();
    threadsAwaitingInitialHistoryByThreadId.clear();
    initialHistoryRetryAfterByThreadId.clear();
    initialHistoryAttemptCountByThreadId.clear();
    for (const timer of initialHistoryRetryTimersByThreadId.values()) {
      clearTimeout(timer);
    }
    initialHistoryRetryTimersByThreadId.clear();
    cachedThreadsByThreadId.clear();
    lastBroadcastStatesByThreadId.clear();
    fallbackTurnIdsByThreadId.clear();
    streamRevisionsByThreadId.clear();
    followerTracker.clear();
    listMetadata.clearAll();
    pendingTurnStarts.clear();
    followerRuntimeOverridesByThreadId.clear();
    queuedFollowUpsByThreadId.clear();
    runningQueuedFollowUpThreadIds.clear();
    announcedReadStateThreadIds.clear();
    pendingReadStateByThreadId.clear();
    ownedThreadIds.clear();
    conversations.clear();
    ipc.close();
  }

  function handlePeerBroadcast(envelope) {
    if (envelope?.method === CLIENT_STATUS_CHANGED) {
      // The fallback router can accept the owner's connection before any
      // Desktop client exists. Metadata broadcasts remain queued in that state;
      // retry them whenever peer membership changes so a newly connected
      // Desktop immediately refreshes its sidebar.
      listMetadata.flushPendingThreadArchiveMetadataBroadcasts();
      snapshotState.broadcastAllOwnedSnapshots();
      if (normalizeToken(envelope.params?.status) === "disconnected") {
        followerTracker.removeFollowerClient(envelope.params?.clientId || envelope.sourceClientId);
      }
      return;
    }
    if (envelope?.method === THREAD_STREAM_FOLLOWING_CHANGED) {
      followerTracker.updateFollowerState(envelope, ipc.clientId);
      return;
    }
    if (listMetadata.maybeYieldOwnedThreadForPeerArchive(envelope)) {
      return;
    }
    if (envelope?.method !== THREAD_STREAM_STATE_CHANGED) {
      return;
    }
    const params = envelope.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    if (!threadId || !ownedThreadIds.has(threadId)) {
      return;
    }
    if (envelope.sourceClientId && envelope.sourceClientId === ipc.clientId) {
      return;
    }
    if (!isPeerOwnershipBroadcast(params, { normalizeToken, readString })) {
      return;
    }
    if (followerRequests.hasActiveLocalTurn(threadId) && !conversationSnapshotShowsActiveTurn(params.change)) {
      return;
    }
    removeOwnedThread(threadId);
  }

  return {
    handlePeerBroadcast,
    stopAll,
  };
}

module.exports = {
  createLiveOwnerLifecycle,
};
