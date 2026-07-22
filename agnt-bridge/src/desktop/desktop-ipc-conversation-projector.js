// FILE: desktop-ipc-conversation-projector.js
// Purpose: Projects Codex Desktop IPC conversation snapshots into app-server-style live notifications.
// Layer: CLI helper
// Exports: createDesktopConversationProjector, projectDesktopConversationStateToGoal, projectDesktopConversationStateToThread
// Depends on: ./desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("./desktop-ipc-shared");
const {
  activeTurnIdFromTurns,
  isActiveTurnStatus,
  normalizeTurnStatus,
  resolveThreadStatus,
} = require("./desktop-ipc-projection-status");
const {
  SKIPPED_ITEM,
  desktopTurnsShareLogicalIdentity,
  hasSynthesizedTurnIds,
  isSupportedItemType,
  matchDesktopTurnIdentityContinuities,
  projectItemForMobile,
  sameUserInput,
  sameVisibleUserText,
  sanitizeUserInputEntries,
  threadPreview,
} = require("./conversation-projector/items");
const {
  bootstrapNotifications,
  diffProjections,
  threadStartedNotification,
  turnStartedNotification,
} = require("./conversation-projector/notifications");

// --- Projector lifecycle --------------------------------------

// Caches the previous projected Desktop state so raw IPC snapshots/patches become granular mobile events.
function createDesktopConversationProjector({
  now = () => Date.now(),
  maxCacheSize = 64,
} = {}) {
  const cacheByThreadId = new Map();
  // Threads whose cache was evicted for size were already mirrored to the phone;
  // re-seeding them as a baseline avoids replaying their whole history again.
  const evictedThreadIds = new Set();
  // The follower applies IPC patches copy-on-write, so raw turn/item objects
  // keep their identity while untouched. Memoizing projections on that identity
  // makes each diff cost O(changed turns) instead of O(whole conversation).
  const projectedTurnsByRawTurn = new WeakMap();
  const projectedItemsByRawItem = new WeakMap();

  function projectState(threadId, rawState) {
    return projectConversationState(threadId, rawState, {
      now,
      turnCache: projectedTurnsByRawTurn,
      itemCache: projectedItemsByRawItem,
    });
  }

  function project(threadId, rawState, { includeAllActiveTurns = false } = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !rawState || typeof rawState !== "object") {
      return {
        type: "none",
        notifications: [],
      };
    }

    const nextProjection = projectState(normalizedThreadId, rawState);
    const previousCache = cacheByThreadId.get(normalizedThreadId) || null;
    const previousProjection = previousCache?.projection || null;
    const continuityMatches = previousProjection
      ? matchDesktopTurnIdentityContinuities(previousProjection.turns, nextProjection.turns)
      : { previousTurnIds: new Set(), nextTurnIds: new Set() };
    const hasSyntheticAliasRepair = continuityMatches.nextTurnIds.size > 0;
    const requiresSyntheticFullReplace = previousProjection
      && hasSynthesizedTurnIds(previousProjection)
      && (!hasSynthesizedTurnIds(nextProjection) || hasSyntheticAliasRepair);

    let notifications;
    let type = "events";
    let turnIdentityContinuityTurnIds = [];
    if (!previousProjection && evictedThreadIds.has(normalizedThreadId)) {
      // Previously mirrored but evicted: reseed silently so the phone does not
      // receive a duplicate bootstrap replay of already-delivered history.
      evictedThreadIds.delete(normalizedThreadId);
      type = "baseline";
      notifications = [];
    } else if (!previousProjection) {
      notifications = bootstrapNotifications(normalizedThreadId, nextProjection, {
        includeAllActiveTurns,
      });
    } else if (requiresSyntheticFullReplace) {
      type = "fullReplace";
      const unchangedActiveTurnIDs = nextProjection.turns.flatMap((turn) => (
        isActiveTurnStatus(turn.status)
          && previousProjection.turns.some((previousTurn) => previousTurn.id === turn.id)
          ? [turn.id]
          : []
      ));
      turnIdentityContinuityTurnIds = [
        ...continuityMatches.nextTurnIds,
        ...unchangedActiveTurnIDs.filter((turnID) => !continuityMatches.nextTurnIds.has(turnID)),
      ];
      notifications = [
        threadStartedNotification(nextProjection.thread),
        ...bootstrapNotifications(normalizedThreadId, nextProjection, {
          includeThreadStarted: false,
          includeAllActiveTurns: true,
        }),
      ];
    } else {
      notifications = diffProjections(
        normalizedThreadId,
        previousProjection,
        nextProjection
      );
      const parallelRestorationTurnId = remainingParallelTurnRestorationId(
        previousProjection.turns,
        nextProjection.turns,
        notifications
      );
      if (parallelRestorationTurnId) {
        const restorationTurn = nextProjection.turns.find((turn) => turn.id === parallelRestorationTurnId);
        if (restorationTurn) {
          notifications.push(turnStartedNotification(normalizedThreadId, restorationTurn));
          turnIdentityContinuityTurnIds.push(parallelRestorationTurnId);
        }
      }
    }

    cacheByThreadId.set(normalizedThreadId, {
      projection: nextProjection,
      lastUpdated: now(),
    });
    evictOldest();

    return {
      type,
      notifications,
      thread: nextProjection.thread,
      turnIdentityContinuityTurnIds,
    };
  }

  // Seeds a baseline without replaying old history; subsequent IPC changes diff against it.
  function seed(threadId, rawState) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !rawState || typeof rawState !== "object") {
      return;
    }
    const projection = projectState(normalizedThreadId, rawState);
    cacheByThreadId.set(normalizedThreadId, {
      projection,
      lastUpdated: now(),
    });
    evictOldest();
  }

  function remove(threadId) {
    const normalizedThreadId = readString(threadId);
    cacheByThreadId.delete(normalizedThreadId);
    // Explicit removals are semantic (archive, ownership change): a later
    // re-follow of this thread should bootstrap fresh, not stay silent.
    evictedThreadIds.delete(normalizedThreadId);
  }

  function reset() {
    cacheByThreadId.clear();
    evictedThreadIds.clear();
  }

  function evictOldest() {
    while (cacheByThreadId.size > maxCacheSize) {
      const oldest = Array.from(cacheByThreadId.entries())
        .sort((left, right) => left[1].lastUpdated - right[1].lastUpdated)[0];
      if (!oldest) {
        return;
      }
      cacheByThreadId.delete(oldest[0]);
      evictedThreadIds.add(oldest[0]);
    }
  }

  return {
    project,
    seed,
    remove,
    reset,
  };
}

