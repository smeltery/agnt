// FILE: desktop-ipc-action-follower-support.js
// Purpose: Pure helpers for Desktop IPC action follower state projection and replies.
// Layer: CLI helper
// Depends on: ./desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
  readString,
} = require("./desktop-ipc-shared");

const DESKTOP_IPC_ACTION_SOURCE = "desktop-ipc-action-follower";
const AGNT_LIVE_OWNER_SOURCE = "desktop-ipc-live-owner";
const REPLY_METHOD_BY_ACTION_METHOD = new Map([
  ["item/commandExecution/requestApproval", "thread-follower-command-approval-decision"],
  ["item/fileChange/requestApproval", "thread-follower-file-approval-decision"],
  ["item/fileRead/requestApproval", "thread-follower-file-approval-decision"],
  ["item/permissions/requestApproval", "thread-follower-file-approval-decision"],
  ["item/tool/requestUserInput", "thread-follower-submit-user-input"],
]);
const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

function desktopFollowerPayloadForResponse(route, responseMessage) {
  const method = REPLY_METHOD_BY_ACTION_METHOD.get(route.method);
  if (!method || responseMessage?.error) {
    return null;
  }

  if (route.method === "item/tool/requestUserInput") {
    const answers = responseMessage?.result?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return null;
    }

    return {
      method,
      params: {
        conversationId: route.threadId,
        requestId: route.requestId,
        response: {
          answers,
        },
      },
    };
  }

  const decision = desktopApprovalDecisionForResponse(route.method, responseMessage?.result);
  if (!APPROVAL_DECISIONS.has(decision)) {
    return null;
  }

  return {
    method,
    params: {
      conversationId: route.threadId,
      requestId: route.requestId,
      decision,
    },
  };
}

function desktopApprovalDecisionForResponse(method, result) {
  const explicitDecision = readString(result?.decision);
  if (explicitDecision) {
    return explicitDecision;
  }

  if (method !== "item/permissions/requestApproval") {
    return "";
  }

  // Permission approvals use a grant payload on app-server, while Desktop IPC
  // currently exposes only decision-style follower replies.
  return hasGrantedPermission(result?.permissions) ? "accept" : "decline";
}

function hasGrantedPermission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (Object.keys(value).length === 0) {
    return false;
  }

  return Object.values(value).some((entry) => {
    if (entry == null) {
      return false;
    }
    if (typeof entry === "boolean") {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.length > 0;
    }
    if (typeof entry === "object") {
      return Object.keys(entry).length > 0;
    }
    return true;
  });
}

function applyConversationStateChange(previousState, change) {
  if (!change || typeof change !== "object") {
    return null;
  }

  if (change.type === "snapshot" || change.type === "Snapshot") {
    return cloneJSON(change.conversationState || change.conversation_state || {});
  }

  if (change.type !== "patches" && change.type !== "Patches") {
    return previousState || null;
  }

  const patches = Array.isArray(change.patches) ? change.patches : [];
  if (!previousState || patches.length === 0) {
    return previousState || null;
  }

  // Copy-on-write: clone only the nodes along each patch path and share the
  // rest with the previous state. Besides skipping an O(state) deep clone per
  // broadcast, preserving the identity of untouched turns lets the projector
  // reuse their cached projection instead of re-diffing them.
  let nextState = shallowCloneNode(previousState);
  const clonedNodes = new Set([nextState]);
  for (const patch of patches) {
    if (Array.isArray(patch?.path) && patch.path.length === 0) {
      const op = readString(patch?.op).toLowerCase();
      if (op === "add" || op === "replace") {
        nextState = cloneJSON(patch.value);
        clonedNodes.clear();
        clonedNodes.add(nextState);
        continue;
      }
      return null;
    }
    if (!applyImmerPatchCopyOnWrite(nextState, patch, clonedNodes)) {
      return null;
    }
  }
  return nextState;
}

function shallowCloneNode(value) {
  return Array.isArray(value) ? value.slice() : { ...value };
}

function isPatchChange(change) {
  return change?.type === "patches" || change?.type === "Patches";
}

function isSnapshotChange(change) {
  return change?.type === "snapshot" || change?.type === "Snapshot";
}

function hasNormalizedHistoryOutsideRawTurns(state) {
  const store = normalizedTurnStore(state);
  if (!store) {
    return false;
  }
  const rawTurnIds = new Set((Array.isArray(state?.turns) ? state.turns : [])
    .map((turn) => readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id))
    .filter(Boolean));
  for (const [key, entity] of Object.entries(store.entities)) {
    const turnId = normalizedTurnIdForEntity(key, entity);
    if (turnId && !rawTurnIds.has(turnId)) {
      return true;
    }
  }
  return false;
}

function normalizedTurnStore(state) {
  const turnHistory = state?.turnHistory ?? state?.turn_history;
  const history = turnHistory?.history;
  const entities = history?.entitiesByKey ?? history?.entities_by_key;
  if (!entities || typeof entities !== "object" || Array.isArray(entities)) {
    return null;
  }
  return { history, entities };
}

