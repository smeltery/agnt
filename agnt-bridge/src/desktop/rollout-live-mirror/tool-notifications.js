// FILE: rollout-live-mirror-tool-notifications.js
// Purpose: Builds rollout live-mirror notifications for tools, patch changes, commands, and images.
// Layer: CLI helper
// Depends on: ./apply-patch-changes, ./rollout-live-mirror-utils, ../../providers/codex/codex-tool-wrapper

const { buildApplyPatchFileChangeItem } = require("../apply-patch-changes");
const {
  expandExecWrapperToolCall,
  isOrchestrationWaitCall,
} = require("../../providers/codex/codex-tool-wrapper");
const {
  buildSyntheticItemId,
  createNotification,
  firstNonEmptyString,
  generatedImagePathForRolloutItem,
  genericToolActivityMessage,
  genericToolCompletionMessage,
  isCommandToolName,
  isInternalProgressPlanToolName,
  normalizeRolloutItemType,
  parseToolArguments,
  readString,
  resolveToolCommand,
  resolveToolWorkingDirectory,
} = require("../rollout-live-mirror-utils");

// Codex's `exec` tool wraps one or more real tool calls in an opaque
// JavaScript sandbox call, and orchestration-only "wait" calls poll an
// internal cell with no user-relevant progress. Unwrap the former into its
// nested calls and drop the latter before dispatching to the normal
// tool/customTool start handlers below.
function projectedToolStartNotifications(state, payload, helpers) {
  if (isOrchestrationWaitCall(payload)) {
    return [];
  }

  const projectedPayloads = expandExecWrapperToolCall(payload);
  const outerCallId = projectedPayloads[0]?.wrappedExecCallId;
  if (outerCallId && projectedPayloads.length > 1) {
    state.wrappedExecCallIdsByOuterId.set(
      outerCallId,
      projectedPayloads.map((projectedPayload) => (
        readString(projectedPayload.call_id) || readString(projectedPayload.callId)
      )).filter(Boolean)
    );
  }

  return projectedPayloads.flatMap((projectedPayload) => (
    normalizeRolloutItemType(projectedPayload.type) === "customtoolcall"
      ? customToolStartNotifications(state, projectedPayload, helpers)
      : toolStartNotifications(state, projectedPayload, helpers)
  ));
}

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
    wrappedExecCall: Boolean(payload.wrappedExecCallId),
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
      itemId: callId,
      status: "inProgress",
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
  } else if (!isCommandToolName(toolName) && !state.applyPatchCalls.has(callId)) {
    state.commandCalls.set(callId, {
      toolName,
      command: toolName,
      cwd: readString(state.sessionMeta?.cwd) || "",
      wrappedExecCall: Boolean(payload.wrappedExecCallId),
    });
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
      ...(!state.applyPatchCalls.has(callId) ? {
        itemId: callId,
        status: "inProgress",
      } : {}),
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

  // An exec wrapper's single output covers every nested call it kicked off.
  // Fan it back out so each nested call still gets its own completion
  // notification; only the recipient tool call keeps the real output text.
  const wrappedCallIds = state.wrappedExecCallIdsByOuterId.get(callId);
  if (Array.isArray(wrappedCallIds) && wrappedCallIds.length > 0) {
    state.wrappedExecCallIdsByOuterId.delete(callId);
    const outputRecipientId = wrappedCallIds.find((nestedCallId) => (
      isCommandToolName(state.commandCalls.get(nestedCallId)?.toolName)
    )) || wrappedCallIds[0];
    return wrappedCallIds.flatMap((nestedCallId) => toolOutputNotifications(state, {
      ...payload,
      call_id: nestedCallId,
      callId: nestedCallId,
      output: nestedCallId === outputRecipientId ? payload.output : "",
    }, helpers));
  }

  const toolCall = state.commandCalls.get(callId);
  if (!toolCall) {
    // A nested apply_patch call has no separate patch_apply_end event (that
    // event only exists for top-level calls), so its projected output is the
    // only signal that the patch finished.
    if (state.applyPatchCalls.has(callId)) {
      return patchApplyEndNotifications(state, {
        ...payload,
        status: readString(payload.status) || "completed",
      }, helpers);
    }
    return [];
  }

  if (!isCommandToolName(toolCall.toolName)) {
    const notifications = [...helpers.ensureThinkingNotifications(state)];
    notifications.push(createNotification("codex/event/background_event", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      itemId: callId,
      status: "completed",
      message: genericToolCompletionMessage(toolCall.toolName),
    }));
    state.commandCalls.delete(callId);
    return notifications;
  }

  const rawOutput = extractToolOutputText(payload.output);
  const output = toolCall.wrappedExecCall ? stripExecOutputEnvelope(rawOutput) : rawOutput;
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

function extractToolOutputText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractToolOutputText).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  for (const key of ["text", "output_text", "outputText"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  for (const key of ["content", "output", "result"]) {
    const text = extractToolOutputText(value[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

// The exec wrapper's runtime prefixes real command output with its own
// script/timing preamble; strip it so the mirrored command output matches
// what a native exec_command call would have produced.
function stripExecOutputEnvelope(output) {
  return readString(output).replace(
    /^Script [^\n]*\nWall time [^\n]*\nOutput:\n?/,
    ""
  );
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
  projectedToolStartNotifications,
  toolOutputNotifications,
  toolStartNotifications,
  turnFileChangeSnapshotNotifications,
};
