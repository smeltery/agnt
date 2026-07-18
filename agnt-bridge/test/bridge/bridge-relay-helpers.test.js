// FILE: bridge-relay-helpers.test.js
// Purpose: Unit tests for the relay-bound helpers:
//          - normalizeRelayBoundJsonRpcMessage / unwrapAppServerPayloadResult
//          - buildEmergencySingleTurnResponse shrink loop
//          - maybeBuildJsonlThreadTurnsListFallback codex gating + IO injection
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEmergencySingleTurnResponse,
  buildLargestSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  isEmptyTurnsListResponse,
  isRelayBoundServerRequestMethod,
  maybeBuildJsonlThreadTurnsListFallback,
  normalizeRelayBoundJsonRpcMessage,
  unwrapAppServerPayloadResult,
} = require("../../src/bridge/bridge");

// ─── normalizeRelayBoundJsonRpcMessage ──────────────────────────────────────

test("normalizeRelayBoundJsonRpcMessage passes a plain {id, result} response through unchanged", () => {
  const raw = JSON.stringify({ id: "r1", result: { ok: true } });
  assert.equal(normalizeRelayBoundJsonRpcMessage(raw), raw);
});

test("normalizeRelayBoundJsonRpcMessage rewrites {id, payload} → {id, result}", () => {
  const raw = JSON.stringify({ id: "r2", payload: { ok: true } });
  const normalized = normalizeRelayBoundJsonRpcMessage(raw);
  const parsed = JSON.parse(normalized);
  assert.equal(parsed.id, "r2");
  assert.deepEqual(parsed.result, { ok: true });
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "payload"), false);
});

test("normalizeRelayBoundJsonRpcMessage unwraps nested {result: {payload: {...}}} when payload has direct keys", () => {
  const raw = JSON.stringify({
    id: "r3",
    result: { payload: { data: [1, 2, 3], nextCursor: "abc" } },
  });
  const normalized = normalizeRelayBoundJsonRpcMessage(raw);
  const parsed = JSON.parse(normalized);
  assert.deepEqual(parsed.result.data, [1, 2, 3]);
  assert.equal(parsed.result.nextCursor, "abc");
});

test("normalizeRelayBoundJsonRpcMessage leaves nested payload alone when it has no direct-result keys", () => {
  // No "data" / "items" / "threads" / "turns" / "thread" key inside payload, so we leave it.
  const raw = JSON.stringify({ id: "r4", result: { payload: { something: 1 } } });
  assert.equal(normalizeRelayBoundJsonRpcMessage(raw), raw);
});

test("normalizeRelayBoundJsonRpcMessage drops untracked server-initiated method calls (not approvals)", () => {
  const raw = JSON.stringify({ id: "r5", method: "thread/started", params: {} });
  assert.equal(normalizeRelayBoundJsonRpcMessage(raw), null);
});

test("normalizeRelayBoundJsonRpcMessage forwards server-initiated approval requests untouched", () => {
  const raw = JSON.stringify({
    id: "r6",
    method: "item/commandExecution/requestApproval",
    params: { foo: 1 },
  });
  assert.equal(normalizeRelayBoundJsonRpcMessage(raw), raw);
});

test("normalizeRelayBoundJsonRpcMessage strips method + rewrites payload for tracked responses", () => {
  const tracked = new Map([["r7", { method: "thread/turns/list" }]]);
  const raw = JSON.stringify({
    id: "r7",
    method: "thread/turns/list",
    payload: { data: [] },
  });
  const normalized = normalizeRelayBoundJsonRpcMessage(raw, { pendingRequestMethodsById: tracked });
  const parsed = JSON.parse(normalized);
  assert.equal(parsed.id, "r7");
  assert.equal(parsed.method, undefined);
  assert.deepEqual(parsed.result, { data: [] });
});

test("normalizeRelayBoundJsonRpcMessage drops notifications with neither method nor id", () => {
  assert.equal(normalizeRelayBoundJsonRpcMessage(JSON.stringify({})), null);
});

