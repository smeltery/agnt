// FILE: desktop-ipc-conversation-adapter.js
// Purpose: Translates app-server JSON-RPC traffic into Codex Desktop's conversationState shape.
// Layer: CLI helper
// Exports: applyAppServerMessageToConversationState, buildConversationStateFromThread, conversation turn/item helpers
// Depends on: ./desktop-ipc-shared, ./conversation-adapter/*

const {
  cloneJSON,
  hasVisiblePlanUpdate,
  isUserRoleItem: isUserMessageItem,
  readString,
  requestIdKey,
} = require("./desktop-ipc-shared");
const {
  adoptInitialPromptUserMessage,
  extractUserText,
  isInitialPromptUserMessageItem,
  normalizeDesktopItemCompatibility,
  sanitizeUserMessageItem,
  turnHasUserMessageItem,
} = require("./conversation-adapter/item-normalization");
const {
  applyPendingTurnStartParams,
  buildConversationStateFromThread,
  buildConversationTurn,
  createEmptyConversationState,
  mergeConversationTurnsFromThread,
  normalizeThreadGoal,
  synchronizeDesktopConversationCompatibility,
  timestampSecondsToMs,
} = require("./conversation-adapter/state-builders");
const {
  applyDeltaNotification,
  isFileChangeLikeItemType,
} = require("./conversation-adapter/delta-notifications");
const {
  readTurnIdFromParams,
  readTurnIdFromTurn,
  resolveTurnForConversation,
  resolveTurnIdForParams,
} = require("./conversation-adapter/turn-resolution");

const LOCAL_HOST_ID = "local";

