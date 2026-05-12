// FILE: message-context.js
// Purpose: Pure helpers that extract routing context (method + thread id +
//          turn id) from raw JSON-RPC frames. Used by bridge.js to decide
//          which messages need the context-usage watcher started and to feed
//          activity tracking. Schema-tolerant: every Codex/Claude/opencode/
//          Cursor variant uses subtly different param shapes for the same
//          conceptual field, so each extractor walks the known aliases
//          (threadId, thread_id, turn.threadId, turn.thread_id, ...).
// Layer: Bridge support (pure)
// Exports:
//   - extractBridgeMessageContext (parses raw message → {method, threadId, turnId})
//   - shouldStartContextUsageWatcher (predicate)
//   - extractThreadId, extractTurnId (lower-level helpers, re-exported for tests)

function readString(value) {
  return typeof value === "string" ? value : "";
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function shouldStartContextUsageWatcher(context) {
  if (!context?.threadId) {
    return false;
  }

  return context.method === "turn/start"
    || context.method === "turn/started";
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
      || readString(params?.turn?.turnId)
      || readString(params?.turn?.turn_id)
    );
  }

  return null;
}

module.exports = {
  extractBridgeMessageContext,
  shouldStartContextUsageWatcher,
  extractThreadId,
  extractTurnId,
};
