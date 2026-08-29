// FILE: desktop-ipc-live-owner-utils.js
// Purpose: Provides pure helpers for Desktop IPC live-owner request shaping.
// Layer: CLI helper
// Exports: turn-start normalization and follower payload readers
// Depends on: ./desktop-ipc-shared

const {
  normalizeToken,
  readString,
} = require("./desktop-ipc-shared");

// Current app-server TurnStartParams fields. Desktop's adjacent turnStart.context
// is presentation state, not part of this RPC shape, so it stays outside the request.
const APP_SERVER_TURN_START_PARAM_KEYS = new Set([
  "threadId",
  "input",
  "additionalContext",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "model",
  "serviceTier",
  "serviceTierForTurn",
  "effort",
  "summary",
  "personality",
  "outputSchema",
  "collaborationMode",
  "clientUserMessageId",
  "cyberAccessProgram",
  "environments",
  "multiAgentMode",
  "permissions",
  "responsesapiClientMetadata",
  "runtimeWorkspaceRoots",
  "toolOutput",
  "turnTrigger",
]);

function normalizeInputEntriesForDesktop(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (normalizeToken(entry.type) === "imageurl") {
      const url = readString(entry.url)
        || readString(entry.image_url?.url)
        || readString(entry.imageUrl?.url)
        || readString(entry.image_url)
        || readString(entry.imageUrl);
      if (url) {
        return { type: "image", url };
      }
    }
    return entry;
  });
}

function sanitizeTurnStartParams(params) {
  const sanitized = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (APP_SERVER_TURN_START_PARAM_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  if (!Array.isArray(sanitized.input)) {
    sanitized.input = [];
  }
  return sanitized;
}

function readFollowerTurnStartParams(params) {
  const turnStart = params?.turnStart && typeof params.turnStart === "object" && !Array.isArray(params.turnStart)
    ? params.turnStart
    : null;
  if (turnStart?.request && typeof turnStart.request === "object" && !Array.isArray(turnStart.request)) {
    return turnStart.request;
  }
  return params?.turnStartParams
    || params?.turn_start_params
    || params?.turnStart
    || params;
}

function readThreadFromResponse(message) {
  const result = message?.result || message?.payload || {};
  return readThreadFromPayload(result);
}

function readThreadFromPayload(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  return result.thread && typeof result.thread === "object"
    ? result.thread
    : result;
}

function readTurnIdFromResult(result) {
  return readString(result?.turn?.id)
    || readString(result?.turnId)
    || readString(result?.turn_id)
    || readString(result?.id);
}

function readConversationIdFromFollowerParams(params) {
  const turnStartRequest = readFollowerTurnStartParams(params);
  return readString(params?.conversationId)
    || readString(params?.conversation_id)
    || readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.turnStartParams?.threadId)
    || readString(params?.turn_start_params?.threadId)
    || readString(turnStartRequest?.threadId);
}

module.exports = {
  normalizeInputEntriesForDesktop,
  readConversationIdFromFollowerParams,
  readFollowerTurnStartParams,
  readThreadFromPayload,
  readThreadFromResponse,
  readTurnIdFromResult,
  sanitizeTurnStartParams,
};
