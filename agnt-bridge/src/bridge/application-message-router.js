// FILE: bridge/application-message-router.js
// Purpose: Owns the ordered fan-out of decrypted relay payloads to the
//          per-feature handlers in the bridge (handshake, account, voice,
//          thread-context, workspace, project, pet, notifications, desktop,
//          git, turns-list, ...). Each stage is a function the router calls
//          in order; the first stage that returns a truthy value claims the
//          message and ends the dispatch. If nothing claims it, the
//          configured fallback runs (today: forward to the active provider).
// Layer: bridge orchestration
// Exports: createApplicationMessageRouter
//
// Why this is its own module: bridge.js used to inline the whole if-ladder
// (~65 LOC) alongside socket lifecycle, reconnect, and provider resolution.
// Pulling the dispatch out lets the handler order be read top-to-bottom
// without scanning past unrelated orchestration, and makes the routing
// testable in isolation by feeding fake stages.
//
// What a stage may do:
//   - Short-circuit by returning true (handled, stop walking the list).
//   - Pass through by returning false/undefined.
//   - Side-effect *without* short-circuiting (e.g. `desktopRefresher`
//     observing inbound traffic). Those stages just `return false` after
//     doing their work.

/**
 * @param {object} opts
 * @param {Array<(message: object) => boolean | void>} opts.stages
 *   Ordered list. First one to return truthy claims the message.
 * @param {(message: object) => void} opts.fallback
 *   Runs when no stage claims the message. Typically forwards to the
 *   active provider's transport.
 * @returns {(message: object) => void}
 */
function createApplicationMessageRouter({ stages, fallback }) {
  if (!Array.isArray(stages)) {
    throw new TypeError("createApplicationMessageRouter: stages must be an array");
  }
  if (typeof fallback !== "function") {
    throw new TypeError("createApplicationMessageRouter: fallback must be a function");
  }
  return function route(message) {
    for (const stage of stages) {
      if (stage(message)) return;
    }
    fallback(message);
  };
}

module.exports = { createApplicationMessageRouter };
