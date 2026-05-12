// FILE: bridge-managed-codex-client.js
// Purpose: Promise-based request/response wrapper around the bare codex
//          transport's send/onMessage pipe. The bridge issues "bridge-managed"
//          codex requests (thread/read, thread/turns/list pager, ...) where
//          it needs the response routed back as a Promise resolution rather
//          than forwarded to the phone. This module owns the request-id ↔
//          waiter Map and the 20s timeout so bridge.js can stay focused on
//          orchestration.
// Layer: Bridge support (state-bearing factory)
// Exports: createBridgeManagedCodexClient
// Depends on: crypto.randomBytes for request-id generation

const { randomBytes } = require("crypto");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_ID_PREFIX = "bridge-managed";

function createBridgeManagedCodexClient({
  send,
  // Test seams.
  randomBytesImpl = randomBytes,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestIdPrefix = DEFAULT_REQUEST_ID_PREFIX,
} = {}) {
  if (typeof send !== "function") {
    throw new Error("createBridgeManagedCodexClient: send(payload) is required.");
  }

  const waiters = new Map();

  function sendRequest(method, params) {
    const requestId = `${requestIdPrefix}-${randomBytesImpl(12).toString("hex")}`;
    const payload = JSON.stringify({ id: requestId, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeoutImpl(() => {
        waiters.delete(requestId);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);

      waiters.set(requestId, { method, resolve, reject, timeout });

      try {
        send(payload);
      } catch (error) {
        clearTimeoutImpl(timeout);
        waiters.delete(requestId);
        reject(error);
      }
    });
  }

  // Intercepts responses for bridge-private requests so only user-visible app-server
  // traffic is forwarded back through secure transport. Returns true when the message
  // was consumed (matching waiter found), false otherwise so the caller can fall
  // through to the normal phone-bound routing.
  function handleResponse(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const responseId = typeof parsed?.id === "string" ? parsed.id : null;
    if (!responseId) {
      return false;
    }

    const waiter = waiters.get(responseId);
    if (!waiter) {
      return false;
    }

    waiters.delete(responseId);
    clearTimeoutImpl(waiter.timeout);

    if (parsed.error) {
      const error = new Error(parsed.error.message || `Codex request failed: ${waiter.method}`);
      error.code = parsed.error.code;
      error.data = parsed.error.data;
      waiter.reject(error);
      return true;
    }

    waiter.resolve(readSuccessPayload(parsed));
    return true;
  }

  // Normalises app-server responses. Codex returns `{result}` most of the time but
  // occasionally hands back `{payload}`; non-Codex providers always use `{result}`,
  // so this is a no-op for them.
  function readSuccessPayload(parsed) {
    if (Object.prototype.hasOwnProperty.call(parsed, "result")) {
      return parsed.result ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "payload")) {
      return parsed.payload ?? null;
    }
    return null;
  }

  function failAll(error) {
    for (const waiter of waiters.values()) {
      clearTimeoutImpl(waiter.timeout);
      waiter.reject(error);
    }
    waiters.clear();
  }

  function pendingCount() {
    return waiters.size;
  }

  return {
    sendRequest,
    handleResponse,
    failAll,
    pendingCount,
  };
}

module.exports = {
  createBridgeManagedCodexClient,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REQUEST_ID_PREFIX,
};
