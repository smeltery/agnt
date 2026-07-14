// FILE: rollout-live-mirror.js
// Purpose: Mirrors desktop-origin rollout activity back into live bridge notifications for iPhone catch-up.
// Layer: CLI helper
// Exports: createRolloutLiveMirrorController
// Depends on: ./rollout-live-mirror-controller, ./apply-patch-changes, rollout-live-mirror-utils

const { hasVisiblePlanUpdate } = require("./desktop-ipc-shared");
const {
  terminalEventClosesTrackedTurn,
} = require("./rollout-live-mirror-bootstrap");
const {
  createRolloutLiveMirrorController: createController,
} = require("./rollout-live-mirror/controller");
const {
  customToolStartNotifications,
  imageGenerationNotifications,
  patchApplyEndNotifications,
  toolOutputNotifications,
  toolStartNotifications,
  turnFileChangeSnapshotNotifications,
} = require("./rollout-live-mirror/tool-notifications");
const {
  clearPendingSyntheticTerminal,
  createMirrorState,
  finalizePendingSyntheticTerminalIfReady,
  flushPendingUserMessageNotifications,
  isSyntheticTerminalMismatch,
  markPendingSyntheticTerminal,
  populateSessionMetaState,
  resetRunState,
  resolveRolloutEventTurnId,
  rolloutUserPromptText,
} = require("./rollout-live-mirror/state");
const {
  agentMessageDedupeKey,
  buildAgentMessageItemId,
  buildSyntheticItemId,
  buildSyntheticTurnId,
  createNotification,
  extractReasoningText,
  firstNonEmptyString,
  isDesktopRolloutOrigin,
  normalizeProgressPlanSteps,
  normalizeRolloutItemType,
  readString,
  readUserMessageTimestamp,
  safeParseJSON,
  timestampParams,
} = require("./rollout-live-mirror-utils");
const notificationHelpers = {
  ensureThinkingNotifications,
  planUpdateNotifications,
  resolveRolloutEventTurnId,
};

function createRolloutLiveMirrorController(options = {}) {
  return createController({
    ...options,
    createMirrorState,
    processRolloutLines,
    resetRunState,
    finalizePendingSyntheticTerminalIfReady,
  });
}

function processRolloutLines(lines, state, sendApplicationResponse, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return;
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const parsed = safeParseJSON(line);
    if (!parsed) {
      continue;
    }

    const notifications = synthesizeNotificationsFromRolloutEntry(parsed, state, { nowMs });
    for (const notification of notifications) {
      sendApplicationResponse(JSON.stringify(notification));
    }
  }
}

