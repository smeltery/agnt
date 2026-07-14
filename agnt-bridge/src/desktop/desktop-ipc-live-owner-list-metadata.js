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

  function broadcastThreadArchived(threadId, cwd) {
    queueThreadArchiveMetadataBroadcast(THREAD_ARCHIVED, threadId, { cwd });
  }

  function broadcastThreadUnarchived(threadId) {
    queueThreadArchiveMetadataBroadcast(THREAD_UNARCHIVED, threadId);
  }

  function scheduleSidebarAnnouncement(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId
      || announcedSidebarThreadIds.has(normalizedThreadId)
      || sidebarRefreshTimersByThreadId.has(normalizedThreadId)) {
      return;
    }
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
  }

  function clearAll() {
    for (const timer of sidebarRefreshTimersByThreadId.values()) {
      clearTimeout(timer);
    }
    sidebarRefreshTimersByThreadId.clear();
    announcedSidebarThreadIds.clear();
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
    scheduleSidebarAnnouncement,
  };
}

module.exports = {
  createLiveOwnerListMetadataState,
};
