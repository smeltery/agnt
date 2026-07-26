// FILE: rollout-live-mirror-controller.js
// Purpose: Tails desktop rollout files and forwards parsed lines to the live mirror synthesizer.
// Layer: CLI helper
// Exports: createRolloutLiveMirrorController
// Depends on: fs, ./rollout-watch, ./rollout-live-mirror-bootstrap

const fs = require("fs");
const {
  findRecentRolloutFileForContextRead,
  resolveSessionsRoot,
} = require("../rollout-watch");
const {
  bootstrapFromExistingRollout,
} = require("../rollout-live-mirror-bootstrap");
const {
  createNotification,
  readFileSize,
  readFileSlice,
  readString,
  readThreadId,
  safeParseJSON,
} = require("../rollout-live-mirror-utils");

const DEFAULT_POLL_INTERVAL_MS = 700;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_ACTIVITY_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_ACTIVE_RUN_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_SYNTHETIC_TERMINAL_GRACE_MS = 1_000;
const DESKTOP_RESUME_METHODS = new Set(["thread/read", "thread/resume"]);

function createRolloutLiveMirrorController({
  sendApplicationResponse,
  shouldSuppressThread = () => false,
  logPrefix = "[agnt]",
  fsModule = fs,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  activityHeartbeatMs = DEFAULT_ACTIVITY_HEARTBEAT_MS,
  staleActiveRunMaxAgeMs = DEFAULT_STALE_ACTIVE_RUN_MAX_AGE_MS,
  syntheticTerminalGraceMs = DEFAULT_SYNTHETIC_TERMINAL_GRACE_MS,
  createMirrorState,
  processRolloutLines,
  resetRunState,
  finalizePendingSyntheticTerminalIfReady,
} = {}) {
  const mirrorsByThreadId = new Map();

  function observeInbound(rawMessage) {
    const request = safeParseJSON(rawMessage);
    const method = readString(request?.method);
    if (!DESKTOP_RESUME_METHODS.has(method)) {
      return;
    }

    const threadId = readThreadId(request?.params);
    if (!threadId) {
      return;
    }

    const existingMirror = mirrorsByThreadId.get(threadId);
    if (existingMirror) {
      existingMirror.bump();
      return;
    }

    let mirror;
    mirror = createThreadRolloutLiveMirror({
      threadId,
      sendApplicationResponse: (rawNotification) => {
        if (!shouldSuppressThread(threadId)) {
          sendApplicationResponse(rawNotification);
        }
      },
      isSuppressed: () => Boolean(shouldSuppressThread(threadId)),
      logPrefix,
      fsModule,
      now,
      setIntervalFn,
      clearIntervalFn,
      pollIntervalMs,
      lookupTimeoutMs,
      idleTimeoutMs,
      activityHeartbeatMs,
      staleActiveRunMaxAgeMs,
      syntheticTerminalGraceMs,
      createMirrorState,
      processRolloutLines,
      resetRunState,
      finalizePendingSyntheticTerminalIfReady,
      onStop() {
        if (mirrorsByThreadId.get(threadId) === mirror) {
          mirrorsByThreadId.delete(threadId);
        }
      },
    });
    mirrorsByThreadId.set(threadId, mirror);
  }

  function stopAll() {
    for (const mirror of mirrorsByThreadId.values()) {
      mirror.stop();
    }
    mirrorsByThreadId.clear();
  }

  function getActiveTurnId(threadId) {
    return mirrorsByThreadId.get(threadId)?.getActiveTurnId() || null;
  }

  return {
    getActiveTurnId,
    observeInbound,
    stopAll,
  };
}

