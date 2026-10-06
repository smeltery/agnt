const { APPROVAL_METHODS, USER_INPUT_METHODS } = require("./projector-support");
const { projectDesktopThreadActivity, projectSemanticItem, projectTurnOutcome, runtimeForAppServerState, normalizeRuntime, runtimeActiveFlags, attentionFields, appServerThreadId, turnIdentity, timestampSecondsToMs, finiteNumber, rememberTerminalTurn, rememberAppServerState, hasRunningWork, hasKnownTerminalWork, replaceString, compactEntry, compactObject, sameJSON } = require("./projector-support");
// FILE: thread-activity-projector.js
// Purpose: Reduces observed Codex and Desktop state to bounded Activity metadata.
// Layer: CLI helper
// Exports: createThreadActivityProjector, projectDesktopThreadActivity
// Depends on: ./desktop-ipc-shared

const { normalizeToken, readString } = require("../../desktop/desktop-ipc-shared");

const APP_SERVER_SOURCE = "app-server";
const DESKTOP_IPC_SOURCE = "desktop-ipc";
const APP_SERVER_GENERATION = 1;
const MAX_APP_SERVER_THREADS = 500;

const REMOVAL_METHODS = new Set([
  "thread/archived",
  "thread/deleted",
]);

function createThreadActivityProjector({ maxAppThreads = MAX_APP_SERVER_THREADS } = {}) {
  const appStatesByThreadId = new Map();

  function observeAppServer(message) {
    const method = readString(message?.method);
    const threadId = appServerThreadId(message);
    if (!method || !threadId) {
      return null;
    }
    if (REMOVAL_METHODS.has(method)) {
      appStatesByThreadId.delete(threadId);
      return { removedThreadId: threadId, source: APP_SERVER_SOURCE };
    }

    const state = appStatesByThreadId.get(threadId) || createAppServerState(threadId);
    if (!reduceAppServerMessage(state, message)) {
      return null;
    }
    rememberAppServerState(appStatesByThreadId, state, maxAppThreads);
    return { entry: projectAppServerState(state) };
  }

  function forget(threadId, source) {
    if (source === APP_SERVER_SOURCE) {
      appStatesByThreadId.delete(threadId);
    }
  }

  return {
    forget,
    observeAppServer,
    projectDesktopState(threadId, state, sourceGeneration) {
      return projectDesktopThreadActivity(threadId, state, sourceGeneration);
    },
  };
}

function createAppServerState(threadId) {
  return {
    threadId,
    title: "",
    cwd: "",
    runtimeStatus: "unknown",
    activeFlags: [],
    freshness: "current",
    activeTurnIds: new Set(),
    runningWithoutTurnId: false,
    approvalRequestIds: new Map(),
    userInputRequestIds: new Map(),
    terminalTurnIds: new Set(),
    settledTurnlessWork: false,
    turnOrderById: new Map(),
    turnStartedAtMsById: new Map(),
    fallbackStartedAtMs: null,
    nextTurnOrder: 1,
    lastOutcomeOrder: 0,
    lastOutcome: null,
    latestItem: null,
  };
}

function reduceAppServerMessage(state, message) {
  const method = readString(message.method);
  if (APPROVAL_METHODS.has(method)) {
    return rememberRequest(state, state.approvalRequestIds, message);
  }
  if (USER_INPUT_METHODS.has(method)) {
    return rememberRequest(state, state.userInputRequestIds, message);
  }

  switch (method) {
    case "thread/started":
      return reduceThreadStarted(state, message.params?.thread);
    case "thread/name/updated":
      return replaceTitle(state, message.params);
    case "thread/status/changed":
      return replaceAppServerRuntime(state, message.params?.status);
    case "thread/closed":
      state.freshness = "stale";
      return true;
    case "turn/started":
      return reduceTurnStarted(state, message.params || {});
    case "turn/completed":
      return reduceTurnCompleted(state, message.params || {});
    case "item/started":
    case "item/completed":
      return reduceItemLifecycle(state, message.params || {}, method);
    case "serverRequest/resolved":
      return resolveRequest(state, message.params || {});
    default:
      return false;
  }
}