function remainingParallelTurnRestorationId(previousTurns, nextTurns, notifications) {
  const completedTurnIds = new Set(notifications
    .filter((notification) => notification.method === "turn/completed")
    .map((notification) => readString(notification.params?.turnId))
    .filter(Boolean));
  const startedTurnIds = new Set(notifications
    .filter((notification) => notification.method === "turn/started")
    .map((notification) => readString(notification.params?.turnId))
    .filter(Boolean));
  const previousVisibleTurn = [...previousTurns]
    .filter((turn) => isActiveTurnStatus(turn.status))
    .at(-1);
  if (!previousVisibleTurn || !completedTurnIds.has(previousVisibleTurn.id)) {
    return "";
  }
  const nextVisibleTurn = [...nextTurns]
    .filter((turn) => isActiveTurnStatus(turn.status))
    .at(-1);
  if (!nextVisibleTurn
    || !previousTurns.some((turn) => turn.id === nextVisibleTurn.id)
    || startedTurnIds.has(nextVisibleTurn.id)) {
    return "";
  }
  return nextVisibleTurn.id;
}

// --- Projection model ------------------------------------------

// Converts Desktop's raw conversationState JSON into the thread shape mobile history already parses.
function projectDesktopConversationStateToThread(threadId, rawState, { now = () => Date.now() } = {}) {
  return projectConversationState(threadId, rawState, { now }).thread;
}

