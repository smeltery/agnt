// FILE: contracts/message-context.test.js
// Purpose: Pins the schema-tolerance contract for message-context.js. Every
//          Codex / Claude / opencode / Cursor variant uses subtly different
//          param shapes for the same conceptual field (threadId vs thread_id
//          vs turn.threadId vs ...). The extractors must accept all known
//          aliases — failing here means bridge.js will silently start
//          mis-routing turn activity or miss the context-usage watcher kick.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractBridgeMessageContext,
  shouldStartContextUsageWatcher,
  extractThreadId,
  extractTurnId,
} = require("../../src/bridge/message-context");

// ─── extractBridgeMessageContext ────────────────────────────────────────────

test("extractBridgeMessageContext returns empty context for malformed JSON", () => {
  assert.deepEqual(
    extractBridgeMessageContext("not json"),
    { method: "", threadId: null, turnId: null },
  );
  assert.deepEqual(
    extractBridgeMessageContext(""),
    { method: "", threadId: null, turnId: null },
  );
});

test("extractBridgeMessageContext returns method='' for messages without a method", () => {
  const raw = JSON.stringify({ id: "r1", result: { ok: true } });
  const ctx = extractBridgeMessageContext(raw);
  assert.equal(ctx.method, "");
  assert.equal(ctx.threadId, null);
  assert.equal(ctx.turnId, null);
});

test("extractBridgeMessageContext extracts the full context for a turn/started message", () => {
  const raw = JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-abc", turnId: "turn-42" },
  });
  const ctx = extractBridgeMessageContext(raw);
  assert.equal(ctx.method, "turn/started");
  assert.equal(ctx.threadId, "thread-abc");
  assert.equal(ctx.turnId, "turn-42");
});

// ─── shouldStartContextUsageWatcher ─────────────────────────────────────────

test("shouldStartContextUsageWatcher requires both turn/start* method and a thread id", () => {
  assert.equal(
    shouldStartContextUsageWatcher({ method: "turn/start", threadId: "t1" }),
    true,
  );
  assert.equal(
    shouldStartContextUsageWatcher({ method: "turn/started", threadId: "t1" }),
    true,
  );
  // Wrong method
  assert.equal(
    shouldStartContextUsageWatcher({ method: "thread/started", threadId: "t1" }),
    false,
  );
  assert.equal(
    shouldStartContextUsageWatcher({ method: "turn/completed", threadId: "t1" }),
    false,
  );
  // Missing thread id
  assert.equal(
    shouldStartContextUsageWatcher({ method: "turn/start", threadId: null }),
    false,
  );
  assert.equal(
    shouldStartContextUsageWatcher({ method: "turn/start", threadId: "" }),
    false,
  );
  // Defensive: null/undefined context
  assert.equal(shouldStartContextUsageWatcher(null), false);
  assert.equal(shouldStartContextUsageWatcher(undefined), false);
  assert.equal(shouldStartContextUsageWatcher({}), false);
});

// ─── extractThreadId — alias coverage ───────────────────────────────────────

test("extractThreadId returns null for unrelated methods", () => {
  assert.equal(extractThreadId("account/status/read", { threadId: "t1" }), null);
  assert.equal(extractThreadId("notification/anything", { threadId: "t1" }), null);
  assert.equal(extractThreadId(undefined, { threadId: "t1" }), null);
});

test("extractThreadId(turn/start) accepts threadId, thread_id, turn.threadId, turn.thread_id", () => {
  assert.equal(extractThreadId("turn/start", { threadId: "t-1" }), "t-1");
  assert.equal(extractThreadId("turn/start", { thread_id: "t-2" }), "t-2");
  assert.equal(extractThreadId("turn/start", { turn: { threadId: "t-3" } }), "t-3");
  assert.equal(extractThreadId("turn/start", { turn: { thread_id: "t-4" } }), "t-4");
  assert.equal(extractThreadId("turn/start", {}), "");
});

test("extractThreadId(thread/start) accepts threadId, thread_id, thread.id, thread.threadId, thread.thread_id", () => {
  assert.equal(extractThreadId("thread/start", { threadId: "t-a" }), "t-a");
  assert.equal(extractThreadId("thread/start", { thread_id: "t-b" }), "t-b");
  assert.equal(extractThreadId("thread/start", { thread: { id: "t-c" } }), "t-c");
  assert.equal(extractThreadId("thread/start", { thread: { threadId: "t-d" } }), "t-d");
  assert.equal(extractThreadId("thread/start", { thread: { thread_id: "t-e" } }), "t-e");
});

test("extractThreadId(turn/completed) accepts threadId, thread_id, turn.threadId, turn.thread_id", () => {
  assert.equal(extractThreadId("turn/completed", { threadId: "t-1" }), "t-1");
  assert.equal(extractThreadId("turn/completed", { thread_id: "t-2" }), "t-2");
  assert.equal(extractThreadId("turn/completed", { turn: { threadId: "t-3" } }), "t-3");
  assert.equal(extractThreadId("turn/completed", { turn: { thread_id: "t-4" } }), "t-4");
});

test("extractThreadId returns null for missing params without throwing", () => {
  assert.equal(extractThreadId("turn/start", null), "");
  assert.equal(extractThreadId("turn/start", undefined), "");
});

// ─── extractTurnId — alias coverage ─────────────────────────────────────────

test("extractTurnId returns null for non-turn-lifecycle methods", () => {
  assert.equal(extractTurnId("thread/start", { turnId: "x" }), null);
  assert.equal(extractTurnId("notification", { turnId: "x" }), null);
  assert.equal(extractTurnId(undefined, { turnId: "x" }), null);
});

test("extractTurnId(turn/started) accepts turnId, turn_id, id, turn.id, turn.turnId, turn.turn_id", () => {
  assert.equal(extractTurnId("turn/started", { turnId: "u-1" }), "u-1");
  assert.equal(extractTurnId("turn/started", { turn_id: "u-2" }), "u-2");
  assert.equal(extractTurnId("turn/started", { id: "u-3" }), "u-3");
  assert.equal(extractTurnId("turn/started", { turn: { id: "u-4" } }), "u-4");
  assert.equal(extractTurnId("turn/started", { turn: { turnId: "u-5" } }), "u-5");
  assert.equal(extractTurnId("turn/started", { turn: { turn_id: "u-6" } }), "u-6");
});

test("extractTurnId(turn/completed) shares the same alias set as turn/started", () => {
  assert.equal(extractTurnId("turn/completed", { turn_id: "u-2" }), "u-2");
  assert.equal(extractTurnId("turn/completed", { turn: { id: "u-4" } }), "u-4");
});

test("extractThreadId / extractTurnId return empty string (not null) when method matches but no alias hits", () => {
  // This is load-bearing for shouldStartContextUsageWatcher's truthiness check —
  // an empty string MUST be falsy or the watcher would kick on empty thread ids.
  assert.equal(extractThreadId("turn/start", {}), "");
  assert.equal(extractTurnId("turn/started", {}), "");
});
