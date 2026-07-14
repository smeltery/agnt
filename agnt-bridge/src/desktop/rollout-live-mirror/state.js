// FILE: rollout-live-mirror-state.js
// Purpose: Owns rollout live-mirror run state and synthetic-turn lifecycle helpers.
// Layer: CLI helper
// Depends on: ../bridge/contextual-user-items, ./rollout-live-mirror-tool-notifications, ./rollout-live-mirror-utils

const {
  visibleUserPromptFromInputEntries,
} = require("../../bridge/contextual-user-items");
const {
  turnFileChangeSnapshotNotifications,
} = require("./tool-notifications");
const {
  buildSyntheticItemId,
  createNotification,
  readString,
  timestampParams,
} = require("../rollout-live-mirror-utils");

const DEFAULT_SYNTHETIC_TERMINAL_GRACE_MS = 1_000;

function createMirrorState(threadId) {
  return {
    threadId,
    sessionMeta: null,
    isDesktopOrigin: null,
    activeTurnId: null,
    activeTurnIdIsSynthetic: false,
    pendingSyntheticTerminalTurnId: null,
    pendingSyntheticTerminalStartedAt: 0,
    pendingSyntheticTerminalStatus: "",
    pendingSyntheticTerminalErrorMessage: "",
    reasoningItemId: null,
    hasThinking: false,
    hasReasoningContent: false,
    emittedReasoningSummaryKeys: new Set(),
    commandCalls: new Map(),
    applyPatchCalls: new Map(),
    emittedPatchApplyEndCalls: new Set(),
    emittedAgentMessageKeys: new Set(),
    pendingUserMessages: [],
    suppressLiveActivityUntilGrowth: false,
  };
}

function populateSessionMetaState(state, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  state.sessionMeta = {
    originator: readString(payload.originator),
    source: readString(payload.source),
    cwd: readString(payload.cwd),
  };
}

function resolveRolloutEventTurnId(state, payload = {}, options = {}) {
  const explicitTurnId = readString(payload.turn_id) || readString(payload.turnId);
  if (state.activeTurnIdIsSynthetic && state.activeTurnId) {
    if (explicitTurnId) {
      if (options.allowSyntheticPromotion !== false) {
        promoteSyntheticTurnId(state, explicitTurnId);
      }
      return explicitTurnId;
    }
    return state.activeTurnId;
  }
  return explicitTurnId || state.activeTurnId || "";
}

function promoteSyntheticTurnId(state, explicitTurnId) {
  const oldTurnId = state.activeTurnId;
  if (!oldTurnId || oldTurnId === explicitTurnId) {
    state.activeTurnId = explicitTurnId;
    state.activeTurnIdIsSynthetic = false;
    return;
  }

  state.activeTurnId = explicitTurnId;
  state.activeTurnIdIsSynthetic = false;
  if (state.reasoningItemId === buildSyntheticItemId("thinking", state.threadId, oldTurnId)) {
    state.reasoningItemId = buildSyntheticItemId("thinking", state.threadId, explicitTurnId);
  }
}

function markPendingSyntheticTerminal(state, terminalParams, nowMs) {
  if (state.activeTurnIdIsSynthetic && state.activeTurnId) {
    state.pendingSyntheticTerminalTurnId = state.activeTurnId;
    state.pendingSyntheticTerminalStartedAt = nowMs;
    state.pendingSyntheticTerminalStatus = readString(terminalParams.status) || "";
    state.pendingSyntheticTerminalErrorMessage = readString(terminalParams.error?.message) || "";
  }
}

function clearPendingSyntheticTerminal(state) {
  state.pendingSyntheticTerminalTurnId = null;
  state.pendingSyntheticTerminalStartedAt = 0;
  state.pendingSyntheticTerminalStatus = "";
  state.pendingSyntheticTerminalErrorMessage = "";
}

function isSyntheticTerminalMismatch(state, terminalTurnId) {
  return Boolean(
    state.activeTurnIdIsSynthetic
    && state.activeTurnId
    && terminalTurnId
    && terminalTurnId !== state.activeTurnId
  );
}

function finalizePendingSyntheticTerminal(state) {
  const turnId = state.pendingSyntheticTerminalTurnId;
  if (!turnId) {
    return [];
  }

  const terminalParams = {
    threadId: state.threadId,
    turnId,
    id: turnId,
  };
  if (state.pendingSyntheticTerminalStatus) {
    terminalParams.status = state.pendingSyntheticTerminalStatus;
  }
  if (state.pendingSyntheticTerminalErrorMessage) {
    terminalParams.error = { message: state.pendingSyntheticTerminalErrorMessage };
  }

  const notifications = [
    ...turnFileChangeSnapshotNotifications(state, turnId),
    createNotification("turn/completed", terminalParams),
  ];
  resetRunState(state);
  return notifications;
}

function finalizePendingSyntheticTerminalIfReady(state, nowMs, graceMs) {
  if (!state.pendingSyntheticTerminalTurnId) {
    return [];
  }
  const startedAt = Number.isFinite(state.pendingSyntheticTerminalStartedAt)
    ? state.pendingSyntheticTerminalStartedAt
    : nowMs;
  const resolvedGraceMs = Number.isFinite(graceMs)
    ? Math.max(0, graceMs)
    : DEFAULT_SYNTHETIC_TERMINAL_GRACE_MS;
  if (nowMs - startedAt < resolvedGraceMs) {
    return [];
  }
  return finalizePendingSyntheticTerminal(state);
}

function flushPendingUserMessageNotifications(state, turnId) {
  const messages = state.pendingUserMessages.splice(0);
  if (messages.length === 0) {
    return [];
  }

  const resolvedTurnId = readString(turnId) || readString(state.activeTurnId);
  return messages.map((pending) => createNotification("codex/event/user_message", {
    threadId: state.threadId,
    ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    message: visibleUserPromptFromInputEntries(pending.message),
    ...(pending.id ? { id: pending.id } : {}),
    ...timestampParams(pending.timestamp),
  })).filter((notification) => notification.params.message);
}

function rolloutUserPromptText(payload = {}) {
  const candidates = [payload.message, payload.text, payload.input];
  for (const candidate of candidates) {
    const message = visibleUserPromptFromInputEntries(candidate);
    if (message) {
      return message;
    }
  }
  return "";
}

function resetRunState(state) {
  state.activeTurnId = null;
  state.activeTurnIdIsSynthetic = false;
  clearPendingSyntheticTerminal(state);
  state.reasoningItemId = null;
  state.hasThinking = false;
  state.hasReasoningContent = false;
  state.emittedReasoningSummaryKeys.clear();
  state.commandCalls.clear();
  state.applyPatchCalls.clear();
  state.emittedPatchApplyEndCalls.clear();
  state.emittedAgentMessageKeys.clear();
  state.pendingUserMessages.length = 0;
}

module.exports = {
  createMirrorState,
  clearPendingSyntheticTerminal,
  finalizePendingSyntheticTerminalIfReady,
  flushPendingUserMessageNotifications,
  isSyntheticTerminalMismatch,
  markPendingSyntheticTerminal,
  populateSessionMetaState,
  resetRunState,
  resolveRolloutEventTurnId,
  rolloutUserPromptText,
};