function projectDesktopConversationStateToGoal(threadId, rawState) {
  return latestThreadGoal(rawState, threadId);
}

function projectConversationState(threadId, rawState, {
  now = () => Date.now(),
  turnCache = null,
  itemCache = null,
} = {}) {
  const turns = projectTurns(threadId, rawState, { turnCache, itemCache });
  const activeTurnId = activeTurnIdFromTurns(turns);
  const runtimeSettings = rawState?.agntRuntimeSettings || rawState?.agnt_runtime_settings || null;
  const thread = {
    id: threadId,
    sessionId: threadId,
    session_id: threadId,
    title: readString(rawState?.title) || null,
    name: readString(rawState?.title) || null,
    preview: threadPreview(turns),
    createdAt: normalizeTimestamp(rawState?.createdAt ?? rawState?.created_at) || now(),
    updatedAt: normalizeTimestamp(rawState?.updatedAt ?? rawState?.updated_at) || now(),
    cwd: readString(rawState?.cwd) || readString(rawState?.current_working_directory) || "",
    path: readString(rawState?.rolloutPath) || readString(rawState?.rollout_path) || null,
    modelProvider: readString(rawState?.modelProvider) || readString(rawState?.model_provider) || "",
    model: readString(runtimeSettings?.model)
      || readString(rawState?.latestModel)
      || readString(rawState?.latest_model)
      || "",
    reasoningEffort: readString(runtimeSettings?.reasoningEffort) || null,
    serviceTier: readString(runtimeSettings?.serviceTier) || null,
    runtimeSettingsRevision: Number(runtimeSettings?.revision) || 0,
    runtimeSettingsUpdatedAt: Number(runtimeSettings?.updatedAt) || 0,
    runtimeSettingsSource: readString(runtimeSettings?.source) || null,
    cliVersion: readString(rawState?.cliVersion) || readString(rawState?.cli_version) || "",
    source: rawState?.source ?? null,
    gitInfo: cloneJSON(rawState?.gitInfo ?? rawState?.git_info ?? null),
    agentNickname: readString(rawState?.agentNickname) || readString(rawState?.agent_nickname) || null,
    agentRole: readString(rawState?.agentRole) || readString(rawState?.agent_role) || null,
    status: resolveThreadStatus(rawState, activeTurnId),
    tokenUsage: cloneJSON(rawState?.latestTokenUsageInfo ?? rawState?.latest_token_usage_info ?? null),
    turns,
  };

  return {
    thread,
    turns,
    activeTurnId,
    status: thread.status,
  };
}

function projectTurns(threadId, rawState, { turnCache = null, itemCache = null } = {}) {
  const rawTurns = Array.isArray(rawState?.turns) ? rawState.turns : [];
  return rawTurns
    .map((turn, index) => projectTurnCached(threadId, turn, index, { turnCache, itemCache }))
    .filter(Boolean);
}

function projectTurnCached(threadId, rawTurn, index, { turnCache = null, itemCache = null } = {}) {
  if (!rawTurn || typeof rawTurn !== "object") {
    return null;
  }
  // Synthetic ids depend on the array index, so only turns with a real id are
  // safe to reuse by identity.
  const hasStableId = Boolean(readString(rawTurn.turnId) || readString(rawTurn.turn_id) || readString(rawTurn.id));
  if (!turnCache || !hasStableId) {
    return projectTurn(threadId, rawTurn, index, { itemCache });
  }
  const cached = turnCache.get(rawTurn);
  if (cached) {
    return cached;
  }
  const projected = projectTurn(threadId, rawTurn, index, { itemCache });
  if (projected) {
    turnCache.set(rawTurn, projected);
  }
  return projected;
}

