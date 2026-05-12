// FILE: jsonrpc-normalizer.js
// Purpose: Keeps app-server responses in the JSON-RPC shape the iOS client
//          decodes. Some agent CLIs (notably Codex's app-server) return
//          responses wrapped in `{payload}` instead of `{result}` — iOS only
//          knows how to read `{result}`. This module rewrites those responses
//          into the canonical shape, leaves already-canonical messages
//          untouched, and drops anything that should not be forwarded to the
//          relay (e.g. server-initiated requests for which there's no matching
//          tracked request waiting for a response on the phone side).
// Layer: Bridge support (pure)
// Exports:
//   - normalizeRelayBoundJsonRpcMessage
//   - isRelayBoundServerRequestMethod
// Depends on: ./turns-list-pager (unwrapAppServerPayloadResult)

const { unwrapAppServerPayloadResult } = require("./turns-list-pager");

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeRelayBoundJsonRpcMessage(rawMessage, {
  pendingRequestMethodsById = null,
} = {}) {
  const parsed = parseJSON(rawMessage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const hasMethod = typeof parsed.method === "string" && parsed.method.length > 0;
  const hasResponseId = parsed.id !== undefined && parsed.id !== null;
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
  const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
  const hasPayload = Object.prototype.hasOwnProperty.call(parsed, "payload");
  if (hasResponseId && !hasMethod && !hasResult && !hasError && hasPayload) {
    const { payload, ...rest } = parsed;
    return JSON.stringify({
      ...rest,
      result: payload ?? null,
    });
  }

  if (hasResponseId && !hasMethod && hasResult && !hasError) {
    const unwrappedResult = unwrapAppServerPayloadResult(parsed.result);
    if (unwrappedResult !== parsed.result) {
      return JSON.stringify({
        ...parsed,
        result: unwrappedResult,
      });
    }
  }

  if (hasMethod && hasResponseId && !isRelayBoundServerRequestMethod(parsed.method)) {
    const trackedRequest = pendingRequestMethodsById?.get(String(parsed.id));
    const isTrackedResponse = trackedRequest?.method === parsed.method
      && (hasResult || hasError || hasPayload);
    if (isTrackedResponse) {
      const { method, payload, ...rest } = parsed;
      if (!hasResult && !hasError && hasPayload) {
        return JSON.stringify({
          ...rest,
          result: payload ?? null,
        });
      }
      if (hasResult && !hasError) {
        return JSON.stringify({
          ...rest,
          result: unwrapAppServerPayloadResult(rest.result),
        });
      }
      return JSON.stringify(rest);
    }

    return null;
  }

  if (!hasMethod && !hasResponseId) {
    return null;
  }

  return rawMessage;
}

function isRelayBoundServerRequestMethod(method) {
  return method === "item/tool/requestUserInput"
    || method === "tool/requestUserInput"
    || method.endsWith("requestApproval");
}

module.exports = {
  normalizeRelayBoundJsonRpcMessage,
  isRelayBoundServerRequestMethod,
};
