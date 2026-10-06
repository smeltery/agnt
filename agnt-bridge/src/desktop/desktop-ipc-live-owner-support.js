// FILE: desktop-ipc-live-owner-support.js
// Purpose: Provides constants and fallback owner for Desktop IPC live ownership.
// Layer: CLI helper
// Exports: live-owner method constants and createDisabledDesktopIpcLiveOwner

const THREAD_STREAM_STATE_CHANGED = "thread-stream-state-changed";
const THREAD_ARCHIVED = "thread-archived";
const THREAD_UNARCHIVED = "thread-unarchived";
const THREAD_READ_STATE_CHANGED = "thread-read-state-changed";
const THREAD_QUEUED_FOLLOWUPS_CHANGED = "thread-queued-followups-changed";
const AGNT_LIVE_OWNER_SOURCE = "desktop-ipc-live-owner";

const SUPPORTED_FOLLOWER_REQUEST_METHODS = new Set([
  "thread-owner-discovery",
  "thread-follower-start-turn",
  "thread-follower-load-complete-history",
  "thread-follower-update-thread-settings",
  "thread-follower-compact-thread",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
  "thread-follower-set-queued-follow-ups-state",
]);

const OWNER_INBOUND_METHODS = new Set([
  "thread/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
  "thread/archive",
  "thread/unarchive",
  "thread/unsubscribe",
]);

const THREAD_READ_METHODS = new Set(["thread/read", "thread/resume"]);

function isPeerOwnershipBroadcast(params, { readString, normalizeToken }) {
  if (readString(params?.agntOwnerSource) === AGNT_LIVE_OWNER_SOURCE) {
    return false;
  }
  return normalizeToken(params?.change?.type) === "snapshot";
}

function conversationHasActiveTurn(conversation, { normalizeToken }) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  return turns.some((turn) => {
    const status = normalizeToken(turn?.status);
    return status === "inprogress" || status === "running" || status === "active";
  });
}

function activeTurnIdFromConversation(conversation, { normalizeToken, readString }) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const status = normalizeToken(turn?.status);
    const turnId = readString(turn?.turnId) || readString(turn?.id);
    if (turnId && (!status || status === "inprogress" || status === "running" || status === "active")) {
      return turnId;
    }
  }
  // Completed/interrupted turns are not interruptible; do not fall back to the
  // latest turn id or Desktop's stale expectedTurnId checks become no-ops.
  return "";
}

function createDisabledDesktopIpcLiveOwner() {
  return {
    observeInbound() {},
    observeOutbound() {},
    stopAll() {},
    isThreadOwned() {
      return false;
    },
  };
}

module.exports = {
  AGNT_LIVE_OWNER_SOURCE,
  OWNER_INBOUND_METHODS,
  SUPPORTED_FOLLOWER_REQUEST_METHODS,
  THREAD_ARCHIVED,
  THREAD_QUEUED_FOLLOWUPS_CHANGED,
  THREAD_READ_METHODS,
  THREAD_READ_STATE_CHANGED,
  THREAD_STREAM_STATE_CHANGED,
  THREAD_UNARCHIVED,
  activeTurnIdFromConversation,
  conversationHasActiveTurn,
  createDisabledDesktopIpcLiveOwner,
  isPeerOwnershipBroadcast,
};