function reduceThreadStarted(state, thread) {
  if (!thread || typeof thread !== "object") {
    return false;
  }
  let changed = replaceString(state, "title", thread.name || thread.title || thread.preview);
  changed = replaceString(state, "cwd", thread.cwd) || changed;
  changed = replaceAppServerRuntime(state, thread.status) || changed;
  return changed;
}

function replaceTitle(state, params) {
  return replaceString(
    state,
    "title",
    params?.threadName || params?.thread_name || params?.name || params?.title
  );
}

function replaceAppServerRuntime(state, status) {
  const nextRuntime = normalizeRuntime(status);
  if (nextRuntime === "active"
      && hasKnownTerminalWork(state)
      && !hasRunningWork(state)) {
    return false;
  }
  const flags = runtimeActiveFlags(status);
  const changed = state.runtimeStatus !== nextRuntime
    || !sameJSON(state.activeFlags, flags) || state.freshness !== "current";
  state.runtimeStatus = nextRuntime;
  state.activeFlags = flags;
  state.freshness = "current";
  if (nextRuntime === "active" && !hasRunningWork(state)) {
    state.runningWithoutTurnId = true;
    return true;
  }
  return changed;
}

function reduceTurnStarted(state, params) {
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  const turnId = turnIdentity(params, turn);
  if (turnId && state.terminalTurnIds.has(turnId)) {
    return false;
  }

  let changed = false;
  const startedAtMs = timestampSecondsToMs(turn.startedAt ?? turn.started_at);
  if (!hasRunningWork(state)) {
    state.latestItem = null;
  }
  state.freshness = "current";
  if (turnId) {
    if (!state.activeTurnIds.has(turnId)) {
      state.activeTurnIds.add(turnId);
      state.turnOrderById.set(turnId, state.nextTurnOrder);
      state.nextTurnOrder += 1;
      changed = true;
    }
    const canonicalStart = startedAtMs ?? state.fallbackStartedAtMs;
    if (canonicalStart != null && state.turnStartedAtMsById.get(turnId) !== canonicalStart) {
      state.turnStartedAtMsById.set(turnId, canonicalStart);
      changed = true;
    }
    if (state.runningWithoutTurnId) {
      state.runningWithoutTurnId = false;
      state.fallbackStartedAtMs = null;
      changed = true;
    }
  } else if (!state.runningWithoutTurnId) {
    state.runningWithoutTurnId = true;
    changed = true;
  }
  if (!turnId && startedAtMs != null && state.fallbackStartedAtMs !== startedAtMs) {
    state.fallbackStartedAtMs = startedAtMs;
    changed = true;
  }
  if (state.runtimeStatus !== "active") {
    state.runtimeStatus = "active";
    changed = true;
  }
  return changed;
}

function reduceTurnCompleted(state, params) {
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  const turnId = turnIdentity(params, turn);
  if (turnId && state.terminalTurnIds.has(turnId)) {
    return false;
  }
  if (turnId && !state.activeTurnIds.has(turnId) && state.activeTurnIds.size > 0) {
    rememberTerminalTurn(state, turnId);
    return false;
  }
  if (!turnId && !state.runningWithoutTurnId && hasKnownTerminalWork(state)) {
    return false;
  }

  const startedAtMs = state.turnStartedAtMsById.get(turnId) ?? state.fallbackStartedAtMs;
  let changed = settleTurnRuntime(state, turnId);
  changed = settleRequests(state, turnId) || changed;
  state.freshness = "current";
  if (!turnId) {
    state.settledTurnlessWork = true;
    return changed;
  }
  const order = state.turnOrderById.get(turnId) || state.nextTurnOrder++;
  state.turnOrderById.set(turnId, order);
  rememberTerminalTurn(state, turnId);
  if (order < state.lastOutcomeOrder) {
    return changed;
  }
  const nextOutcome = projectTurnOutcome(turnId, turn, params, startedAtMs);
  if (!sameJSON(state.lastOutcome, nextOutcome)) {
    state.lastOutcome = nextOutcome;
    state.lastOutcomeOrder = order;
    changed = true;
  }
  return changed;
}