test("normalizeRelayBoundJsonRpcMessage drops malformed input", () => {
  assert.equal(normalizeRelayBoundJsonRpcMessage("not json"), null);
  assert.equal(normalizeRelayBoundJsonRpcMessage("[1,2,3]"), null);
  assert.equal(normalizeRelayBoundJsonRpcMessage(null), null);
});

// ─── unwrapAppServerPayloadResult ──────────────────────────────────────────

test("unwrapAppServerPayloadResult returns the value unchanged when there's no payload key", () => {
  const v = { data: [], cursor: null };
  assert.equal(unwrapAppServerPayloadResult(v), v);
});

test("unwrapAppServerPayloadResult unwraps when payload contains a direct-result key", () => {
  const out = unwrapAppServerPayloadResult({ payload: { data: [1] }, extra: 2 });
  assert.deepEqual(out, { payload: { data: [1] }, extra: 2, data: [1] });
});

test("unwrapAppServerPayloadResult passes scalars through", () => {
  assert.equal(unwrapAppServerPayloadResult(null), null);
  assert.equal(unwrapAppServerPayloadResult(42), 42);
  assert.equal(unwrapAppServerPayloadResult("x"), "x");
  const arr = [1, 2];
  assert.equal(unwrapAppServerPayloadResult(arr), arr);
});

// ─── isRelayBoundServerRequestMethod ───────────────────────────────────────

test("isRelayBoundServerRequestMethod recognizes the legitimate server-initiated methods", () => {
  assert.equal(isRelayBoundServerRequestMethod("item/tool/requestUserInput"), true);
  assert.equal(isRelayBoundServerRequestMethod("tool/requestUserInput"), true);
  assert.equal(isRelayBoundServerRequestMethod("item/commandExecution/requestApproval"), true);
  assert.equal(isRelayBoundServerRequestMethod("item/fileChange/requestApproval"), true);
  assert.equal(isRelayBoundServerRequestMethod("thread/started"), false);
  assert.equal(isRelayBoundServerRequestMethod("turn/completed"), false);
});

// ─── buildEmergencySingleTurnResponse shrink loop ──────────────────────────

const PASSTHROUGH_SANITIZE = (rawMessage /* , method */) => rawMessage;

test("buildEmergencySingleTurnResponse compacts a turn so it fits under a generous byte cap", () => {
  const turn = {
    id: "turn-1",
    status: "completed",
    items: Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      type: "message",
      role: "assistant",
      text: "x".repeat(2_000),
    })),
  };
  const response = buildEmergencySingleTurnResponse({
    requestId: "req-1",
    lastResult: { data: [], nextCursor: null },
    turnsKey: "data",
    turn,
    sanitizeForRelay: PASSTHROUGH_SANITIZE,
    payloadSoftLimitBytes: 2 * 1024 * 1024,
  });
  assert.ok(response, "expected an emergency response when budget is generous");
  assert.equal(response.id, "req-1");
  assert.equal(response.result.agntEmergencySingleTurnForRelay, true);
  assert.equal(response.result.data.length, 1);
  const compactedTurn = response.result.data[0];
  assert.equal(compactedTurn.id, "turn-1");
  assert.equal(compactedTurn.agntEmergencySingleTurnForRelay, true);
  assert.equal(compactedTurn.agntPageCompactedForRelay, true);
});

test("buildEmergencySingleTurnResponse returns null when even the smallest representation overshoots", () => {
  // Force the sanitizer to look enormous so no compaction level satisfies the budget.
  const overgrown = (raw) => raw + "x".repeat(10 * 1024 * 1024);
  const response = buildEmergencySingleTurnResponse({
    requestId: "req-2",
    lastResult: { data: [], nextCursor: null },
    turnsKey: "data",
    turn: { id: "t", items: [] },
    sanitizeForRelay: overgrown,
    payloadSoftLimitBytes: 1024,
  });
  assert.equal(response, null);
});

