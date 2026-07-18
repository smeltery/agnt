// FILE: desktop-ipc-live-owner-utils.js
// Purpose: Provides pure helpers for Desktop IPC live-owner request shaping.
// Layer: CLI helper
// Exports: turn-start normalization and follower payload readers
// Depends on: ./desktop-ipc-shared

const {
  normalizeToken,
  readString,
} = require("./desktop-ipc-shared");

const ALLOWED_TURN_START_PARAM_KEYS = new Set([
  "threadId",
  "input",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "model",
  "serviceTier",
  "effort",
  "summary",
  "personality",
  "outputSchema",
  "collaborationMode",
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
    if (ALLOWED_TURN_START_PARAM_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  if (!Array.isArray(sanitized.input)) {
    sanitized.input = [];
  }
  return sanitized;
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
  return readString(params?.conversationId)
    || readString(params?.conversation_id)
    || readString(params?.threadId)
    || readString(params?.thread_id)
    || readString(params?.turnStartParams?.threadId)
    || readString(params?.turn_start_params?.threadId);
}

module.exports = {
  normalizeInputEntriesForDesktop,
  readConversationIdFromFollowerParams,
  readThreadFromPayload,
  readThreadFromResponse,
  readTurnIdFromResult,
  sanitizeTurnStartParams,
};
