// FILE: rollout-live-mirror.js
// Purpose: Mirrors desktop-origin rollout activity back into live bridge notifications for iPhone catch-up.
// Layer: CLI helper
// Exports: createRolloutLiveMirrorController
// Depends on: fs, ./rollout-watch, ./apply-patch-changes, rollout-live-mirror-utils

const fs = require("fs");
const {
  findRecentRolloutFileForContextRead,
  resolveSessionsRoot,
} = require("./rollout-watch");
const {
  visibleUserPromptFromInputEntries,
} = require("../bridge/contextual-user-items");
const { buildApplyPatchFileChangeItem } = require("./apply-patch-changes");
const { hasVisiblePlanUpdate } = require("./desktop-ipc-shared");
const {
  bootstrapFromExistingRollout,
  terminalEventClosesTrackedTurn,
} = require("./rollout-live-mirror-bootstrap");
const {
  agentMessageDedupeKey,
  buildAgentMessageItemId,
  buildSyntheticItemId,
  buildSyntheticTurnId,
  createNotification,
  extractReasoningText,
  firstNonEmptyString,
  generatedImagePathForRolloutItem,
  genericToolActivityMessage,
  isCommandToolName,
  isDesktopRolloutOrigin,
  isInternalProgressPlanToolName,
  normalizeProgressPlanSteps,
  normalizeRolloutItemType,
  parseToolArguments,
  readFileSize,
  readFileSlice,
  readString,
  readThreadId,
  readUserMessageTimestamp,
  resolveToolCommand,
  resolveToolWorkingDirectory,
  safeParseJSON,
  timestampParams,
} = require("./rollout-live-mirror-utils");

const DEFAULT_POLL_INTERVAL_MS = 700;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_ACTIVITY_HEARTBEAT_MS = 5_000;
// Bootstrap replay must not revive old runs whose rollout stopped growing
// before a terminal event was written.
const DEFAULT_STALE_ACTIVE_RUN_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_SYNTHETIC_TERMINAL_GRACE_MS = 1_000;
const DESKTOP_RESUME_METHODS = new Set(["thread/read", "thread/resume"]);

// Observes desktop-authored rollout files and replays the currently active run as
// bridge notifications so the phone can render live thinking/tool activity.
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

  return {
    observeInbound,
    stopAll,
  };
}

// Tails one thread rollout and emits synthetic app-server-like notifications for
// the currently active desktop-origin run only.
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

  return {
    bump,
    stop,
  };
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
      notifications.push(...imageGenerationNotifications(state, payload, {
        preferCallId: true,
      }));
      return notifications;
    }

    if (eventType === "patch_apply_end") {
      notifications.push(...patchApplyEndNotifications(state, payload));
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
    notifications.push(...toolStartNotifications(state, payload));
    return notifications;
  }

  if (itemType === "customtoolcall") {
    notifications.push(...customToolStartNotifications(state, payload));
    return notifications;
  }

  if (itemType === "functioncalloutput") {
    notifications.push(...toolOutputNotifications(state, payload));
    return notifications;
  }

  if (itemType === "imagegeneration" || itemType === "imagegenerationcall" || itemType === "imagegenerationend" || itemType === "imageview") {
    notifications.push(...imageGenerationNotifications(state, payload));
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

function toolStartNotifications(state, payload) {
  if (!state.activeTurnId) {
    return [];
  }

  const callId = readString(payload.call_id) || readString(payload.callId);
  const toolName = readString(payload.name);
  if (!callId || !toolName) {
    return [];
  }

  const argumentsObject = parseToolArguments(payload.arguments);
  if (isInternalProgressPlanToolName(toolName)) {
    return [
      ...ensureThinkingNotifications(state),
      ...planUpdateNotifications(state, argumentsObject),
    ];
  }

  state.commandCalls.set(callId, {
    toolName,
    command: resolveToolCommand(toolName, argumentsObject),
    cwd: resolveToolWorkingDirectory(argumentsObject, state),
  });

  if (isCommandToolName(toolName)) {
    const command = state.commandCalls.get(callId)?.command || toolName;
    return [
      ...ensureThinkingNotifications(state),
      createNotification("codex/event/exec_command_begin", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        call_id: callId,
        command,
        cwd: state.commandCalls.get(callId)?.cwd || state.sessionMeta?.cwd || "",
        status: "running",
      }),
    ];
  }

  const activityMessage = genericToolActivityMessage(toolName);
  if (!activityMessage) {
    return ensureThinkingNotifications(state);
  }

  return [
    ...ensureThinkingNotifications(state),
    createNotification("codex/event/background_event", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      message: activityMessage,
    }),
  ];
}