function applyAppServerMessageToConversationState({
  conversations,
  fallbackTurnIdsByThreadId = null,
  pendingTurnStartParamsByThreadId = null,
  message,
  hostId = LOCAL_HOST_ID,
  now = () => Date.now(),
  shouldOwnThread = () => false,
} = {}) {
  const method = readString(message?.method);
  if (!method) {
    return null;
  }

  if (REQUEST_METHODS_WITH_THREAD.has(method) && message.id != null) {
    const threadId = readThreadIdFromParams(message.params);
    if (!threadId || !shouldOwnThread(threadId)) {
      return null;
    }
    const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
    upsertRequest(conversation, {
      id: message.id,
      method,
      params: cloneJSON(message.params || {}),
    });
    conversation.hasUnreadTurn = true;
    conversation.updatedAt = now();
    return { threadId, changed: true };
  }

  switch (method) {
    case "thread/started": {
      const thread = message.params?.thread;
      const threadId = readString(thread?.id);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const previous = conversations.get(threadId) || null;
      conversations.set(threadId, buildConversationStateFromThread(thread, {
        previous,
        hostId,
        now,
      }));
      return { threadId, changed: true };
    }
    case "thread/name/updated": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      conversation.title = readString(message.params?.threadName)
        || readString(message.params?.thread_name)
        || readString(message.params?.name)
        || readString(message.params?.title)
        || conversation.title;
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "thread/status/changed": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      conversation.threadRuntimeStatus = cloneJSON(message.params?.status || null);
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "thread/tokenUsage/updated": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      conversation.latestTokenUsageInfo = cloneJSON(
        message.params?.tokenUsage || message.params?.usage || null
      );
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "thread/goal/updated": {
      const threadId = readThreadIdFromParams(message.params);
      const goal = normalizeThreadGoal(message.params?.goal, threadId);
      if (!threadId || !shouldOwnThread(threadId) || !goal) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      if (goal.status === "complete") {
        conversation.threadGoal = null;
        conversation.completedThreadGoal = goal;
      } else {
        conversation.threadGoal = goal;
        conversation.completedThreadGoal = null;
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "thread/goal/cleared": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      conversation.threadGoal = null;
      conversation.completedThreadGoal = null;
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "turn/started":
    case "turn/completed": {
      const threadId = readThreadIdFromParams(message.params);
      const turn = message.params?.turn;
      if (!threadId || !shouldOwnThread(threadId) || !turn) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const upsertedTurn = upsertTurn(conversation, resolveTurnForConversation({
        conversation,
        turn,
        method,
        fallbackTurnIdsByThreadId,
        now,
      }), { now });
      if (method === "turn/started") {
        applyPendingTurnStartParams(
          conversation,
          upsertedTurn,
          pendingTurnStartParamsByThreadId,
          fallbackTurnIdsByThreadId
        );
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "turn/diff/updated": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const turn = ensureTurn(conversation, resolveTurnIdForParams({
        conversation,
        params: message.params,
        fallbackTurnIdsByThreadId,
        now,
      }), { now });
      if (turn) {
        turn.diff = readString(message.params?.diff) || "";
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "turn/plan/updated": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const explanation = readString(message.params?.explanation);
      const plan = Array.isArray(message.params?.plan) ? cloneJSON(message.params.plan) : [];
      if (!hasVisiblePlanUpdate(explanation, plan)) {
        return { threadId, changed: false };
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const turn = ensureTurn(conversation, resolveTurnIdForParams({
        conversation,
        params: message.params,
        fallbackTurnIdsByThreadId,
        now,
      }), { now });
      if (turn) {
        upsertItem(turn, {
          id: `todo-list-${message.params?.turnId || now()}`,
          type: "todo-list",
          explanation: explanation || null,
          plan,
        });
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "item/started":
    case "item/completed": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const allowOptimisticFallback = !isFileChangeLikeItemType(message.params?.item?.type);
      const turn = ensureTurn(conversation, resolveTurnIdForParams({
        conversation,
        params: message.params,
        fallbackTurnIdsByThreadId,
        allowOptimisticFallback,
        now,
      }), { now, allowLastTurnFallback: allowOptimisticFallback });
      if (turn && message.params?.item) {
        upsertItem(turn, cloneJSON(message.params.item));
        // Desktop derives its "Worked for Ns" divider from these two marks, not
        // from durationMs, so keep them set on every lifecycle path.
        if (message.params.item.type === "agentMessage") {
          turn.finalAssistantStartedAtMs = turn.finalAssistantStartedAtMs || now();
        }
        if (message.params.item.type && message.params.item.type !== "userMessage") {
          turn.firstTurnWorkItemStartedAtMs = turn.firstTurnWorkItemStartedAtMs || now();
        }
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/fileChange/outputDelta":
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const allowOptimisticFallback = method !== "item/fileChange/outputDelta";
      applyDeltaNotification(conversation, method, message.params || {}, {
        ensureTurn,
        fallbackTurnIdsByThreadId,
        allowOptimisticFallback,
        now,
      });
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "serverRequest/resolved": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const requestId = requestIdKey(message.params?.requestId || message.params?.request_id);
      conversation.requests = conversation.requests.filter((request) => requestIdKey(request.id) !== requestId);
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    case "error": {
      const threadId = readThreadIdFromParams(message.params);
      if (!threadId || !shouldOwnThread(threadId)) {
        return null;
      }
      const conversation = ensureConversationInMap(conversations, threadId, { hostId, now });
      const turn = ensureTurn(conversation, resolveTurnIdForParams({
        conversation,
        params: message.params,
        fallbackTurnIdsByThreadId,
        now,
      }), { now });
      if (turn) {
        turn.items.push({
          id: `error-${now()}`,
          type: "error",
          message: readString(message.params?.error?.message) || "Codex error",
          willRetry: Boolean(message.params?.willRetry),
          errorInfo: message.params?.error?.codexErrorInfo || null,
          additionalDetails: message.params?.error?.additionalDetails || null,
        });
        turn.error = cloneJSON(message.params?.error || null);
      }
      conversation.updatedAt = now();
      return { threadId, changed: true };
    }
    default:
      return null;
  }
}

function ensureConversationInMap(conversations, threadId, options = {}) {
  let conversation = conversations.get(threadId);
  if (!conversation) {
    conversation = createEmptyConversationState(threadId, options);
    conversations.set(threadId, conversation);
  }
  return conversation;
}

function upsertTurn(conversation, turn, { now = () => Date.now() } = {}) {
  const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
  if (!turnId) {
    return null;
  }
  const index = conversation.turns.findIndex((candidate) => (
    readString(candidate?.turnId) || readString(candidate?.id)
  ) === turnId);
  const previousTurn = index >= 0 ? conversation.turns[index] : null;
  const nextTurn = buildConversationTurn(turn, {
    threadId: conversation.id,
    cwd: conversation.cwd,
    previousTurn,
    now,
  });
  if (index >= 0) {
    conversation.turns[index] = nextTurn;
  } else {
    conversation.turns.push(nextTurn);
  }
  return nextTurn;
}

function ensureTurn(conversation, turnId, {
  now = () => Date.now(),
  allowLastTurnFallback = true,
} = {}) {
  const normalizedTurnId = readString(turnId);
  if (!normalizedTurnId) {
    if (!allowLastTurnFallback) {
      return null;
    }
    return conversation.turns[conversation.turns.length - 1] || null;
  }
  let turn = conversation.turns.find((candidate) => (
    readString(candidate?.turnId) || readString(candidate?.id)
  ) === normalizedTurnId);
  if (!turn) {
    turn = buildConversationTurn({
      id: normalizedTurnId,
      status: "inProgress",
      items: [],
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
    }, {
      threadId: conversation.id,
      cwd: conversation.cwd,
      now,
    });
    conversation.turns.push(turn);
  }
  return turn;
}

function upsertItem(turn, item) {
  const itemId = readString(item?.id);
  if (!itemId) {
    return;
  }
  // Injected context (AGENTS.md instructions, environment_context) arrives as
  // user items too; no Codex UI renders it, so it must not reach the stream.
  // Also evict any copy that slipped into the state before this filter existed.
  const index = turn.items.findIndex((candidate) => readString(candidate?.id) === itemId);
  const sanitizedItem = sanitizeUserMessageItem(normalizeDesktopItemCompatibility(item));
  const existingItem = index >= 0
    ? sanitizeUserMessageItem(normalizeDesktopItemCompatibility(turn.items[index]))
    : null;
  if (!sanitizedItem) {
    if (index >= 0) {
      turn.items.splice(index, 1);
    }
    return;
  }
  if (index >= 0) {
    turn.items[index] = {
      ...(existingItem || {}),
      ...cloneJSON(sanitizedItem),
    };
    return;
  }
  // The app-server echoes the initial prompt as a userMessage item; Desktop
  // already renders it from turn.params.input and would label the duplicate as
  // "Steered conversation". Only later user messages are genuine steers.
  if (isUserMessageItem(sanitizedItem) && !turnHasUserMessageItem(turn)) {
    if (isInitialPromptUserMessageItem(turn, sanitizedItem)) {
      return;
    }
    if (!extractUserText(turn?.params?.input) && adoptInitialPromptUserMessage(turn, sanitizedItem)) {
      return;
    }
  }
  turn.items.push(cloneJSON(sanitizedItem));
}

function upsertRequest(conversation, request) {
  const requestId = requestIdKey(request?.id);
  if (!requestId) {
    return;
  }
  const index = conversation.requests.findIndex((candidate) => requestIdKey(candidate?.id) === requestId);
  const nextRequest = cloneJSON({
    id: request.id,
    method: request.method,
    params: request.params || {},
  });
  if (index >= 0) {
    conversation.requests[index] = nextRequest;
  } else {
    conversation.requests.push(nextRequest);
  }
}

function readThreadIdFromParams(params) {
  return readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.conversationId)
    || readString(params?.conversation_id)
    || readString(params?.turn?.threadId)
    || readString(params?.turn?.thread_id)
    || readString(params?.thread?.id);
}

const REQUEST_METHODS_WITH_THREAD = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/fileRead/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/tool/call",
]);

module.exports = {
  LOCAL_HOST_ID,
  REQUEST_METHODS_WITH_THREAD,
  applyAppServerMessageToConversationState,
  applyPendingTurnStartParams,
  buildConversationStateFromThread,
  buildConversationTurn,
  createEmptyConversationState,
  ensureConversationInMap,
  mergeConversationTurnsFromThread,
  readThreadIdFromParams,
  readTurnIdFromParams,
  readTurnIdFromTurn,
  synchronizeDesktopConversationCompatibility,
  timestampSecondsToMs,
  upsertItem,
  upsertTurn,
};