function synthesizeNotificationsFromRolloutEntry(entry, state, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (entry?.type === "session_meta") {
    populateSessionMetaState(state, entry.payload);
    if (!isDesktopRolloutOrigin(state.sessionMeta)) {
      state.isDesktopOrigin = false;
    } else if (state.isDesktopOrigin == null) {
      state.isDesktopOrigin = true;
    }
    return [];
  }

  if (state.isDesktopOrigin === false) {
    return [];
  }

  const notifications = [];

  if (entry?.type === "event_msg") {
    const payload = entry.payload || {};
    const eventType = readString(payload.type);

    if (eventType === "task_started") {
      const explicitTurnId = readString(payload.turn_id) || readString(payload.turnId);
      const turnId = explicitTurnId || buildSyntheticTurnId(state, entry);
      if (!turnId) {
        return [];
      }

      state.activeTurnId = turnId;
      state.activeTurnIdIsSynthetic = !explicitTurnId;
      clearPendingSyntheticTerminal(state);
      state.reasoningItemId = buildSyntheticItemId("thinking", state.threadId, turnId);
      state.hasThinking = false;
      state.commandCalls.clear();
      state.applyPatchCalls.clear();
      state.emittedPatchApplyEndCalls.clear();

      notifications.push(createNotification("turn/started", {
        threadId: state.threadId,
        turnId,
        id: turnId,
      }));
      notifications.push(...flushPendingUserMessageNotifications(state, turnId));
      notifications.push(...ensureThinkingNotifications(state));
      return notifications;
    }

    if (eventType === "user_message") {
      const message = rolloutUserPromptText(payload);
      if (!message) {
        return [];
      }

      const turnId = resolveRolloutEventTurnId(state, payload);
      if (!turnId) {
        // No active turn yet: buffer until the next task_started flushes it.
        state.pendingUserMessages.push({
          id: readString(payload.id),
          message,
          timestamp: readUserMessageTimestamp(entry, payload),
        });
        return [];
      }

      notifications.push(createNotification("codex/event/user_message", {
        threadId: state.threadId,
        turnId,
        message,
        ...(readString(payload.id) ? { id: readString(payload.id) } : {}),
        ...timestampParams(readUserMessageTimestamp(entry, payload)),
      }));
      return notifications;
    }

    if (eventType === "task_complete") {
      const turnId = resolveRolloutEventTurnId(state, payload, { allowSyntheticPromotion: false });
      if (!turnId) {
        return [];
      }

      const closesActiveRun = terminalEventClosesTrackedTurn(turnId, state.activeTurnId);
      if (closesActiveRun) {
        notifications.push(...turnFileChangeSnapshotNotifications(state, turnId));
      }
      notifications.push(createNotification("turn/completed", {
        threadId: state.threadId,
        turnId,
        id: turnId,
      }));
      if (closesActiveRun) {
        resetRunState(state);
      } else if (isSyntheticTerminalMismatch(state, turnId)) {
        markPendingSyntheticTerminal(state, { status: "completed" }, nowMs);
      }
      return notifications;
    }

    if (eventType === "turn_aborted" || eventType === "error") {
      const turnId = resolveRolloutEventTurnId(state, payload, { allowSyntheticPromotion: false });
      if (!turnId) {
        return [];
      }

      const params = {
        threadId: state.threadId,
        turnId,
        id: turnId,
        status: eventType === "error" ? "failed" : "aborted",
      };
      const errorMessage = readString(payload.message);
      if (eventType === "error" && errorMessage) {
        params.error = { message: errorMessage };
      }
      notifications.push(createNotification("turn/completed", params));
      if (terminalEventClosesTrackedTurn(turnId, state.activeTurnId)) {
        resetRunState(state);
      } else if (isSyntheticTerminalMismatch(state, turnId)) {
        markPendingSyntheticTerminal(state, params, nowMs);
      }
      return notifications;
    }

    if (eventType === "item_completed") {
      notifications.push(...itemCompletedNotifications(state, payload));
      return notifications;
    }

    if (eventType === "agent_reasoning") {
      notifications.push(...reasoningNotifications(state, firstNonEmptyString([
        readString(payload.message),
        readString(payload.text),
        readString(payload.summary),
      ])));
      return notifications;
    }

    if (eventType === "agent_message") {
      notifications.push(...agentMessageNotifications(state, entry, payload));
      return notifications;
    }

    if (eventType === "image_generation_end") {
      notifications.push(...imageGenerationNotifications(state, payload, notificationHelpers, {
        preferCallId: true,
      }));
      return notifications;
    }

    if (eventType === "patch_apply_end") {
      notifications.push(...patchApplyEndNotifications(state, payload, notificationHelpers));
      return notifications;
    }

    return [];
  }

  if (entry?.type !== "response_item") {
    return [];
  }

  const payload = entry.payload || {};
  const itemType = normalizeRolloutItemType(payload.type);

  if (itemType === "message") {
    notifications.push(...responseItemMessageNotifications(state, entry, payload));
    return notifications;
  }

  if (itemType === "reasoning") {
    notifications.push(...reasoningNotifications(state, extractReasoningText(payload)));
    return notifications;
  }

  if (itemType === "functioncall") {
    notifications.push(...toolStartNotifications(state, payload, notificationHelpers));
    return notifications;
  }

  if (itemType === "customtoolcall") {
    notifications.push(...customToolStartNotifications(state, payload, notificationHelpers));
    return notifications;
  }

  if (itemType === "functioncalloutput") {
    notifications.push(...toolOutputNotifications(state, payload, notificationHelpers));
    return notifications;
  }

  if (itemType === "imagegeneration" || itemType === "imagegenerationcall" || itemType === "imagegenerationend" || itemType === "imageview") {
    notifications.push(...imageGenerationNotifications(state, payload, notificationHelpers));
    return notifications;
  }

  return notifications;
}

function responseItemMessageNotifications(state, entry, payload) {
  const role = readString(payload?.role).toLowerCase();
  if (role && role !== "assistant") {
    return [];
  }

  const message = extractResponseItemMessageText(payload);
  if (!message) {
    return [];
  }

  return agentMessageNotifications(state, entry, {
    message,
    phase: payload?.phase,
    itemId: readString(payload?.id),
    turn_id: readString(payload?.turn_id) || readString(payload?.internal_chat_message_metadata_passthrough?.turn_id),
    turnId: readString(payload?.turnId) || readString(payload?.internal_chat_message_metadata_passthrough?.turnId),
  });
}

