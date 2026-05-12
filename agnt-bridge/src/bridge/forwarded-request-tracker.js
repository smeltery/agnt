// FILE: forwarded-request-tracker.js
// Purpose: Two-map TTL ledger that remembers which Codex JSON-RPC methods
//          the bridge has forwarded to the active provider so it can recognize
//          their responses on the way back. The bridge needs this for two
//          unrelated jobs that happen to share the same request-id → method
//          mapping:
//
//          1. **Auth state machine** — the bridge intercepts the
//             `account/login/start` response so it can cache the loginId/authUrl
//             pair locally (so the iOS app can later trigger `openOnMac`
//             without a round-trip). To know that a given response is for
//             `account/login/start`, the tracker remembers the request id.
//          2. **Relay sanitization** — `thread/read`, `thread/turns/list`,
//             and friends return large history payloads that must have their
//             inline images replaced with references before re-encrypting for
//             the relay. The tracker remembers which requests produced those
//             responses so the sanitizer knows what to do.
//
// Layer: utility — depends only on a JSON-RPC parser injected by the caller.
// Exports: createForwardedRequestTracker
//
// Why a module: bridge.js used to inline the two Maps + their TTL pruning
// across ~110 lines, with the auth handler reading the maps directly and the
// thread/turns/list handler poking entries into them in another function. The
// module collects all of that into one stateful unit that can be unit-tested
// without spinning up the whole bridge.

const DEFAULT_TTL_MS = 2 * 60_000;

/**
 * @param {object} options
 * @param {(value: string) => any} options.parseJson
 *   — Inject the bridge's existing tolerant JSON parser (returns null on
 *     malformed input). Avoids a circular import on `bridge.js`'s private
 *     `safeParseJSON` and lets tests substitute their own parser.
 * @param {Set<string>} [options.forwardedMethods]
 *   — Set of methods whose responses the auth state machine cares about
 *     (login/cancel/logout). Defaults to the bridge's documented list.
 * @param {Set<string>} [options.sanitizedMethods]
 *   — Set of methods whose responses must be sanitized before relay encryption
 *     (thread/read, thread/turns/list, thread/list, thread/resume). Defaults
 *     to the bridge's documented list.
 * @param {number} [options.ttlMs] — Per-entry TTL. Defaults to 2 minutes.
 * @param {() => number} [options.now] — Clock injection for tests.
 */
function createForwardedRequestTracker({
  parseJson,
  forwardedMethods = new Set([
    "account/login/start",
    "account/login/cancel",
    "account/logout",
  ]),
  sanitizedMethods = new Set([
    "thread/read",
    "thread/resume",
    "thread/turns/list",
    "thread/list",
  ]),
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  if (typeof parseJson !== "function") {
    throw new TypeError("createForwardedRequestTracker requires a parseJson function.");
  }

  /** request id → { method, createdAt } — drives the auth state machine. */
  const forwardedRequestMethodsById = new Map();
  /** request id → { method, createdAt } — drives relay payload sanitization. */
  const relaySanitizedResponseMethodsById = new Map();

  function pruneExpired() {
    const cutoff = now();
    for (const [id, entry] of forwardedRequestMethodsById) {
      if (!entry || cutoff - entry.createdAt >= ttlMs) {
        forwardedRequestMethodsById.delete(id);
      }
    }
    for (const [id, entry] of relaySanitizedResponseMethodsById) {
      if (!entry || cutoff - entry.createdAt >= ttlMs) {
        relaySanitizedResponseMethodsById.delete(id);
      }
    }
  }

  /**
   * Record an outbound JSON-RPC request from the iOS app, IF the method is in
   * one of the watched sets. No-op for everything else so the maps don't grow
   * unbounded.
   */
  function rememberRequest(rawMessage) {
    const parsed = parseJson(rawMessage);
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    const requestId = parsed?.id;
    if (!method || requestId == null) return;

    pruneExpired();
    if (forwardedMethods.has(method)) {
      forwardedRequestMethodsById.set(String(requestId), {
        method,
        createdAt: now(),
      });
    }
    if (sanitizedMethods.has(method)) {
      relaySanitizedResponseMethodsById.set(String(requestId), {
        method,
        createdAt: now(),
      });
    }
  }

  /**
   * Bridge-managed RPCs that are answered locally (not forwarded) still need
   * their response method recorded so the sanitizer can recognize the reply.
   * This is the explicit-write path used by the thread/turns/list adaptive
   * handler in bridge.js.
   */
  function markSanitizedResponse(requestId, method) {
    if (requestId == null || !method) return;
    relaySanitizedResponseMethodsById.set(String(requestId), {
      method,
      createdAt: now(),
    });
  }

  /**
   * Look up + atomically remove the forwarded-method entry for an inbound
   * response. Used by the auth state machine; returning the method (or null)
   * lets the caller decide what state to update.
   */
  function consumeForwardedResponse(responseId) {
    if (responseId == null) return null;
    const key = String(responseId);
    const entry = forwardedRequestMethodsById.get(key);
    if (!entry) return null;
    forwardedRequestMethodsById.delete(key);
    return entry;
  }

  /**
   * Look up + atomically remove the sanitized-method entry for an inbound
   * response. Used by the relay sanitizer.
   */
  function consumeSanitizedResponse(responseId) {
    if (responseId == null) return null;
    const key = String(responseId);
    const entry = relaySanitizedResponseMethodsById.get(key);
    if (!entry) return null;
    relaySanitizedResponseMethodsById.delete(key);
    return entry;
  }

  /**
   * Returns the Map directly so the relay sanitizer's
   * normalizeRelayBoundJsonRpcMessage helper (which expects a Map literal as
   * `pendingRequestMethodsById`) can keep its current shape. The Map is still
   * owned by the tracker — callers must not mutate it.
   */
  function getSanitizedResponseMap() {
    return relaySanitizedResponseMethodsById;
  }

  /** Resets both maps. Called on Codex transport close so stale entries don't survive a reconnect. */
  function clear() {
    forwardedRequestMethodsById.clear();
    relaySanitizedResponseMethodsById.clear();
  }

  return {
    rememberRequest,
    markSanitizedResponse,
    consumeForwardedResponse,
    consumeSanitizedResponse,
    getSanitizedResponseMap,
    pruneExpired,
    clear,
  };
}

module.exports = {
  createForwardedRequestTracker,
  DEFAULT_TTL_MS,
};
