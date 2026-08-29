// FILE: state-builders.js
// Purpose: Builds Codex Desktop conversationState snapshots and turns.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared, ./item-normalization

const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const {
  normalizeDesktopItemCompatibility,
  normalizeTurnInitialPrompt,
  sanitizeUserMessageItem,
} = require("./item-normalization");

function buildConversationStateFromThread(thread, {
  previous = null,
  hostId,
  now = () => Date.now(),
} = {}) {
  const threadId = readString(thread?.id);
  const createdAtMs = timestampSecondsToMs(thread?.createdAt) || previous?.createdAt || now();
  const updatedAtMs = timestampSecondsToMs(thread?.updatedAt) || now();
  const cwd = readString(thread?.cwd) || previous?.cwd || "";
  const latestModel = readString(thread?.model) || readString(thread?.modelProvider) || previous?.latestModel || "";
  const turns = mergeConversationTurnsFromThread(thread?.turns, {
    previousTurns: previous?.turns,
    threadId,
    cwd,
    now,
  });

  return {
    id: threadId,
    hostId,
    turns,
    requests: cloneJSON(previous?.requests || []),
    createdAt: createdAtMs,
    updatedAt: updatedAtMs,
    title: readString(thread?.name) || previous?.title || null,
    latestModel,
    latestReasoningEffort: previous?.latestReasoningEffort || null,
    previousTurnModel: previous?.previousTurnModel || null,
    latestCollaborationMode: previous?.latestCollaborationMode || {
      mode: "default",
      settings: {
        reasoning_effort: null,
        model: latestModel,
        developer_instructions: null,
      },
    },
    hasUnreadTurn: Boolean(previous?.hasUnreadTurn),
    unreadMessageCount: Number.isFinite(previous?.unreadMessageCount) ? previous.unreadMessageCount : 0,
    threadGoal: previous?.threadGoal || null,
    completedThreadGoal: previous?.completedThreadGoal || null,
    threadRuntimeStatus: cloneJSON(thread?.status || previous?.threadRuntimeStatus || null),
    rolloutPath: readString(thread?.path) || previous?.rolloutPath || "",
    cwd,
    gitInfo: cloneJSON(thread?.gitInfo || previous?.gitInfo || null),
    resumeState: "resumed",
    latestTokenUsageInfo: cloneJSON(previous?.latestTokenUsageInfo || null),
    workspaceKind: previous?.workspaceKind || "project",
    workspaceBrowserRoot: previous?.workspaceBrowserRoot || null,
    projectlessOutputDirectory: previous?.projectlessOutputDirectory || null,
    currentPermissions: cloneJSON(previous?.currentPermissions || null),
  };
}

function mergeConversationTurnsFromThread(threadTurns, {
  previousTurns = [],
  threadId = "",
  cwd = "",
  now = () => Date.now(),
} = {}) {
  const previousList = Array.isArray(previousTurns) ? previousTurns : [];
  if (!Array.isArray(threadTurns) || threadTurns.length === 0) {
    return cloneJSON(previousList);
  }

  const mergedById = new Map();
  previousList.forEach((turn, index) => {
    const turnId = readString(turn?.turnId) || readString(turn?.id);
    if (!turnId) {
      return;
    }
    mergedById.set(turnId, {
      turn: cloneJSON(turn),
      order: index,
    });
  });

  threadTurns.forEach((turn, index) => {
    const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
    if (!turnId) {
      return;
    }
    const previous = mergedById.get(turnId);
    const previousTurn = previous?.turn || null;
    mergedById.set(turnId, {
      turn: buildConversationTurn(turn, {
        threadId,
        cwd,
        previousTurn,
        now,
      }),
      order: previous?.order ?? previousList.length + index,
    });
  });

  return Array.from(mergedById.values())
    .sort((left, right) => {
      const leftStartedAt = Number(left.turn?.turnStartedAtMs);
      const rightStartedAt = Number(right.turn?.turnStartedAtMs);
      if (Number.isFinite(leftStartedAt)
        && Number.isFinite(rightStartedAt)
        && leftStartedAt !== rightStartedAt) {
        return leftStartedAt - rightStartedAt;
      }
      return left.order - right.order;
    })
    .map((entry) => entry.turn);
}

function createEmptyConversationState(threadId, {
  hostId,
  now = () => Date.now(),
  cwd = "",
} = {}) {
  const timestamp = now();
  return {
    id: threadId,
    hostId,
    turns: [],
    requests: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    title: null,
    latestModel: "",
    latestReasoningEffort: null,
    previousTurnModel: null,
    latestCollaborationMode: {
      mode: "default",
      settings: {
        reasoning_effort: null,
        model: "",
        developer_instructions: null,
      },
    },
    hasUnreadTurn: false,
    unreadMessageCount: 0,
    threadGoal: null,
    completedThreadGoal: null,
    threadRuntimeStatus: null,
    rolloutPath: "",
    cwd: readString(cwd) || "",
    gitInfo: null,
    resumeState: "resumed",
    latestTokenUsageInfo: null,
    workspaceKind: "project",
    workspaceBrowserRoot: null,
    projectlessOutputDirectory: null,
    currentPermissions: null,
  };
}

