// FILE: desktop-ipc-follower-tracker.js
// Purpose: Tracks Codex Desktop's `thread-stream-following-changed` broadcasts
//          (per-thread, per-client follow announcements) so callers can tell
//          the desktop refresher when a route it deep-linked actually mounted.
// Layer: CLI helper
// Exports: createFollowerStateTracker
// Depends on: ./desktop-ipc-shared

const { readString } = require("./desktop-ipc-shared");

// Shared by both the action-follower (bridge follows Desktop-owned threads)
// and the live-owner (Desktop follows bridge-owned threads): both sides need
// the same "who else is following this thread" bookkeeping, they just differ
// in who initiates the handshake and which threads are in scope.
function createFollowerStateTracker({
  isTrackedThread = () => true,
  onFollowerStateChanged = null,
} = {}) {
  const followerClientIdsByThreadId = new Map();

  // envelope is a `thread-stream-following-changed` broadcast; selfClientId
  // excludes the tracker's own announcements (only other clients count).
  function updateFollowerState(envelope, selfClientId) {
    const params = envelope?.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    const clientId = readString(envelope?.sourceClientId);
    if (!threadId
      || !clientId
      || clientId === selfClientId
      || !isTrackedThread(threadId)) {
      return;
    }

    const followers = followerClientIdsByThreadId.get(threadId) || new Set();
    if (params.following === true) {
      const wasUnfollowed = followers.size === 0;
      followers.add(clientId);
      followerClientIdsByThreadId.set(threadId, followers);
      if (wasUnfollowed) {
        onFollowerStateChanged?.(threadId, true);
      }
      return;
    }

    if (!followers.delete(clientId)) {
      return;
    }
    if (followers.size === 0) {
      followerClientIdsByThreadId.delete(threadId);
      onFollowerStateChanged?.(threadId, false);
    }
  }

  // A disconnected peer never gets to send its own following:false; forget
  // it explicitly so a stale follower doesn't block onFollowerStateChanged.
  function removeFollowerClient(clientId) {
    const normalizedClientId = readString(clientId);
    if (!normalizedClientId) {
      return;
    }
    for (const [threadId, followers] of followerClientIdsByThreadId) {
      if (!followers.delete(normalizedClientId)) {
        continue;
      }
      if (followers.size === 0) {
        followerClientIdsByThreadId.delete(threadId);
        onFollowerStateChanged?.(threadId, false);
      }
    }
  }

  function forgetThread(threadId) {
    if (followerClientIdsByThreadId.delete(threadId)) {
      onFollowerStateChanged?.(threadId, false);
    }
  }

  // Silent reset for full teardown (bridge shutting down); does not notify.
  function clear() {
    followerClientIdsByThreadId.clear();
  }

  // Reset on a lost IPC connection: existing followers may reconnect and
  // re-announce, but the refresher must not be left waiting on a follow
  // confirmation nobody can send anymore.
  function clearAndNotify() {
    for (const threadId of followerClientIdsByThreadId.keys()) {
      onFollowerStateChanged?.(threadId, false);
    }
    followerClientIdsByThreadId.clear();
  }

  return {
    clear,
    clearAndNotify,
    forgetThread,
    removeFollowerClient,
    updateFollowerState,
  };
}

module.exports = {
  createFollowerStateTracker,
};