test("buildEmergencySingleTurnResponse returns null when the turn argument is unusable", () => {
  const args = {
    requestId: "req-3",
    lastResult: { data: [] },
    turnsKey: "data",
    sanitizeForRelay: PASSTHROUGH_SANITIZE,
    payloadSoftLimitBytes: 1024,
  };
  assert.equal(buildEmergencySingleTurnResponse({ ...args, turn: null }), null);
  assert.equal(buildEmergencySingleTurnResponse({ ...args, turn: "not an object" }), null);
  assert.equal(buildEmergencySingleTurnResponse({ ...args, turn: [1] }), null);
});

test("compactEmergencySingleTurnForRelay slices to maxItems and copies only safe scalar metadata", () => {
  const turn = {
    id: "t",
    turnId: "t",
    status: "completed",
    role: "assistant",
    badNested: { should: "not survive" },
    items: [
      { id: "a", type: "message", text: "first" },
      { id: "b", type: "message", text: "middle" },
      { id: "c", type: "message", text: "tail" },
    ],
  };
  const compact = compactEmergencySingleTurnForRelay(turn, 8, 1);
  // Only safe scalar keys are copied; the nested object is dropped.
  assert.equal(compact.id, "t");
  assert.equal(compact.status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(compact, "badNested"), false);
  // maxItems=1 keeps the tail item only.
  assert.equal(compact.items.length, 1);
  assert.equal(compact.items[0].id, "c");
  assert.equal(compact.agntEmergencySingleTurnForRelay, true);
  assert.equal(compact.agntPageCompactedForRelay, true);
});

test("buildLargestSafeTurnsListResponse falls back to emergency single-turn when no slice fits", () => {
  // Pretend each sliced response is "huge" so the progressive shrink loop fails on every count.
  // The emergency builder then takes over with its own shrink levels.
  const overgrown = (raw) => raw + "x".repeat(10 * 1024 * 1024);
  const passthrough = (raw) => raw;
  const turns = [
    { id: "t-1", items: [{ id: "i-1", type: "message", text: "hi" }] },
    { id: "t-2", items: [{ id: "i-2", type: "message", text: "ok" }] },
  ];
  const noFit = buildLargestSafeTurnsListResponse({
    requestId: "req",
    firstResult: {},
    lastResult: { data: [], nextCursor: null },
    turnsKey: "data",
    turns,
    maxTurns: 5,
    sanitizeForRelay: overgrown,
    payloadSoftLimitBytes: 1024,
  });
  // With a sanitizer that always overshoots, even the emergency builder bails out.
  assert.equal(noFit, null);

  // With a passthrough sanitizer + room to spare, the normal slice loop returns turns directly.
  const fits = buildLargestSafeTurnsListResponse({
    requestId: "req",
    firstResult: {},
    lastResult: { data: [], nextCursor: null },
    turnsKey: "data",
    turns,
    maxTurns: 5,
    sanitizeForRelay: passthrough,
    payloadSoftLimitBytes: 2 * 1024 * 1024,
  });
  assert.ok(fits, "expected a safe response under generous budget");
  assert.equal(fits.id, "req");
  assert.equal(fits.result.data.length, 2);
});

// ─── isEmptyTurnsListResponse ──────────────────────────────────────────────

test("isEmptyTurnsListResponse detects empty `data`/`items`/`turns` arrays", () => {
  assert.equal(isEmptyTurnsListResponse({ result: { data: [] } }), true);
  assert.equal(isEmptyTurnsListResponse({ result: { items: [] } }), true);
  assert.equal(isEmptyTurnsListResponse({ result: { turns: [] } }), true);
});

test("isEmptyTurnsListResponse returns false when at least one turn is present", () => {
  assert.equal(isEmptyTurnsListResponse({ result: { data: [{ id: "t" }] } }), false);
});

test("isEmptyTurnsListResponse returns false when no recognized turns key is present", () => {
  assert.equal(isEmptyTurnsListResponse({ result: { something: [] } }), false);
  assert.equal(isEmptyTurnsListResponse({ result: null }), false);
  assert.equal(isEmptyTurnsListResponse(null), false);
});