function buildConversationTurn(turn, {
  threadId = "",
  cwd = "",
  previousTurn = null,
  now = () => Date.now(),
} = {}) {
  const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
  const params = cloneJSON(previousTurn?.params || {
    threadId,
    input: [],
    cwd: cwd || null,
    approvalPolicy: null,
    approvalsReviewer: null,
    sandboxPolicy: null,
    model: null,
    serviceTier: null,
    effort: null,
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
  });
  const builtTurn = {
    id: turnId,
    turnId,
    params,
    turnStartedAtMs: timestampSecondsToMs(turn?.startedAt) || previousTurn?.turnStartedAtMs || now(),
    durationMs: turn?.durationMs ?? previousTurn?.durationMs ?? null,
    firstTurnWorkItemStartedAtMs: previousTurn?.firstTurnWorkItemStartedAtMs || null,
    finalAssistantStartedAtMs: previousTurn?.finalAssistantStartedAtMs || null,
    status: turn?.status || previousTurn?.status || "inProgress",
    error: cloneJSON(turn?.error || previousTurn?.error || null),
    diff: previousTurn?.diff || null,
    hookRuns: cloneJSON(previousTurn?.hookRuns || []),
    commandExecutionStartedAtMsById: cloneJSON(previousTurn?.commandExecutionStartedAtMsById || {}),
    items: Array.isArray(turn?.items) && turn.items.length > 0
      ? cloneJSON(turn.items)
      : cloneJSON(previousTurn?.items || []),
  };
  builtTurn.items = builtTurn.items
    .map(normalizeDesktopItemCompatibility)
    .map(sanitizeUserMessageItem)
    .filter(Boolean);
  normalizeTurnInitialPrompt(builtTurn);
  return builtTurn;
}

function applyPendingTurnStartParams(
  conversation,
  turn,
  pendingTurnStartParamsByThreadId,
  fallbackTurnIdsByThreadId = null
) {
  if (!turn || !(pendingTurnStartParamsByThreadId instanceof Map)) {
    return;
  }
  const threadId = readString(conversation?.id);
  const queue = threadId ? pendingTurnStartParamsByThreadId.get(threadId) : null;
  const pendingEntry = Array.isArray(queue) ? queue.shift() : null;
  if (Array.isArray(queue) && queue.length === 0) {
    pendingTurnStartParamsByThreadId.delete(threadId);
  }
  if (pendingEntry) {
    pendingEntry.consumed = true;
  }
  releaseConsumedOptimisticFallback(threadId, pendingEntry, fallbackTurnIdsByThreadId);
  const pendingParams = pendingEntry?.params;
  if (!pendingParams) {
    return;
  }

  applyTurnRuntimeMetadata(conversation, pendingParams);

  const input = Array.isArray(pendingParams.input) ? pendingParams.input : [];
  if (input.length === 0) {
    return;
  }

  turn.params = {
    ...turn.params,
    ...cloneJSON(pendingParams),
  };
  normalizeTurnInitialPrompt(turn);
}

function releaseConsumedOptimisticFallback(threadId, pendingEntry, fallbackTurnIdsByThreadId) {
  const consumedOptimisticTurnId = readString(pendingEntry?.optimisticTurnId);
  if (!threadId || !consumedOptimisticTurnId || !(fallbackTurnIdsByThreadId instanceof Map)) {
    return;
  }
  if (readString(fallbackTurnIdsByThreadId.get(threadId)) === consumedOptimisticTurnId) {
    fallbackTurnIdsByThreadId.delete(threadId);
  }
}

function applyTurnRuntimeMetadata(conversation, turnParams) {
  if (!conversation || !turnParams) {
    return;
  }
  const model = readString(turnParams.model);
  const effort = readString(turnParams.effort);
  if (model) {
    conversation.previousTurnModel = conversation.latestModel || null;
    conversation.latestModel = model;
  }
  if (effort) {
    conversation.latestReasoningEffort = effort;
  }
  if (turnParams.collaborationMode && typeof turnParams.collaborationMode === "object") {
    conversation.latestCollaborationMode = cloneJSON(turnParams.collaborationMode);
    return;
  }
  if (!model && !effort) {
    return;
  }
  const settings = conversation.latestCollaborationMode?.settings;
  conversation.latestCollaborationMode = {
    mode: conversation.latestCollaborationMode?.mode || "default",
    settings: {
      ...(settings && typeof settings === "object" ? settings : {
        developer_instructions: null,
      }),
      model: model || settings?.model || "",
      reasoning_effort: effort || settings?.reasoning_effort || null,
    },
  };
}

function timestampSecondsToMs(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

function normalizeThreadGoal(value, fallbackThreadId = "") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const threadId = readString(value.threadId) || readString(value.thread_id) || readString(fallbackThreadId);
  const objective = readString(value.objective);
  const statusByToken = {
    active: "active",
    paused: "paused",
    blocked: "blocked",
    usagelimited: "usageLimited",
    budgetlimited: "budgetLimited",
    complete: "complete",
  };
  const status = statusByToken[normalizeToken(value.status)] || "";
  if (!threadId || !objective || !status) {
    return null;
  }
  return {
    threadId,
    objective,
    status,
    tokenBudget: value.tokenBudget ?? value.token_budget ?? null,
    tokensUsed: Number(value.tokensUsed ?? value.tokens_used) || 0,
    timeUsedSeconds: Number(value.timeUsedSeconds ?? value.time_used_seconds) || 0,
    createdAt: Number(value.createdAt ?? value.created_at) || 0,
    updatedAt: Number(value.updatedAt ?? value.updated_at) || 0,
  };
}

module.exports = {
  applyPendingTurnStartParams,
  buildConversationStateFromThread,
  buildConversationTurn,
  createEmptyConversationState,
  mergeConversationTurnsFromThread,
  normalizeThreadGoal,
  timestampSecondsToMs,
};
