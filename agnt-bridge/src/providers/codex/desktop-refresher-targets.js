// FILE: providers/codex/desktop-refresher-targets.js
// Purpose: Message target parsing helpers for Codex desktop refreshes.
// Layer: provider plugin (codex)

const NEW_THREAD_DEEP_LINK = "codex://threads/new";

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTurnId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  if (typeof params.turnId === "string" && params.turnId) {
    return params.turnId;
  }

  if (params.turn && typeof params.turn === "object" && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return null;
}

function extractThreadId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  const candidates = [
    params.threadId,
    params.conversationId,
    params.thread?.id,
    params.thread?.threadId,
    params.turn?.threadId,
    params.turn?.conversationId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveInboundTarget(method, message) {
  const threadId = extractThreadId(message);
  if (threadId) {
    return { threadId, url: buildThreadDeepLink(threadId) };
  }

  if (method === "thread/start" || method === "turn/start") {
    return { threadId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function resolveOutboundTarget(method, message) {
  const threadId = extractThreadId(message);
  if (threadId) {
    return { threadId, url: buildThreadDeepLink(threadId) };
  }

  if (method === "thread/started") {
    return { threadId: null, url: NEW_THREAD_DEEP_LINK };
  }

  return null;
}

function buildThreadDeepLink(threadId) {
  return `codex://threads/${threadId}`;
}

function extractErrorMessage(error) {
  return (
    error?.stderr?.toString("utf8")
    || error?.stdout?.toString("utf8")
    || error?.message
    || "unknown refresh error"
  ).trim();
}

function isDesktopUnavailableError(message) {
  const normalized = String(message).toLowerCase();
  return [
    "unable to find application named",
    "application isn’t running",
    "application isn't running",
    "can’t get application id",
    "can't get application id",
    "does not exist",
    "no application knows how to open",
    "cannot find app",
    "could not find application",
  ].some((snippet) => normalized.includes(snippet));
}

module.exports = {
  NEW_THREAD_DEEP_LINK,
  buildThreadDeepLink,
  extractErrorMessage,
  extractTurnId,
  isDesktopUnavailableError,
  resolveInboundTarget,
  resolveOutboundTarget,
  safeParseJSON,
};