// ─── maybeBuildJsonlThreadTurnsListFallback codex gating ───────────────────

const codexProvider = { id: "codex" };
const claudeProvider = { id: "claude" };

const baseRequest = {
  id: "req-fallback",
  params: { threadId: "thr-1", limit: 5 },
};
const emptyResponse = { id: "req-fallback", result: { data: [] } };

function makeFallbackDeps(overrides = {}) {
  return {
    resolveSessionsRootImpl: () => "/fake/sessions",
    findRecentRolloutFileForContextReadImpl: () => "/fake/sessions/thr-1.jsonl",
    readThreadTurnsListPageFromSessionJsonlImpl: () => ({
      data: [{ id: "t-1", items: [{ id: "i", type: "message", role: "assistant", text: "hi" }] }],
      nextCursor: null,
    }),
    logger: { warn() {} },
    ...overrides,
  };
}

test("maybeBuildJsonlThreadTurnsListFallback returns null for non-codex providers (no IO)", () => {
  let ioCalled = false;
  const result = maybeBuildJsonlThreadTurnsListFallback(claudeProvider, baseRequest, emptyResponse, makeFallbackDeps({
    resolveSessionsRootImpl: () => { ioCalled = true; return "/fake"; },
  }));
  assert.equal(result, null);
  assert.equal(ioCalled, false, "non-codex providers must short-circuit before any IO");
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when the response already has turns", () => {
  const populated = { id: "req-fallback", result: { data: [{ id: "t" }] } };
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, baseRequest, populated, makeFallbackDeps());
  assert.equal(result, null);
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when the request lacks a thread id", () => {
  const noThreadId = { id: "req", params: { limit: 5 } };
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, noThreadId, emptyResponse, makeFallbackDeps());
  assert.equal(result, null);
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when a relay cursor is set (skip fallback for paginated reads)", () => {
  const cursored = {
    id: "req-cursored",
    params: { threadId: "thr-1", limit: 5, cursor: "page-2" },
  };
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, cursored, emptyResponse, makeFallbackDeps());
  assert.equal(result, null);
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when canonical history is required", () => {
  let ioCalled = false;
  const canonicalRequest = {
    id: "req-canonical",
    params: { threadId: "thr-1", limit: 5, agntRequireCanonical: true },
  };
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, canonicalRequest, emptyResponse, makeFallbackDeps({
    resolveSessionsRootImpl: () => { ioCalled = true; return "/fake"; },
  }));
  assert.equal(result, null);
  assert.equal(ioCalled, false, "canonical retries must skip local JSONL fallback before any IO");
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when no rollout file is found on disk", () => {
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, baseRequest, emptyResponse, makeFallbackDeps({
    findRecentRolloutFileForContextReadImpl: () => "",
  }));
  assert.equal(result, null);
});

test("maybeBuildJsonlThreadTurnsListFallback returns null when the rollout reconstructs to empty", () => {
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, baseRequest, emptyResponse, makeFallbackDeps({
    readThreadTurnsListPageFromSessionJsonlImpl: () => ({ data: [], nextCursor: null }),
  }));
  assert.equal(result, null);
});

test("maybeBuildJsonlThreadTurnsListFallback returns the reconstructed page for codex with turns", () => {
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, baseRequest, emptyResponse, makeFallbackDeps());
  assert.ok(result);
  assert.equal(result.id, "req-fallback");
  assert.equal(result.result.data.length, 1);
  assert.equal(result.result.data[0].id, "t-1");
});

test("maybeBuildJsonlThreadTurnsListFallback swallows IO errors and warns", () => {
  const warnings = [];
  const result = maybeBuildJsonlThreadTurnsListFallback(codexProvider, baseRequest, emptyResponse, makeFallbackDeps({
    findRecentRolloutFileForContextReadImpl: () => { throw new Error("disk gone"); },
    logger: { warn: (msg) => warnings.push(msg) },
  }));
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /jsonl fallback failed: disk gone/);
});
