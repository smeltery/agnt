// FILE: rollout-live-mirror-tool-notifications.js
// Purpose: Builds rollout live-mirror notifications for tools, patch changes, commands, and images.
// Layer: CLI helper
// Depends on: ./apply-patch-changes, ./rollout-live-mirror-utils

const { buildApplyPatchFileChangeItem } = require("../apply-patch-changes");
const {
  buildSyntheticItemId,
  createNotification,
  firstNonEmptyString,
  generatedImagePathForRolloutItem,
  genericToolActivityMessage,
  isCommandToolName,
  isInternalProgressPlanToolName,
  parseToolArguments,
  readString,
  resolveToolCommand,
  resolveToolWorkingDirectory,
} = require("../rollout-live-mirror-utils");

function toolStartNotifications(state, payload, helpers) {
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
      ...helpers.ensureThinkingNotifications(state),
      ...helpers.planUpdateNotifications(state, argumentsObject),
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
      ...helpers.ensureThinkingNotifications(state),
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
    return helpers.ensureThinkingNotifications(state);
  }

  return [
    ...helpers.ensureThinkingNotifications(state),
    createNotification("codex/event/background_event", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      message: activityMessage,
    }),
  ];
}

function customToolStartNotifications(state, payload, helpers) {
  if (!state.activeTurnId) {
    return [];
  }

  const callId = readString(payload.call_id) || readString(payload.callId);
  const toolName = readString(payload.name);
  if (!callId || !toolName) {
    return [];
  }

  const notifications = [...helpers.ensureThinkingNotifications(state)];
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

function patchApplyEndNotifications(state, payload, helpers) {
  const turnId = helpers.resolveRolloutEventTurnId(state, payload);
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
    ...helpers.ensureThinkingNotifications(state),
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

function toolOutputNotifications(state, payload, helpers) {
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
  const notifications = [...helpers.ensureThinkingNotifications(state)];
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

function imageGenerationNotifications(state, payload, helpers, { preferCallId = false } = {}) {
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
    ...helpers.ensureThinkingNotifications(state),
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

module.exports = {
  customToolStartNotifications,
  imageGenerationNotifications,
  patchApplyEndNotifications,
  toolOutputNotifications,
  toolStartNotifications,
  turnFileChangeSnapshotNotifications,
};
