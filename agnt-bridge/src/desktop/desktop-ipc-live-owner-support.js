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
  createDisabledDesktopIpcLiveOwner,
};
