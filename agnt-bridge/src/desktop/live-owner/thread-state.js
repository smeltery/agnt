const {
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const {
  THREAD_READ_STATE_CHANGED,
} = require("../desktop-ipc-live-owner-support");
const {
  buildConversationStateFromThread,
  createEmptyConversationState,
} = require("../desktop-ipc-conversation-adapter");

function createLiveOwnerThreadState({
  announcedReadStateThreadIds,
  cachedThreadsByThreadId,
  conversations,
  hostId,
  ipc,
  markOwnedThread,
  now,
  ownedThreadIds,
  pendingThreadStartRequestIds,
  runtimeSettingsStore,
  scheduleSnapshot,
  stopAwaitingInitialHistory,
}) {
  function markThreadReadByPhone(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !ownedThreadIds.has(normalizedThreadId)) {
      return;
    }
    const conversation = conversations.get(normalizedThreadId);
    const hadUnread = Boolean(conversation
      && (conversation.hasUnreadTurn || conversation.unreadMessageCount > 0));
    if (hadUnread) {
      conversation.hasUnreadTurn = false;
      conversation.unreadMessageCount = 0;
      scheduleSnapshot(normalizedThreadId);
    } else if (announcedReadStateThreadIds.has(normalizedThreadId)) {
      return;
    }
    if (ipc.sendBroadcast(THREAD_READ_STATE_CHANGED, {
      conversationId: normalizedThreadId,
      hasUnreadTurn: false,
    })) {
      announcedReadStateThreadIds.add(normalizedThreadId);
    }
  }

  function markTurnInterruptedOptimistically(threadId, params) {
    const conversation = conversations.get(readString(threadId));
    if (!conversation) {
      return;
    }
    const requestedTurnId = readString(params?.turnId) || readString(params?.turn_id);
    for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
      const turn = conversation.turns[index];
      const turnId = readString(turn?.turnId) || readString(turn?.id);
      const matchesRequest = requestedTurnId ? turnId === requestedTurnId : true;
      if (matchesRequest && normalizeToken(turn?.status) === "inprogress") {
        turn.status = "interrupted";
        conversation.threadRuntimeStatus = { type: "idle" };
        conversation.updatedAt = now();
        return;
      }
      if (requestedTurnId && turnId === requestedTurnId) {
        return;
      }
    }
  }

  function claimStartedThreadForPendingLocalStart(message) {
    if (readString(message?.method) !== "thread/started" || pendingThreadStartRequestIds.size === 0) {
      return;
    }
    const thread = message?.params?.thread;
    const threadId = readString(thread?.id);
    if (!threadId || ownedThreadIds.has(threadId)) {
      return;
    }
    const threadCwd = readString(thread?.cwd);
    for (const [pendingRequestId, pendingCwd] of pendingThreadStartRequestIds) {
      if (pendingCwd && threadCwd && pendingCwd !== threadCwd) {
        continue;
      }
      pendingThreadStartRequestIds.delete(pendingRequestId);
      markOwnedThread(threadId);
      return;
    }
  }

  function upsertConversationFromThread(thread) {
    const threadId = readString(thread?.id);
    if (!threadId) {
      return null;
    }
    const previous = conversations.get(threadId) || null;
    const next = buildConversationStateFromThread(thread, {
      previous,
      hostId,
      now,
    });
    runtimeSettingsStore?.attachToConversation?.(threadId, next);
    conversations.set(threadId, next);
    stopAwaitingInitialHistory(threadId);
    return next;
  }

  function ensureConversation(threadId, seed = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    let conversation = conversations.get(normalizedThreadId);
    if (!conversation) {
      conversation = createEmptyConversationState(normalizedThreadId, {
        hostId,
        now,
        cwd: seed.cwd,
      });
      conversations.set(normalizedThreadId, conversation);
    }
    runtimeSettingsStore?.attachToConversation?.(normalizedThreadId, conversation);
    return conversation;
  }

  function seedOwnedConversation(threadId, seed = {}) {
    const normalizedThreadId = readString(threadId);
    const existingConversation = normalizedThreadId ? conversations.get(normalizedThreadId) : null;
    if (existingConversation) {
      return existingConversation;
    }
    const cachedThread = normalizedThreadId ? cachedThreadsByThreadId.get(normalizedThreadId) : null;
    if (cachedThread) {
      return upsertConversationFromThread(cachedThread);
    }
    return ensureConversation(normalizedThreadId, seed);
  }

  return {
    claimStartedThreadForPendingLocalStart,
    ensureConversation,
    markThreadReadByPhone,
    markTurnInterruptedOptimistically,
    seedOwnedConversation,
    upsertConversationFromThread,
  };
}

module.exports = {
  createLiveOwnerThreadState,
};
