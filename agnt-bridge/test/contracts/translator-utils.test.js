// FILE: contracts/translator-utils.test.js
// Purpose: Lock the shape of the shared translator helpers so providers
//          cannot drift apart on id formats, JSON-RPC framing, or the
//          overlap-rejection error payload.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/providers/_shared/translator-utils

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TURN_OVERLAP_ERROR_CODE,
  buildTurnOverlapError,
  createFrameEmitter,
  generateItemId,
  generateThreadId,
  generateTurnId,
  numberOr,
  readString,
  safeParseJson,
} = require("../../src/providers/_shared/translator-utils");

test("generateThreadId emits `thr_<24-hex>`", () => {
  const id = generateThreadId();
  assert.match(id, /^thr_[0-9a-f]{24}$/);
});

test("generateTurnId emits `turn_<24-hex>`", () => {
  const id = generateTurnId();
  assert.match(id, /^turn_[0-9a-f]{24}$/);
});

test("generateItemId prefixes the caller-supplied kind", () => {
  for (const kind of ["assistant", "tool", "reasoning"]) {
    const id = generateItemId(kind);
    assert.match(id, new RegExp(`^${kind}_[0-9a-f]{20}$`));
  }
});

test("id generators produce unique values across repeated calls", () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    ids.add(generateTurnId());
  }
  assert.equal(ids.size, 50, "12-byte random ids must not collide in 50 calls");
});

test("buildTurnOverlapError returns the documented JSON-RPC error shape", () => {
  assert.deepEqual(buildTurnOverlapError(), {
    code: -32003,
    message: "A turn is already in flight on this thread",
  });
  assert.equal(TURN_OVERLAP_ERROR_CODE, -32003);
});

test("createFrameEmitter wraps notifications as one-line JSON-RPC frames", () => {
  const out = [];
  const { emitNotification } = createFrameEmitter((line) => out.push(line));
  emitNotification("turn/started", { threadId: "thr_x", turnId: "turn_y" });
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), {
    method: "turn/started",
    params: { threadId: "thr_x", turnId: "turn_y" },
  });
});

test("createFrameEmitter injects responses keyed to the request id", () => {
  const out = [];
  const { injectResponse } = createFrameEmitter((line) => out.push(line));
  injectResponse(42, { ok: true });
  assert.deepEqual(JSON.parse(out[0]), { id: 42, result: { ok: true } });
});

test("createFrameEmitter respondError omits frames when id is null/undefined", () => {
  // Server-initiated notifications have no id. respondError must not synthesize
  // a JSON-RPC error response in that case (no one is waiting for it).
  const out = [];
  const { respondError } = createFrameEmitter((line) => out.push(line));
  respondError(null, -32601, "ignored");
  respondError(undefined, -32601, "ignored");
  assert.equal(out.length, 0);
});

test("createFrameEmitter respondError uses the canonical error envelope", () => {
  const out = [];
  const { respondError } = createFrameEmitter((line) => out.push(line));
  respondError("req-1", -32603, "boom");
  assert.deepEqual(JSON.parse(out[0]), {
    id: "req-1",
    error: { code: -32603, message: "boom" },
  });
});

test("safeParseJson returns null for non-strings, malformed input, and empty input", () => {
  assert.equal(safeParseJson(null), null);
  assert.equal(safeParseJson(undefined), null);
  assert.equal(safeParseJson(42), null);
  assert.equal(safeParseJson(""), null);
  assert.equal(safeParseJson("not json"), null);
  assert.equal(safeParseJson("{"), null);
});

test("safeParseJson round-trips valid JSON", () => {
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(safeParseJson('[1,2,3]'), [1, 2, 3]);
});

test("readString returns the input when it is a non-empty string, otherwise empty", () => {
  assert.equal(readString("hello"), "hello");
  assert.equal(readString(""), "");
  assert.equal(readString(null), "");
  assert.equal(readString(undefined), "");
  assert.equal(readString(42), "");
  assert.equal(readString({}), "");
});

test("numberOr keeps finite numbers and falls back otherwise", () => {
  assert.equal(numberOr(0, 99), 0);
  assert.equal(numberOr(-1, 99), -1);
  assert.equal(numberOr(1.5, 99), 1.5);
  assert.equal(numberOr(NaN, 99), 99);
  assert.equal(numberOr(Infinity, 99), 99);
  assert.equal(numberOr("0", 99), 99);
  assert.equal(numberOr(null, 99), 99);
  assert.equal(numberOr(undefined, 99), 99);
});