function settleTurnRuntime(state, turnId) {
  let changed = false;
  if (turnId && state.activeTurnIds.delete(turnId)) {
    changed = true;
  }
  if (state.runningWithoutTurnId && (!turnId || state.activeTurnIds.size === 0)) {
    state.runningWithoutTurnId = false;
    state.fallbackStartedAtMs = null;
    changed = true;
  }
  if (!hasRunningWork(state) && state.runtimeStatus === "active") {
    state.runtimeStatus = "idle";
    changed = true;
  }
  if (!hasRunningWork(state)) {
    state.activeFlags = [];
  }
  return changed;
}

function settleRequests(state, turnId) {
  let changed = false;
  for (const requests of [state.approvalRequestIds, state.userInputRequestIds]) {
    for (const [requestId, requestTurnId] of requests) {
      if ((turnId && requestTurnId === turnId) || !hasRunningWork(state)) {
        requests.delete(requestId);
        changed = true;
      }
    }
  }
  return changed;
}

function reduceItemLifecycle(state, params, method) {
  const item = params.item && typeof params.item === "object" ? params.item : {};
  const turnId = readString(params.turnId) || readString(params.turn_id);
  if (turnId && state.terminalTurnIds.has(turnId)) {
    return false;
  }
  if (!turnId && hasKnownTerminalWork(state) && !hasRunningWork(state)) {
    return false;
  }
  let nextItem = projectSemanticItem(item, {
    turnId,
    lifecycleAtMs: method === "item/started"
      ? finiteNumber(params.startedAtMs ?? params.started_at_ms)
      : finiteNumber(params.completedAtMs ?? params.completed_at_ms),
    lifecycle: method === "item/started" ? "started" : "completed",
  });
  if (method === "item/completed" && state.latestItem && nextItem) {
    if (state.latestItem.itemId !== nextItem.itemId || state.latestItem.turnId !== nextItem.turnId) {
      return false;
    }
    nextItem = { ...state.latestItem, ...nextItem };
  }
  if (!nextItem || sameJSON(state.latestItem, nextItem)) {
    return false;
  }
  state.latestItem = nextItem;
  return true;
}

function rememberRequest(state, requestIds, message) {
  if (message.id == null || requestIds.has(message.id)) {
    return false;
  }
  const turnId = turnIdentity(message.params, message.params?.turn);
  if ((turnId && state.terminalTurnIds.has(turnId))
      || (!turnId && hasKnownTerminalWork(state) && !hasRunningWork(state))) {
    return false;
  }
  requestIds.set(message.id, turnId);
  return true;
}

function resolveRequest(state, params) {
  const requestId = params.requestId ?? params.request_id;
  if (requestId == null) {
    return false;
  }
  const removedApproval = state.approvalRequestIds.delete(requestId);
  const removedUserInput = state.userInputRequestIds.delete(requestId);
  return removedApproval || removedUserInput;
}

function projectAppServerState(state) {
  return compactEntry({
    threadId: state.threadId,
    source: APP_SERVER_SOURCE,
    title: state.title,
    cwd: state.cwd,
    runtime: runtimeForAppServerState(state),
    activeTurnIds: [...state.activeTurnIds],
    runningWithoutTurnId: state.runningWithoutTurnId,
    activeTurns: [...state.activeTurnIds].map((turnId) => compactObject({
      turnId,
      startedAtMs: state.turnStartedAtMsById.get(turnId),
    })),
    runningStartedAtMs: state.runningWithoutTurnId ? state.fallbackStartedAtMs : null,
    ...attentionFields(state.approvalRequestIds.size, state.userInputRequestIds.size, state.activeFlags),
    lastOutcome: state.lastOutcome,
    latestItem: state.latestItem,
    freshness: state.freshness,
    sourceGeneration: APP_SERVER_GENERATION,
  });
}

module.exports = {
  APP_SERVER_SOURCE,
  DESKTOP_IPC_SOURCE,
  createThreadActivityProjector,
  projectDesktopThreadActivity,
  projectSemanticItem,
};
