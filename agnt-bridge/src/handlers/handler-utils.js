// FILE: handlers/handler-utils.js
// Purpose: Owns the shared JSON-RPC request-handling skeleton that six bridge
//          handlers (workspace, desktop, pet, project, voice, notifications)
//          had each copy-pasted: parse the incoming envelope, decide whether
//          the method belongs to us, dispatch to the per-handler method
//          function, and wrap success/failure in a JSON-RPC response.
// Layer: bridge handler infrastructure
// Exports: createJsonRpcRequestHandler
//
// Why this is its own module: the same ~30-line skeleton appeared verbatim
// in every handler with only three variation points — method match, default
// error code, default error message — plus an optional logging hook. Each
// copy independently picked the same JSON-RPC error shape (`code: -32000`,
// `data: { errorCode }`), so a future protocol tweak would mean six
// coordinated edits. Centralizing the envelope here keeps the error contract
// in one place.
//
// What the helper does NOT decide:
//   - Which JSON-RPC error code to use beyond -32000. Today every handler
//     surfaces -32000 (server-defined); if a handler needs a different code
//     it can build its own error response and short-circuit.
//   - How to do per-method validation or auth — that lives in the per-handler
//     dispatch function.

/**
 * Builds a JSON-RPC request handler that follows the bridge's standard
 * envelope contract.
 *
 * @param {object} opts
 * @param {(method: string) => boolean} opts.match
 *   Decides whether the incoming method belongs to this handler.
 *   Return false to pass the message through (the bridge's application
 *   router will hand it to the next stage).
 * @param {(method: string, params: object, options?: object) => Promise<object>} opts.dispatch
 *   Per-handler method dispatcher. May throw; thrown errors are wrapped
 *   into a JSON-RPC error response via defaultErrorCode/defaultErrorMessage
 *   (with err.errorCode / err.userMessage / err.message taking precedence
 *   when present).
 * @param {string} opts.defaultErrorCode
 *   Fallback `data.errorCode` when the thrown error doesn't carry one
 *   (e.g. "workspace_error", "voice_transcription_failed").
 * @param {string} opts.defaultErrorMessage
 *   Fallback `error.message` when the thrown error doesn't carry one.
 * @param {(err: Error) => void} [opts.onError]
 *   Optional side-effect run before the error response is sent. Used by
 *   voice/notifications handlers to console.error the failure.
 *
 * @returns {(rawMessage: string, sendResponse: (line: string) => void, options?: object) => boolean}
 *   A handler suitable for the bridge's application-message-router. Returns
 *   true when the message was claimed, false when it wasn't.
 */
function createJsonRpcRequestHandler({
  match,
  dispatch,
  defaultErrorCode,
  defaultErrorMessage,
  onError,
}) {
  if (typeof match !== "function") {
    throw new TypeError("createJsonRpcRequestHandler: match must be a function");
  }
  if (typeof dispatch !== "function") {
    throw new TypeError("createJsonRpcRequestHandler: dispatch must be a function");
  }
  if (typeof defaultErrorCode !== "string" || !defaultErrorCode) {
    throw new TypeError("createJsonRpcRequestHandler: defaultErrorCode must be a non-empty string");
  }
  if (typeof defaultErrorMessage !== "string" || !defaultErrorMessage) {
    throw new TypeError("createJsonRpcRequestHandler: defaultErrorMessage must be a non-empty string");
  }

  return function handle(rawMessage, sendResponse, options) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!match(method)) {
      return false;
    }

    const id = parsed.id;
    const params = parsed.params || {};

    Promise.resolve()
      .then(() => dispatch(method, params, options))
      .then((result) => {
        sendResponse(JSON.stringify({ id, result }));
      })
      .catch((err) => {
        if (typeof onError === "function") {
          try { onError(err); } catch { /* logging must not mask the response */ }
        }
        const errorCode = err?.errorCode || defaultErrorCode;
        const message = err?.userMessage || err?.message || defaultErrorMessage;
        sendResponse(JSON.stringify({
          id,
          error: {
            code: -32000,
            message,
            data: { errorCode },
          },
        }));
      });

    return true;
  };
}

module.exports = { createJsonRpcRequestHandler };
