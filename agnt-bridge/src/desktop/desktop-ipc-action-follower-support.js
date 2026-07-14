// FILE: desktop-ipc-action-follower-support.js
// Purpose: Pure helpers for Desktop IPC action follower state projection and replies.
// Layer: CLI helper
// Depends on: ./desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
  readString,
  requestIdKey,
} = require("./desktop-ipc-shared");
const {
  activeCanonicalTurnsById,
  applyConversationStateChange,
  backgroundHistoryTurns,
  backgroundRawTurn,
  backgroundRawTurnById,
  canonicalTurnById,
  createEmptyConversationState,
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
  isPatchChange,
  isSnapshotChange,
  latestActiveBackgroundTurn,
  normalizeBoundedTurnsForRuntime,
  seedConversationStateFromThreadRead,
} = require("./action-follower/state");

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

function buildDesktopFollowerRoute(message) {
  const requestId = requestIdKey(message?.id);
  if (!requestId) {
    return null;
  }
  const method = readString(message?.method);
  const params = message?.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params
    : {};
  const threadId = readThreadId(params);
  if (!threadId) {
    return null;
  }

  if (method === "turn/start") {
    return {
      threadId,
      method: "thread-follower-start-turn",
      params: {
        conversationId: threadId,
        senderRequestId: requestId,
        turnStartParams: params,
      },
    };
  }
  if (method === "turn/steer") {
    return {
      threadId,
      method: "thread-follower-steer-turn",
      params: {
        conversationId: threadId,
        input: Array.isArray(params.input) ? params.input : [],
        expectedTurnId: readString(params.expectedTurnId) || readString(params.expected_turn_id),
      },
    };
  }
  if (method === "turn/interrupt") {
    return {
      threadId,
      method: "thread-follower-interrupt-turn",
      params: {
        conversationId: threadId,
        turnId: readString(params.turnId) || readString(params.turn_id),
      },
    };
  }
  if (method === "thread/compact/start") {
    return {
      threadId,
      method: "thread-follower-compact-thread",
      params: {
        conversationId: threadId,
      },
    };
  }

  return null;
}

function appServerResultForFollowerRequest(method, result) {
  if (method === "thread-follower-start-turn"
    && result
    && typeof result === "object"
    && !Array.isArray(result)
    && Object.prototype.hasOwnProperty.call(result, "result")) {
    return result.result ?? null;
  }
  return result ?? null;
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

function readThreadId(params) {
  return readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.conversationId)
    || readString(params?.conversation_id);
}

module.exports = {
  DESKTOP_IPC_ACTION_SOURCE,
  activeCanonicalTurnsById,
  appServerResultForFollowerRequest,
  applyConversationStateChange,
  backgroundHistoryTurns,
  backgroundRawTurn,
  backgroundRawTurnById,
  backgroundTurnLifecycleNotification,
  canonicalTurnById,
  buildDesktopFollowerRoute,
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
