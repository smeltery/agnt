// FILE: bridge/relay-outbound-pipeline.js
// Purpose: Owns the fan-out for messages coming OUT of the active provider
//          (codex / claude / opencode / cursor) on their way to the relay.
//          Three phases: (1) optional short-circuit when the bridge itself
//          owns the response, (2) ordered observers that look at the raw
//          message for tracking and side effects, (3) sanitize-and-forward.
// Layer: bridge orchestration
// Exports: createRelayOutboundPipeline
//
// Why this is its own module: bridge.js used to inline the whole pipeline
// (~14 LOC) alongside socket lifecycle, reconnect, and the inbound router.
// Pulling it out makes the phase ordering legible and lets the pipeline be
// exercised in isolation without booting the relay or codex transport.
//
// Phase semantics (must stay in sync with the contract test):
//   - shortCircuit returns truthy when the bridge has internally consumed
//     the message (typical case: a response to a bridge-initiated request).
//     When truthy, observers and forward both skip.
//   - observers always run after a non-short-circuit. They side-effect on
//     the raw codex message; they do not transform it.
//   - sanitize maps the raw message to the relay-bound payload (or null to
//     drop). forward fires only when sanitize returns a non-null payload.

/**
 * @param {object} opts
 * @param {(message: object) => boolean | void} opts.shortCircuit
 *   Return truthy to claim the message before observers/forward run.
 * @param {Array<(message: object) => void>} opts.observers
 *   Ordered side-effect hooks (tracking, auth, push). Run on the raw
 *   message after shortCircuit returns falsy.
 * @param {(message: object) => (string | null)} opts.sanitize
 *   Maps the raw codex message to the relay-bound wire payload, or null
 *   to drop. Bridge-specific normalization/redaction lives here.
 * @param {(payload: string) => void} opts.forward
 *   Sends the sanitized payload to the relay (typically wraps
 *   secureTransport.queueOutboundApplicationMessage).
 * @returns {(message: object) => void}
 */
function createRelayOutboundPipeline({ shortCircuit, observers, sanitize, forward }) {
  if (typeof shortCircuit !== "function") {
    throw new TypeError("createRelayOutboundPipeline: shortCircuit must be a function");
  }
  if (!Array.isArray(observers)) {
    throw new TypeError("createRelayOutboundPipeline: observers must be an array");
  }
  if (typeof sanitize !== "function") {
    throw new TypeError("createRelayOutboundPipeline: sanitize must be a function");
  }
  if (typeof forward !== "function") {
    throw new TypeError("createRelayOutboundPipeline: forward must be a function");
  }
  return function dispatch(message) {
    if (shortCircuit(message)) return;
    for (const observer of observers) {
      observer(message);
    }
    const sanitized = sanitize(message);
    if (sanitized == null) return;
    forward(sanitized);
  };
}

module.exports = { createRelayOutboundPipeline };
