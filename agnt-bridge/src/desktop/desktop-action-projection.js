// FILE: desktop-action-projection.js
// Purpose: Projects Desktop IPC actions and assistant text growth into app-server-style notifications.
// Layer: CLI helper
// Exports: projectPendingDesktopActions, projectDesktopAssistantDeltaNotifications
// Depends on: ./desktop-ipc-shared

const {
  normalizeToken,
  readString,
  requestIdKey,
} = require("./desktop-ipc-shared");

const DESKTOP_IPC_ACTION_SOURCE = "desktop-ipc-action-follower";
const ACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/fileRead/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

function projectPendingDesktopActions(threadId, conversationState) {
  const requests = Array.isArray(conversationState?.requests) ? conversationState.requests : [];
  return requests
    .filter((request) => request && request.completed !== true)
    .filter((request) => ACTION_METHODS.has(readString(request.method)))
    .map((request) => projectPendingDesktopAction(threadId, request))
    .filter(Boolean);
}

// Desktop IPC exposes full conversation snapshots/patches, not app-server assistant delta events.
// Mirror only suffix growth for assistant rows so phones can render the same live text progression.
function projectDesktopAssistantDeltaNotifications(
  threadId,
  previousState,
  nextState,
  previousTexts = snapshotAssistantMessageTexts(previousState)
) {
  const nextMessages = collectAssistantMessages(nextState);
  const notifications = [];

  for (const message of nextMessages) {
    const previousText = previousTexts.get(message.key) || "";
    if (!message.text || !message.text.startsWith(previousText) || message.text.length <= previousText.length) {
      continue;
    }

    const delta = message.text.slice(previousText.length);
    notifications.push({
      method: "item/agentMessage/delta",
      params: {
        threadId,
        turnId: message.turnId,
        itemId: message.itemId,
        delta,
      },
    });
  }

  return notifications;
}

function snapshotAssistantMessageTexts(conversationState) {
  return new Map(collectAssistantMessages(conversationState).map((message) => [message.key, message.text]));
}

function collectAssistantMessages(conversationState) {
  const turns = Array.isArray(conversationState?.turns) ? conversationState.turns : [];
  const messages = [];
  for (const turn of turns) {
    const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (!isAssistantMessageItem(item)) {
        continue;
      }

      const itemId = readString(item?.id) || readString(item?.itemId) || readString(item?.item_id);
      const text = assistantMessageText(item);
      if (!turnId || !itemId) {
        continue;
      }

      messages.push({
        key: `${turnId}:${itemId}`,
        turnId,
        itemId,
        text,
      });
    }
  }
  return messages;
}

function isAssistantMessageItem(item) {
  const type = normalizeToken(item?.type);
  if (type === "agentmessage" || type === "assistantmessage") {
    return true;
  }
  return type === "message" && normalizeToken(item?.role) === "assistant";
}

function assistantMessageText(item) {
  const directText = readString(item?.text) || readString(item?.message);
  if (directText) {
    return directText;
  }

  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((entry) => entry && typeof entry === "object" ? entry : null)
    .filter(Boolean)
    .map((entry) => readString(entry.text) || readString(entry?.data?.text))
    .filter(Boolean)
    .join("");
}

function projectPendingDesktopAction(threadId, request) {
  const requestId = requestIdKey(request.id);
  const method = readString(request.method);
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params
    : {};
  if (!requestId || !method) {
    return null;
  }

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (questions.length === 0) {
      return null;
    }
  }

  return {
    id: requestId,
    method,
    params: {
      ...params,
      agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      threadId: readString(params.threadId) || readString(params.thread_id) || threadId,
    },
  };
}

module.exports = {
  projectDesktopAssistantDeltaNotifications,
  projectPendingDesktopActions,
};
