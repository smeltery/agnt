// FILE: providers/codex/desktop-refresher-state.js
// Purpose: Initializes volatile Codex desktop refresher state.
// Layer: provider plugin (codex)

function initializeDesktopRefresherState(refresher, { enabled }) {
  refresher.mode = "idle";
  refresher.pendingNewThread = false;
  refresher.pendingRefreshKinds = new Set();
  refresher.pendingCompletionRefresh = false;
  refresher.pendingCompletionTurnId = null;
  refresher.pendingCompletionTargetUrl = "";
  refresher.pendingCompletionTargetThreadId = "";
  refresher.pendingTargetUrl = "";
  refresher.pendingTargetThreadId = "";
  refresher.lastRefreshAt = 0;
  refresher.lastRefreshSignature = "";
  refresher.lastTurnIdRefreshed = null;
  refresher.lastMidRunRefreshAt = 0;
  refresher.refreshTimer = null;
  refresher.refreshRunning = false;
  refresher.fallbackTimer = null;
  refresher.activeWatcher = null;
  refresher.activeWatchedThreadId = null;
  refresher.watchStartAt = 0;
  refresher.lastRolloutSize = null;
  refresher.stopWatcherAfterRefreshThreadId = null;
  refresher.materializationPendingThreadIds = new Set();
  refresher.followedThreadIds = new Set();
  refresher.followAttemptsByThreadId = new Map();
  refresher.followConfirmationTimersByThreadId = new Map();
  refresher.followActivationSerial = 0;
  refresher.runtimeRefreshAvailable = enabled;
  refresher.consecutiveRefreshFailures = 0;
  refresher.unavailableLogged = false;
}

module.exports = {
  initializeDesktopRefresherState,
};