function createThreadRolloutLiveMirror({
  threadId,
  sendApplicationResponse,
  isSuppressed = () => false,
  logPrefix,
  fsModule,
  now,
  setIntervalFn,
  clearIntervalFn,
  pollIntervalMs,
  lookupTimeoutMs,
  idleTimeoutMs,
  activityHeartbeatMs,
  staleActiveRunMaxAgeMs,
  syntheticTerminalGraceMs,
  createMirrorState,
  processRolloutLines,
  resetRunState,
  finalizePendingSyntheticTerminalIfReady,
  onStop = () => {},
}) {
  const startedAt = now();
  const state = createMirrorState(threadId);

  let isStopped = false;
  let rolloutPath = null;
  let lastSize = 0;
  let partialLine = "";
  let lastActivityAt = startedAt;
  let lastGrowthAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let didBootstrap = false;
  let wasSuppressed = false;

  const intervalId = setIntervalFn(tick, pollIntervalMs);
  tick();

  function tick() {
    if (isStopped) {
      return;
    }

    try {
      const currentTime = now();
      const suppressed = isSuppressed();
      if (wasSuppressed && !suppressed && didBootstrap) {
        lastSize = 0;
        partialLine = "";
        didBootstrap = false;
        resetRunState(state);
      }
      wasSuppressed = suppressed;

      if (!rolloutPath) {
        if (currentTime - startedAt >= lookupTimeoutMs) {
          stop();
          return;
        }

        rolloutPath = findRecentRolloutFileForContextRead(resolveSessionsRoot(), {
          threadId,
          fsModule,
        });
        if (!rolloutPath) {
          return;
        }
      }

      const fileSize = readFileSize(rolloutPath, fsModule);
      if (!didBootstrap) {
        didBootstrap = true;
        bootstrapFromExistingRollout({
          rolloutPath,
          fileSize,
          state,
          fsModule,
          sendApplicationResponse,
          processRolloutLines,
          nowMs: currentTime,
          staleActiveRunMaxAgeMs,
        });
        lastSize = fileSize;
        lastActivityAt = currentTime;
        lastGrowthAt = currentTime;
        lastHeartbeatAt = currentTime;
        if (state.isDesktopOrigin === false) {
          stop();
        }
        return;
      }

      if (fileSize < lastSize) {
        lastSize = 0;
        partialLine = "";
        didBootstrap = false;
        resetRunState(state);
        lastGrowthAt = currentTime;
        return;
      }

      if (fileSize > lastSize) {
        const chunk = readFileSlice(rolloutPath, lastSize, fileSize, fsModule);
        lastSize = fileSize;
        lastActivityAt = currentTime;
        lastGrowthAt = currentTime;
        lastHeartbeatAt = currentTime;
        state.suppressLiveActivityUntilGrowth = false;
        if (!chunk) {
          return;
        }

        const combined = `${partialLine}${chunk}`;
        const lines = combined.split("\n");
        partialLine = lines.pop() || "";
        processRolloutLines(lines, state, sendApplicationResponse, { nowMs: currentTime });
        return;
      }

      const syntheticTerminalNotifications = finalizePendingSyntheticTerminalIfReady(
        state,
        currentTime,
        syntheticTerminalGraceMs
      );
      if (syntheticTerminalNotifications.length > 0) {
        for (const notification of syntheticTerminalNotifications) {
          sendApplicationResponse(JSON.stringify(notification));
        }
        lastActivityAt = currentTime;
        lastHeartbeatAt = currentTime;
        return;
      }

      if (state.activeTurnId && currentTime - lastGrowthAt >= staleActiveRunMaxAgeMs) {
        stop();
        return;
      }

      if (
        state.isDesktopOrigin !== false
        && state.activeTurnId
        && !state.suppressLiveActivityUntilGrowth
        && currentTime - lastHeartbeatAt >= activityHeartbeatMs
      ) {
        lastHeartbeatAt = currentTime;
        lastActivityAt = currentTime;
        sendApplicationResponse(JSON.stringify(createNotification("turn/activity", {
          threadId: state.threadId,
          turnId: state.activeTurnId,
          id: state.activeTurnId,
        })));
      }

      if (currentTime - lastActivityAt >= idleTimeoutMs) {
        if (partialLine) {
          const flushLine = partialLine;
          partialLine = "";
          processRolloutLines([flushLine], state, sendApplicationResponse);
        }
        stop();
      }
    } catch (error) {
      console.warn(`${logPrefix} rollout live mirror stopped for ${threadId}: ${error.message}`);
      stop();
    }
  }

  function bump() {
    lastActivityAt = now();
  }

  function stop() {
    if (isStopped) {
      return;
    }

    isStopped = true;
    clearIntervalFn(intervalId);
    onStop();
  }

  function getActiveTurnId() {
    if (
      isStopped
      || wasSuppressed
      || state.isDesktopOrigin === false
      || state.suppressLiveActivityUntilGrowth
      || state.activeTurnIdIsSynthetic
      || state.pendingSyntheticTerminalTurnId
    ) {
      return null;
    }
    return state.activeTurnId || null;
  }

  return {
    bump,
    getActiveTurnId,
    stop,
  };
}

module.exports = {
  createRolloutLiveMirrorController,
};