function normalizedTurnIdForEntity(entityKey, entity) {
  const keyedTurnId = entityKey.startsWith("turn:")
    ? readString(entityKey.slice("turn:".length))
    : "";
  const entityTurnId = readString(entity?.turnId) || readString(entity?.turn_id) || readString(entity?.id);
  const looksLikeTurn = Boolean(keyedTurnId)
    || (Boolean(entityTurnId) && (entity?.status != null || Array.isArray(entity?.items)));
  return looksLikeTurn ? keyedTurnId || entityTurnId : "";
}

function desktopLiveStateForProjection(state) {
  const orderedTurns = backgroundHistoryTurns(state);
  if (!hasNormalizedHistoryOutsideRawTurns(state) || orderedTurns.length <= 1) {
    return {
      ...(state && typeof state === "object" ? state : {}),
      turns: normalizeBoundedTurnsForRuntime(orderedTurns, state),
    };
  }

  const latestTurn = orderedTurns[orderedTurns.length - 1];
  const activeTurns = orderedTurns.filter((turn) => isActiveRawTurn(turn));
  const selectedTurns = activeTurns.length > 0
    ? activeTurns.slice(-2)
    : [latestTurn];
  return {
    ...(state && typeof state === "object" ? state : {}),
    turns: normalizeBoundedTurnsForRuntime(selectedTurns.filter(Boolean), state),
  };
}

function latestActiveBackgroundTurn(state) {
  const turns = normalizeBoundedTurnsForRuntime(backgroundHistoryTurns(state), state);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = backgroundRawTurn(turns[index], index);
    if (turn.status === "inProgress") {
      return turn;
    }
  }
  return null;
}

function backgroundRawTurnById(state, turnId) {
  const turns = normalizeBoundedTurnsForRuntime(backgroundHistoryTurns(state), state);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = backgroundRawTurn(turns[index], index);
    if (turn.id === turnId) {
      return turn;
    }
  }
  return null;
}

function backgroundHistoryTurns(state) {
  const turns = Array.isArray(state?.turns) ? state.turns.filter(Boolean) : [];
  const store = normalizedTurnStore(state);
  if (!store) {
    return turns;
  }

  const rawTurnsById = new Map();
  for (const turn of turns) {
    const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
    if (turnId) {
      rawTurnsById.set(turnId, turn);
    }
  }

  const orderedTurns = [];
  const addedTurnIds = new Set();
  const addedEntityKeys = new Set();
  const appendEntity = (key) => {
    const entityKey = readString(key);
    const entity = store.entities[entityKey];
    if (!entityKey || addedEntityKeys.has(entityKey) || !entity || typeof entity !== "object") {
      return;
    }
    const turnId = normalizedTurnIdForEntity(entityKey, entity);
    if (!turnId || addedTurnIds.has(turnId)) {
      return;
    }
    addedEntityKeys.add(entityKey);
    addedTurnIds.add(turnId);
    orderedTurns.push(rawTurnsById.get(turnId) || entity);
  };

  for (const island of Array.isArray(store.history?.islands) ? store.history.islands : []) {
    for (const entry of Array.isArray(island?.entries) ? island.entries : []) {
      appendEntity(readString(entry?.value) || readString(entry?.key));
    }
  }
  if (orderedTurns.length === 0) {
    for (const key of Object.keys(store.entities)) {
      appendEntity(key);
    }
  }
  for (const turn of turns) {
    const turnId = readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
    if (!turnId || !addedTurnIds.has(turnId)) {
      orderedTurns.push(turn);
    }
  }
  return orderedTurns.length > 0 ? orderedTurns : turns;
}

function normalizeBoundedTurnsForRuntime(turns, state) {
  if (!isExplicitlyIdleDesktopRuntime(state)) {
    return turns;
  }
  return turns.map((turn) => (
    isActiveRawTurn(turn)
      ? { ...turn, status: "completed" }
      : turn
  ));
}

function isExplicitlyIdleDesktopRuntime(state) {
  const status = normalizeToken(
    readString(state?.threadRuntimeStatus?.type)
      || readString(state?.thread_runtime_status?.type)
      || readString(state?.runtimeStatus?.type)
      || readString(state?.runtime_status?.type)
  );
  return status === "idle"
    || status === "inactive"
    || status === "completed"
    || status === "stopped"
    || status === "notrunning";
}

function isActiveRawTurn(turn) {
  const status = normalizeToken(turn?.status);
  return status === "inprogress"
    || status === "running"
    || status === "active"
    || status === "processing";
}

function backgroundRawTurn(turn, index) {
  const id = readString(turn?.turnId)
    || readString(turn?.turn_id)
    || readString(turn?.id)
    || `ipc-turn-${index}`;
  const status = normalizeToken(turn?.status);
  let normalizedStatus = "completed";
  if (status === "inprogress" || status === "running" || status === "active" || status === "processing") {
    normalizedStatus = "inProgress";
  } else if (status === "failed" || status === "error" || status === "systemerror") {
    normalizedStatus = "failed";
  } else if (status === "interrupted" || status === "cancelled" || status === "canceled" || status === "stopped") {
    normalizedStatus = "interrupted";
  }
  return {
    id,
    status: normalizedStatus,
    error: turn?.error ?? null,
  };
}