function projectTurn(threadId, rawTurn, index, { itemCache = null } = {}) {
  if (!rawTurn || typeof rawTurn !== "object") {
    return null;
  }
  const turnId = readString(rawTurn.turnId)
    || readString(rawTurn.turn_id)
    || readString(rawTurn.id)
    || `ipc-turn-${index}`;
  const status = normalizeTurnStatus(rawTurn.status);
  const paramsInput = Array.isArray(rawTurn?.params?.input) ? cloneJSON(rawTurn.params.input) : [];
  const visibleInput = sanitizeUserInputEntries(paramsInput);
  const items = [];
  if (visibleInput.length > 0) {
    items.push({
      id: `${turnId}:input`,
      type: "userMessage",
      content: visibleInput,
    });
  }

  for (const item of Array.isArray(rawTurn.items) ? rawTurn.items : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemType = normalizeToken(item.type);
    if (!isSupportedItemType(itemType)) {
      continue;
    }
    // Desktop stores the prompt both in turn params and as a canonical
    // userMessage item, often with different entry shapes (extra fields,
    // wrapper text). Matching on the sanitized visible text instead of raw
    // JSON equality keeps one user row; the strict shape check alone let the
    // same prompt through twice and duplicated it on the phone via history.
    if (itemType === "usermessage"
      && visibleInput.length > 0
      && (sameUserInput(item.content, paramsInput)
        || sameVisibleUserText(item.content, visibleInput))) {
      continue;
    }
    // Projected items are treated as immutable by every consumer, so raw items
    // that survived copy-on-write untouched can reuse their previous clone.
    const cachedItem = itemCache?.get(item);
    if (cachedItem) {
      if (cachedItem !== SKIPPED_ITEM) {
        items.push(cachedItem);
      }
      continue;
    }
    const projectedItem = projectItemForMobile(item, itemType);
    itemCache?.set(item, projectedItem ?? SKIPPED_ITEM);
    if (projectedItem) {
      items.push(projectedItem);
    }
  }

  return {
    id: turnId,
    turnId,
    status,
    error: cloneJSON(rawTurn.error || null),
    startedAt: rawTurn.startedAt ?? rawTurn.started_at ?? null,
    completedAt: rawTurn.completedAt ?? rawTurn.completed_at ?? null,
    durationMs: rawTurn.durationMs ?? rawTurn.duration_ms ?? null,
    items,
  };
}

// --- Notification generation ----------------------------------

// --- Shape helpers --------------------------------------------

function findTurn(turns, turnId) {
  return turns.find((turn) => turn.id === turnId) || null;
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function latestThreadGoal(rawState, threadId) {
  const candidates = [rawState?.threadGoal, rawState?.completedThreadGoal]
    .map((goal) => normalizeProjectedThreadGoal(goal, threadId))
    .filter(Boolean);
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
}

function normalizeProjectedThreadGoal(value, fallbackThreadId) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const statusByToken = {
    active: "active",
    paused: "paused",
    blocked: "blocked",
    usagelimited: "usageLimited",
    budgetlimited: "budgetLimited",
    complete: "complete",
  };
  const goal = {
    threadId: readString(value.threadId) || readString(value.thread_id) || fallbackThreadId,
    objective: readString(value.objective),
    status: statusByToken[normalizeToken(value.status)] || "",
    tokenBudget: value.tokenBudget ?? value.token_budget ?? null,
    tokensUsed: Number(value.tokensUsed ?? value.tokens_used) || 0,
    timeUsedSeconds: Number(value.timeUsedSeconds ?? value.time_used_seconds) || 0,
    createdAt: Number(value.createdAt ?? value.created_at) || 0,
    updatedAt: Number(value.updatedAt ?? value.updated_at) || 0,
  };
  return goal.threadId && goal.objective && goal.status ? goal : null;
}

module.exports = {
  createDesktopConversationProjector,
  desktopTurnsShareLogicalIdentity,
  matchDesktopTurnIdentityContinuities,
  projectDesktopConversationStateToGoal,
  projectDesktopConversationStateToThread,
};
