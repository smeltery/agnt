// FILE: contracts/forwarded-request-tracker.test.js
// Purpose: Pins the request-id → method ledger used by the bridge's auth
//          state machine and relay sanitizer. The bridge collapses two
//          unrelated concerns into this one tracker; if the TTL window or
//          consume semantics drift, login flows hang and history payloads
//          stop getting sanitized.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createForwardedRequestTracker, DEFAULT_TTL_MS } = require("../../src/bridge/forwarded-request-tracker");

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function makeTracker(opts = {}) {
  let clock = opts.startAt ?? 1_000_000;
  const tracker = createForwardedRequestTracker({
    parseJson,
    ttlMs: opts.ttlMs,
    now: () => clock,
  });
  return {
    tracker,
    advance(ms) { clock += ms; },
    set(ms) { clock = ms; },
  };
}

test("rememberRequest records forwarded methods so the response can be matched later", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({
    id: "req-1",
    method: "account/login/start",
  }));
  const entry = tracker.consumeForwardedResponse("req-1");
  assert.deepEqual(entry?.method, "account/login/start");
});

test("rememberRequest records sanitized methods on a separate ledger", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({
    id: "req-2",
    method: "thread/read",
  }));
  // Not on the forwarded ledger — thread/read is not a login method.
  assert.equal(tracker.consumeForwardedResponse("req-2"), null);
  // But it is on the sanitized ledger.
  const entry = tracker.consumeSanitizedResponse("req-2");
  assert.equal(entry?.method, "thread/read");
});

test("rememberRequest ignores requests outside the watched method sets", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({
    id: "req-3",
    method: "turn/start",
  }));
  assert.equal(tracker.consumeForwardedResponse("req-3"), null);
  assert.equal(tracker.consumeSanitizedResponse("req-3"), null);
});

test("rememberRequest tolerates malformed input without throwing", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest("not json");
  tracker.rememberRequest(JSON.stringify({ method: "account/login/start" })); // no id
  tracker.rememberRequest(JSON.stringify({ id: "x" })); // no method
  tracker.rememberRequest(""); // empty
  // No entries should have been recorded.
  assert.equal(tracker.consumeForwardedResponse("x"), null);
});

test("consume* removes the entry, so repeated consumes return null", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({
    id: "req-4",
    method: "account/login/cancel",
  }));
  assert.equal(tracker.consumeForwardedResponse("req-4").method, "account/login/cancel");
  assert.equal(tracker.consumeForwardedResponse("req-4"), null);
});

test("entries past the TTL are pruned on the next rememberRequest call", () => {
  const env = makeTracker({ ttlMs: 1000 });
  env.tracker.rememberRequest(JSON.stringify({ id: "old", method: "account/logout" }));
  env.advance(1001);
  // Force a prune by recording another entry.
  env.tracker.rememberRequest(JSON.stringify({ id: "new", method: "account/logout" }));
  assert.equal(env.tracker.consumeForwardedResponse("old"), null);
  assert.equal(env.tracker.consumeForwardedResponse("new").method, "account/logout");
});

test("explicit pruneExpired drops both forwarded and sanitized stale entries", () => {
  const env = makeTracker({ ttlMs: 500 });
  env.tracker.rememberRequest(JSON.stringify({ id: "a", method: "account/logout" }));
  env.tracker.rememberRequest(JSON.stringify({ id: "b", method: "thread/list" }));
  env.advance(501);
  env.tracker.pruneExpired();
  assert.equal(env.tracker.consumeForwardedResponse("a"), null);
  assert.equal(env.tracker.consumeSanitizedResponse("b"), null);
});

test("markSanitizedResponse records bridge-locally-answered RPCs", () => {
  // thread/turns/list (the adaptive variant) is answered locally; we record
  // it explicitly so the relay sanitizer still treats the response as a
  // turns-list payload.
  const { tracker } = makeTracker();
  tracker.markSanitizedResponse("req-local-1", "thread/turns/list");
  const entry = tracker.consumeSanitizedResponse("req-local-1");
  assert.equal(entry?.method, "thread/turns/list");
});

test("markSanitizedResponse no-ops on null id / empty method", () => {
  const { tracker } = makeTracker();
  tracker.markSanitizedResponse(null, "thread/list");
  tracker.markSanitizedResponse("req-x", "");
  assert.equal(tracker.consumeSanitizedResponse("req-x"), null);
});

test("clear() drops every tracked entry (used on transport reconnect)", () => {
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({ id: "r1", method: "account/login/start" }));
  tracker.rememberRequest(JSON.stringify({ id: "r2", method: "thread/read" }));
  tracker.clear();
  assert.equal(tracker.consumeForwardedResponse("r1"), null);
  assert.equal(tracker.consumeSanitizedResponse("r2"), null);
});

test("getSanitizedResponseMap exposes the underlying Map for legacy callers", () => {
  // The relay sanitizer's normalizeRelayBoundJsonRpcMessage expects the bare
  // Map. Verify the tracker hands back a Map and that entries surface there.
  const { tracker } = makeTracker();
  tracker.rememberRequest(JSON.stringify({ id: "req-5", method: "thread/list" }));
  const map = tracker.getSanitizedResponseMap();
  assert.ok(map instanceof Map);
  assert.equal(map.get("req-5").method, "thread/list");
});

test("DEFAULT_TTL_MS is two minutes — the documented bridge.js TTL", () => {
  assert.equal(DEFAULT_TTL_MS, 2 * 60_000);
});

test("createForwardedRequestTracker rejects missing parseJson", () => {
  assert.throws(() => createForwardedRequestTracker({}), /parseJson/);
});