function customToolStartNotifications(state, payload) {
  if (!state.activeTurnId) {
    return [];
  }

  const callId = readString(payload.call_id) || readString(payload.callId);
  const toolName = readString(payload.name);
  if (!callId || !toolName) {
    return [];
  }

  const notifications = [...ensureThinkingNotifications(state)];
  if (toolName === "apply_patch") {
    const item = buildApplyPatchFileChangeItem({
      callId,
      patch: readString(payload.input),
      status: readString(payload.status) || "completed",
      idFallback: buildSyntheticItemId("file-change", state.threadId, state.activeTurnId, callId),
      cwd: resolveToolWorkingDirectory({}, state),
    });
    if (item) {
      state.applyPatchCalls.set(callId, item);
      notifications.push(createNotification("codex/event/patch_apply_begin", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        id: state.activeTurnId,
        call_id: callId,
        itemId: item.id,
        status: "inProgress",
        changes: item.changes,
      }));
    }
  }

  const activityMessage = genericToolActivityMessage(toolName);
  if (!activityMessage) {
    return notifications;
  }

  return [
    ...notifications,
    createNotification("codex/event/background_event", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      message: activityMessage,
    }),
  ];
}

function patchApplyEndNotifications(state, payload) {
  const turnId = resolveRolloutEventTurnId(state, payload);
  const callId = readString(payload.call_id) || readString(payload.callId);
  if (!turnId || !callId || state.emittedPatchApplyEndCalls.has(callId)) {
    return [];
  }

  const fileChangeItem = state.applyPatchCalls.get(callId);
  const changes = Array.isArray(payload.changes)
    ? payload.changes
    : fileChangeItem?.changes || [];
  if (changes.length === 0) {
    return [];
  }

  state.emittedPatchApplyEndCalls.add(callId);
  return [
    ...ensureThinkingNotifications(state),
    createNotification("codex/event/patch_apply_end", {
      threadId: state.threadId,
      turnId,
      id: turnId,
      call_id: callId,
      itemId: fileChangeItem?.id || callId,
      status: readString(payload.status) || fileChangeItem?.status || "completed",
      success: payload.success !== false,
      changes,
    }),
  ];
}

function turnFileChangeSnapshotNotifications(state, turnId) {
  const patchEntries = Array.from(state.applyPatchCalls.entries());
  if (!turnId || patchEntries.length === 0) {
    return [];
  }

  const changes = patchEntries.flatMap(([, item]) => Array.isArray(item?.changes) ? item.changes : []);
  if (changes.length === 0) {
    return [];
  }

  const [lastCallId, lastItem] = patchEntries[patchEntries.length - 1];
  const itemId = readString(lastItem?.id) || readString(lastCallId) || buildSyntheticItemId("file-change", state.threadId, turnId);
  return [
    createNotification("codex/event/patch_apply_end", {
      threadId: state.threadId,
      turnId,
      id: turnId,
      call_id: itemId,
      itemId,
      status: "completed",
      success: true,
      changes,
    }),
  ];
}

function toolOutputNotifications(state, payload) {
  if (!state.activeTurnId) {
    return [];
  }

  const callId = readString(payload.call_id) || readString(payload.callId);
  if (!callId) {
    return [];
  }

  const toolCall = state.commandCalls.get(callId);
  if (!toolCall) {
    return [];
  }

  if (!isCommandToolName(toolCall.toolName)) {
    state.commandCalls.delete(callId);
    return [];
  }

  const output = readString(payload.output);
  const notifications = [...ensureThinkingNotifications(state)];
  if (output) {
    notifications.push(createNotification("codex/event/exec_command_output_delta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      command: toolCall.command,
      cwd: toolCall.cwd || "",
      chunk: output,
    }));
  }

  notifications.push(createNotification("codex/event/exec_command_end", {
    threadId: state.threadId,
    turnId: state.activeTurnId,
    call_id: callId,
    command: toolCall.command,
    cwd: toolCall.cwd || "",
    status: "completed",
    output: output || "",
  }));
  state.commandCalls.delete(callId);
  return notifications;
}

function imageGenerationNotifications(state, payload, { preferCallId = false } = {}) {
  if (!state.activeTurnId) {
    return [];
  }

  const callId = preferCallId
    ? firstNonEmptyString([
        readString(payload.call_id),
        readString(payload.callId),
        readString(payload.itemId),
        readString(payload.item_id),
        readString(payload.id),
      ])
    : firstNonEmptyString([
        readString(payload.id),
        readString(payload.call_id),
        readString(payload.callId),
        readString(payload.itemId),
        readString(payload.item_id),
      ]);
  if (!callId) {
    return [];
  }

  const imagePath = firstNonEmptyString([
    readString(payload.saved_path),
    readString(payload.savedPath),
    readString(payload.file_path),
    readString(payload.path),
  ]) || generatedImagePathForRolloutItem(state.threadId, callId);
  if (!imagePath) {
    return [];
  }

  return [
    ...ensureThinkingNotifications(state),
    createNotification("codex/event/image_generation_end", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      itemId: callId,
      saved_path: imagePath,
      file_path: imagePath,
      path: imagePath,
    }),
  ];
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

// When the active turn id was synthesized, ignore any (absent) explicit turn id
// on later events and keep them attached to the synthetic run.
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
  createRolloutLiveMirrorController,
  isDesktopRolloutOrigin,
};
