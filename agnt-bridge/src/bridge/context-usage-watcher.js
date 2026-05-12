// FILE: context-usage-watcher.js
// Purpose: Owns the per-thread rollout watcher that tails Codex's session
//          JSONL to surface live context-window usage to the iOS app even
//          when the runtime omits live thread/tokenUsage/updated events.
// Layer: bridge utility — single-thread keyed state machine.
// Exports: createContextUsageWatcher
//
// Why a module: this used to be three closure-bound helpers
// (`ensureContextUsageWatcher`, `stopContextUsageWatcher`,
// `sendContextUsageNotification`) plus two `let` slots
// (`contextUsageWatcher`, `watchedContextUsageKey`) sitting near the top of
// `startBridge`. None of them touch the relay loop directly — they only need
// `sendApplicationResponse` and the rollout-watch factory. Lifting the whole
// cluster into a focused module makes the watcher's keyed-replace semantics
// obvious instead of being interleaved with relay state.

const { createThreadRolloutActivityWatcher } = require("../desktop/rollout-watch");

/**
 * Pure helper used to build the watcher key. Exported only for tests.
 */
function buildWatcherKey(threadId, turnId) {
  return `${threadId}|${turnId || "pending-turn"}`;
}

function readString(value) {
  return typeof value === "string" && value ? value : "";
}

/**
 * @param {object} deps
 * @param {(line: string) => void} deps.sendApplicationResponse
 *   — Push a relay-bound JSON-RPC line back to the phone. Wired to the
 *     bridge's existing secure-transport queue.
 * @param {Function} [deps.createWatcher] — factory injection point for
 *     tests. Defaults to the real `createThreadRolloutActivityWatcher`.
 * @returns {{
 *   ensure: (ctx: { threadId: string, turnId: string }) => void,
 *   stop:   () => void,
 *   isWatching: () => boolean,
 * }}
 */
function createContextUsageWatcher({
  sendApplicationResponse,
  createWatcher = createThreadRolloutActivityWatcher,
}) {
  let activeWatcher = null;
  let activeKey = null;

  function stop() {
    if (activeWatcher) {
      activeWatcher.stop();
    }
    activeWatcher = null;
    activeKey = null;
  }

  function ensure({ threadId, turnId } = {}) {
    const normalizedThreadId = readString(threadId);
    const normalizedTurnId = readString(turnId);
    if (!normalizedThreadId) {
      return;
    }

    const nextKey = buildWatcherKey(normalizedThreadId, normalizedTurnId);
    if (activeKey === nextKey && activeWatcher) {
      // Same (thread, turn) tuple — already watching. Don't churn the file
      // handle.
      return;
    }

    stop();
    activeKey = nextKey;
    activeWatcher = createWatcher({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      onUsage: ({ threadId: usageThreadId, usage }) => {
        sendUsageNotification(sendApplicationResponse, usageThreadId, usage);
      },
      onIdle: () => {
        // Each lifecycle callback is gated on the current key so a stale
        // watcher that was already replaced can't tear down its successor.
        if (activeKey === nextKey) stop();
      },
      onTimeout: () => {
        if (activeKey === nextKey) stop();
      },
      onError: () => {
        if (activeKey === nextKey) stop();
      },
    });
  }

  function isWatching() {
    return Boolean(activeWatcher);
  }

  return { ensure, stop, isWatching };
}

function sendUsageNotification(sendApplicationResponse, threadId, usage) {
  if (!threadId || !usage) {
    return;
  }
  sendApplicationResponse(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: { threadId, usage },
  }));
}

module.exports = {
  createContextUsageWatcher,
  buildWatcherKey,
};
