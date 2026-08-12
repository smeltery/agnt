// FILE: desktop-ipc-live-owner-list-metadata.js
// Purpose: Mirrors live-owner archive and sidebar metadata to Desktop peers.
// Layer: CLI helper
// Exports: createLiveOwnerListMetadataState
// Depends on: ./desktop-ipc-live-owner-support, ./desktop-ipc-shared

const {
  readString,
} = require("./desktop-ipc-shared");
const {
  THREAD_ARCHIVED,
  THREAD_UNARCHIVED,
} = require("./desktop-ipc-live-owner-support");

function createLiveOwnerListMetadataState({
  conversations,
  hostId,
  ipc,
  lastBroadcastStatesByThreadId,
  ownedThreadIds,
  removeOwnedThread,
  sidebarRefreshDelayMs,
}) {
  const announcedSidebarThreadIds = new Set();
  const sidebarRefreshTimersByThreadId = new Map();
  const pendingThreadArchiveMetadataByThreadId = new Map();
  // A new rollout can exist as a thread id before Desktop's separate app-server
  // can return it from thread/list. Keep a bounded materialization replay alive
  // until the first user item and turn completion prove the rollout was written.
  const pendingSidebarMaterializationThreadIds = new Set();
  const replayedSidebarMaterializationThreadIds = new Set();

  function broadcastThreadArchived(threadId, cwd) {
    queueThreadArchiveMetadataBroadcast(THREAD_ARCHIVED, threadId, { cwd });
  }

  function broadcastThreadUnarchived(threadId) {
    queueThreadArchiveMetadataBroadcast(THREAD_UNARCHIVED, threadId);
  }

  // Desktop has no watcher on the shared session store, but its webview reacts
  // to thread-unarchived broadcasts by re-running thread/list. The first timed
  // announcement keeps the common path responsive; materialization events below
  // replay it because a new rollout id can precede Desktop's thread/list entry.
  function scheduleSidebarAnnouncement(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId
      || announcedSidebarThreadIds.has(normalizedThreadId)
      || sidebarRefreshTimersByThreadId.has(normalizedThreadId)) {
      return;
    }
    pendingSidebarMaterializationThreadIds.add(normalizedThreadId);
    const timer = setTimeout(() => {
      sidebarRefreshTimersByThreadId.delete(normalizedThreadId);
      if (!ownedThreadIds.has(normalizedThreadId)) {
        return;
      }
      announcedSidebarThreadIds.add(normalizedThreadId);
      broadcastThreadUnarchived(normalizedThreadId);
    }, Math.max(0, sidebarRefreshDelayMs));
    timer.unref?.();
    sidebarRefreshTimersByThreadId.set(normalizedThreadId, timer);
  }

  function cancelSidebarAnnouncement(threadId) {
    const timer = sidebarRefreshTimersByThreadId.get(threadId);
    if (timer) {
      clearTimeout(timer);
      sidebarRefreshTimersByThreadId.delete(threadId);
    }
  }

  // Replays the sidebar announcement once the rollout has actually materialized:
  // either a persisted user item lands, or the turn completes (the bounded
  // fallback for app-server/catalog write races). Re-announcing on the user item
  // is one-shot; a later turn completion always replays once more and then
  // forgets the thread so it does not keep refreshing an idle sidebar entry.
  function replaySidebarAnnouncementAfterMaterialization(message, threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId
      || !ownedThreadIds.has(normalizedThreadId)
      || !pendingSidebarMaterializationThreadIds.has(normalizedThreadId)) {
      return;
    }

    const method = readString(message?.method);
    const itemType = readString(message?.params?.item?.type);
    const turnItems = Array.isArray(message?.params?.turn?.items)
      ? message.params.turn.items
      : [];
    const includesPersistedUserMessage = (
      (method === "item/started" || method === "item/completed")
        && itemType === "userMessage"
    ) || turnItems.some((item) => readString(item?.type) === "userMessage");
    const turnCompleted = method === "turn/completed";
    if (!includesPersistedUserMessage && !turnCompleted) {
      return;
    }

    cancelSidebarAnnouncement(normalizedThreadId);
    announcedSidebarThreadIds.add(normalizedThreadId);
    if (!replayedSidebarMaterializationThreadIds.has(normalizedThreadId) || turnCompleted) {
      broadcastThreadUnarchived(normalizedThreadId);
    }

    if (turnCompleted) {
      pendingSidebarMaterializationThreadIds.delete(normalizedThreadId);
      replayedSidebarMaterializationThreadIds.delete(normalizedThreadId);
      return;
    }
    replayedSidebarMaterializationThreadIds.add(normalizedThreadId);
  }

  function queueThreadArchiveMetadataBroadcast(method, threadId, { cwd } = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    pendingThreadArchiveMetadataByThreadId.set(normalizedThreadId, {
      method,
      cwd: readString(cwd),
    });
    ipc.ensureConnected();
    flushPendingThreadArchiveMetadataBroadcasts();
  }

  function flushPendingThreadArchiveMetadataBroadcasts() {
    for (const [threadId, pending] of pendingThreadArchiveMetadataByThreadId) {
      const params = {
        hostId,
        conversationId: threadId,
      };
      if (pending.method === THREAD_ARCHIVED) {
        params.cwd = pending.cwd;
      }
      if (!ipc.sendBroadcast(pending.method, params)) {
        return;
      }
      pendingThreadArchiveMetadataByThreadId.delete(threadId);
    }
  }

  function readArchiveCwd(threadId, params) {
    return readString(params?.cwd)
      || readString(conversations.get(threadId)?.cwd)
      || readString(lastBroadcastStatesByThreadId.get(threadId)?.cwd);
  }

  function maybeYieldOwnedThreadForPeerArchive(envelope) {
    if (envelope?.method !== THREAD_ARCHIVED) {
      return false;
    }
    if (envelope.sourceClientId && envelope.sourceClientId === ipc.clientId) {
      return true;
    }
    const params = envelope.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    if (!threadId || !ownedThreadIds.has(threadId)) {
      return true;
    }

    removeOwnedThread(threadId);
    return true;
  }

  function forgetThread(threadId) {
    cancelSidebarAnnouncement(threadId);
    announcedSidebarThreadIds.delete(threadId);
    pendingSidebarMaterializationThreadIds.delete(threadId);
    replayedSidebarMaterializationThreadIds.delete(threadId);
  }

  function clearAll() {
    for (const timer of sidebarRefreshTimersByThreadId.values()) {
      clearTimeout(timer);
    }
    sidebarRefreshTimersByThreadId.clear();
    announcedSidebarThreadIds.clear();
    pendingSidebarMaterializationThreadIds.clear();
    replayedSidebarMaterializationThreadIds.clear();
    pendingThreadArchiveMetadataByThreadId.clear();
  }

  return {
    broadcastThreadArchived,
    broadcastThreadUnarchived,
    clearAll,
    flushPendingThreadArchiveMetadataBroadcasts,
    forgetThread,
    maybeYieldOwnedThreadForPeerArchive,
    readArchiveCwd,
    replaySidebarAnnouncementAfterMaterialization,
    scheduleSidebarAnnouncement,
  };
}

module.exports = {
  createLiveOwnerListMetadataState,
};