function agentMessageNotifications(state, entry, payload) {
  const message = readString(payload?.message) || readString(payload?.text);
  if (!message) {
    return [];
  }

  const turnId = resolveRolloutEventTurnId(state, payload);
  const dedupeKey = agentMessageDedupeKey(turnId, message);
  if (state.emittedAgentMessageKeys.has(dedupeKey)) {
    return [];
  }
  state.emittedAgentMessageKeys.add(dedupeKey);

  const params = {
    threadId: state.threadId,
    turnId,
    itemId: readString(payload?.itemId) || buildAgentMessageItemId(state.threadId, turnId, entry, message),
    message,
  };
  const phase = readString(payload?.phase);
  if (phase) {
    params.phase = phase;
  }

  return [createNotification("codex/event/agent_message", params)];
}

function extractResponseItemMessageText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = content
    .map((part) => readString(part?.text) || readString(part?.content) || readString(part?.message))
    .filter(Boolean);
  return parts.join("\n");
}

function reasoningNotifications(state, text) {
  if (!state.activeTurnId) {
    return [];
  }

  const rawText = readString(text);
  if (!rawText) {
    return ensureThinkingNotifications(state);
  }

  const summaryEntries = summaryOnlyReasoningEntries(rawText);
  let visibleText = rawText;
  if (summaryEntries) {
    const unseenEntries = summaryEntries.filter((entry) => {
      if (state.emittedReasoningSummaryKeys.has(entry.key)) {
        return false;
      }
      state.emittedReasoningSummaryKeys.add(entry.key);
      return true;
    });
    if (unseenEntries.length === 0) {
      return [];
    }
    visibleText = unseenEntries
      .map((entry) => `**${entry.title}**\n\n<!-- -->`)
      .join("\n\n");
  }

  state.hasThinking = true;
  const delta = `${state.hasReasoningContent ? "\n\n" : ""}${visibleText}`;
  state.hasReasoningContent = true;
  return [
    createNotification("item/reasoning/textDelta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId: state.reasoningItemId || buildSyntheticItemId("thinking", state.threadId, state.activeTurnId),
      delta,
    }),
  ];
}

function summaryOnlyReasoningEntries(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^<!--.*-->$/.test(line)) {
      continue;
    }
    const match = /^\*\*(.+?)\*\*$/.exec(line);
    if (!match) {
      return null;
    }
    const title = match[1].trim();
    if (!title) {
      return null;
    }
    entries.push({
      title,
      key: title.replace(/\s+/g, " ").toLowerCase(),
    });
  }
  return entries.length > 0 ? entries : null;
}

function itemCompletedNotifications(state, payload) {
  const item = payload && typeof payload.item === "object" && !Array.isArray(payload.item)
    ? payload.item
    : null;
  if (!item || normalizeRolloutItemType(item.type) !== "plan") {
    return [];
  }

  const turnId = resolveRolloutEventTurnId(state, payload);
  if (!turnId) {
    return [];
  }

  return [
    createNotification("item/completed", {
      threadId: state.threadId,
      turnId,
      item,
    }),
  ];
}

function ensureThinkingNotifications(state) {
  if (!state.activeTurnId || state.hasThinking) {
    return [];
  }

  state.hasThinking = true;
  if (!state.reasoningItemId) {
    state.reasoningItemId = buildSyntheticItemId("thinking", state.threadId, state.activeTurnId);
  }

  return [
    createNotification("item/reasoning/textDelta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId: state.reasoningItemId,
      delta: "Thinking...",
    }),
  ];
}

function planUpdateNotifications(state, argumentsObject) {
  const plan = normalizeProgressPlanSteps(argumentsObject.plan);
  const explanation = readString(argumentsObject.explanation);
  if (!hasVisiblePlanUpdate(explanation, plan)) {
    return [];
  }

  const params = {
    threadId: state.threadId,
    turnId: state.activeTurnId,
    plan,
  };
  if (explanation) {
    params.explanation = explanation;
  }

  return [createNotification("turn/plan/updated", params)];
}

module.exports = {
  createRolloutLiveMirrorController,
  isDesktopRolloutOrigin,
};
