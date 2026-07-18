const { readString } = require("../desktop-ipc-shared");
const {
  OWNER_INBOUND_METHODS,
  THREAD_READ_METHODS,
} = require("../desktop-ipc-live-owner-support");
const { readThreadIdFromParams } = require("../desktop-ipc-conversation-adapter");

function createLiveOwnerInboundObserver({
  cachedThreadsByThreadId,
  conversations,
  followerRequests,
  initialHistory,
  ipc,
  listMetadata,
  markOwnedThread,
  markThreadReadByPhone,
  markTurnInterruptedOptimistically,
  ownedThreadIds,
  pendingThreadReadRequestIds,
  pendingThreadStartRequestIds,
  pendingTurnStarts,
  removeOwnedThread,
  scheduleSnapshot,
  seedOwnedConversation,
  threadsAwaitingInitialHistoryByThreadId,
}) {
  function observeInbound(message) {
    const method = readString(message?.method);
    if (THREAD_READ_METHODS.has(method)) {
      if (message?.id != null) {
        pendingThreadReadRequestIds.add(String(message.id));
      }
      markThreadReadByPhone(readThreadIdFromParams(message?.params));
      return;
    }

    if (!method || !OWNER_INBOUND_METHODS.has(method)) {
      return;
    }

    if (method === "thread/start") {
      if (message?.id != null) {
        pendingThreadStartRequestIds.set(String(message.id), readString(message?.params?.cwd));
      }
      ipc.ensureConnected();
      return;
    }

    const threadId = readThreadIdFromParams(message?.params);
    if (!threadId) {
      return;
    }

    if (method === "thread/archive") {
      listMetadata.broadcastThreadArchived(threadId, listMetadata.readArchiveCwd(threadId, message?.params));
      removeOwnedThread(threadId, {
        broadcastRemoval: true,
        reason: method,
        skipArchiveMetadataBroadcast: true,
      });
      return;
    }
    if (method === "thread/unsubscribe") {
      if (!followerRequests.hasActiveLocalTurn(threadId)) {
        removeOwnedThread(threadId, { broadcastRemoval: true, reason: method });
      }
      return;
    }
    if (method === "thread/unarchive") {
      listMetadata.broadcastThreadUnarchived(threadId);
      return;
    }

    const hadConversation = conversations.has(threadId);
    const hadCachedThread = cachedThreadsByThreadId.has(threadId);
    markOwnedThread(threadId);
    if (!hadConversation && !hadCachedThread) {
      threadsAwaitingInitialHistoryByThreadId.add(threadId);
    }
    let pendingTurnStartEntry = null;
    if (method === "turn/start") {
      pendingTurnStartEntry = pendingTurnStarts.remember(threadId, message?.params, message?.id);
      listMetadata.scheduleSidebarAnnouncement(threadId);
    }
    if (method === "turn/interrupt") {
      markTurnInterruptedOptimistically(threadId, message?.params);
    }
    seedOwnedConversation(threadId, {
      cwd: readString(message?.params?.cwd),
    });
    if (pendingTurnStartEntry) {
      pendingTurnStarts.insertOptimistic(threadId, pendingTurnStartEntry);
    }
    if (!hadConversation && !hadCachedThread) {
      initialHistory.requestInitialHistoryBaselineIfDue(threadId, { removeOwnedThread });
    }
    scheduleSnapshot(threadId);
  }

  return {
    observeInbound,
  };
}

module.exports = {
  createLiveOwnerInboundObserver,
};