function backgroundTurnLifecycleNotification(method, threadId, turn) {
  const turnId = readString(turn?.id);
  const params = {
    threadId,
    agntDesktopMirror: true,
    agntDesktopIpcMirror: true,
    agntBackgroundDiscovery: true,
    agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
  };
  if (turnId) {
    params.turnId = turnId;
    params.id = turnId;
  }
  if (method === "turn/completed") {
    params.status = readString(turn?.status) || "completed";
    if (turn?.error != null) {
      params.error = cloneJSON(turn.error);
    }
  }
  return { method, params };
}

function activeCanonicalTurnsById(liveState) {
  const activeTurns = new Map();
  for (const turn of canonicalTurns(liveState)) {
    if (turn.status === "inProgress") {
      activeTurns.set(turn.id, turn);
    }
  }
  return activeTurns;
}

function canonicalTurnById(liveState, turnId) {
  for (const turn of canonicalTurns(liveState)) {
    if (turn.id === turnId) {
      return turn;
    }
  }
  return null;
}

function canonicalTurns(liveState) {
  return normalizeBoundedTurnsForRuntime(backgroundHistoryTurns(liveState), liveState)
    .map((turn, index) => backgroundRawTurn(turn, index))
    .filter((turn) => readString(turn.id));
}

function isagntLiveOwnerBroadcast(params) {
  return readString(params?.agntOwnerSource) === AGNT_LIVE_OWNER_SOURCE;
}

// Resolutions of Desktop-owned prompts are mirror events too; the tags let iOS
// reconcile them without treating them as local runtime work.
function projectedResolvedNotification(threadId, requestId) {
  return {
    method: "serverRequest/resolved",
    params: {
      threadId,
      requestId,
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
    },
  };
}

function isPeerOwnershipSnapshot(params) {
  return !isagntLiveOwnerBroadcast(params) && normalizeToken(params?.change?.type) === "snapshot";
}

function seedConversationStateFromThreadRead(response) {
  const conversationState = response?.conversationState || response?.conversation_state;
  if (conversationState && typeof conversationState === "object" && !Array.isArray(conversationState)) {
    return cloneJSON(conversationState);
  }

  const thread = response?.thread && typeof response.thread === "object" && !Array.isArray(response.thread)
    ? response.thread
    : {};
  return {
    turns: Array.isArray(thread.turns) ? cloneJSON(thread.turns) : [],
    requests: Array.isArray(thread.requests) ? cloneJSON(thread.requests) : [],
  };
}

function createEmptyConversationState() {
  return {
    turns: [],
    requests: [],
  };
}

function applyImmerPatchCopyOnWrite(target, patch, clonedNodes) {
  const patchPath = Array.isArray(patch?.path) ? patch.path : [];
  const op = readString(patch?.op).toLowerCase();
  if (!op || patchPath.length === 0) {
    return false;
  }

  let parent = target;
  for (let index = 0; index < patchPath.length - 1; index += 1) {
    const key = patchPath[index];
    const child = parent?.[key];
    if (child == null || typeof child !== "object") {
      return false;
    }
    if (clonedNodes.has(child)) {
      parent = child;
      continue;
    }
    const clonedChild = shallowCloneNode(child);
    clonedNodes.add(clonedChild);
    parent[key] = clonedChild;
    parent = clonedChild;
  }

  const key = patchPath[patchPath.length - 1];
  if (op === "remove") {
    if (Array.isArray(parent) && Number.isInteger(key)) {
      if (key < 0 || key >= parent.length) {
        return false;
      }
      parent.splice(key, 1);
      return true;
    } else if (parent && typeof parent === "object") {
      if (!Object.prototype.hasOwnProperty.call(parent, key)) {
        return false;
      }
      delete parent[key];
      return true;
    }
    return false;
  }

  if (op === "add" || op === "replace") {
    if (Array.isArray(parent) && Number.isInteger(key)) {
      if (op === "add") {
        if (key < 0 || key > parent.length) {
          return false;
        }
        parent.splice(key, 0, patch.value);
      } else {
        if (key < 0 || key >= parent.length) {
          return false;
        }
        parent[key] = patch.value;
      }
      return true;
    } else if (parent && typeof parent === "object") {
      parent[key] = patch.value;
      return true;
    }
  }
  return false;
}

function readThreadId(params) {
  return readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.conversationId)
    || readString(params?.conversation_id);
}

module.exports = {
  DESKTOP_IPC_ACTION_SOURCE,
  activeCanonicalTurnsById,
  applyConversationStateChange,
  backgroundHistoryTurns,
  backgroundRawTurn,
  backgroundRawTurnById,
  backgroundTurnLifecycleNotification,
  canonicalTurnById,
  createEmptyConversationState,
  desktopFollowerPayloadForResponse,
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
  isPatchChange,
  isPeerOwnershipSnapshot,
  isSnapshotChange,
  isagntLiveOwnerBroadcast,
  latestActiveBackgroundTurn,
  normalizeBoundedTurnsForRuntime,
  projectedResolvedNotification,
  readThreadId,
  seedConversationStateFromThreadRead,
};
