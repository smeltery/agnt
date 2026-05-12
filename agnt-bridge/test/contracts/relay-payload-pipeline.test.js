// FILE: contracts/relay-payload-pipeline.test.js
// Purpose: Pins the entry-point dispatcher that bridge.js calls on every
//          relay-bound message. Three load-bearing rules:
//          1. Non-thread/* requests pass through unchanged (only
//             thread/read, thread/resume, thread/turns/list trigger work).
//          2. thread/read + thread/resume share the same code path:
//             sanitize history turns (image annotation + inline-image
//             elision + compaction blob drop) → trim to fit under cap.
//          3. thread/turns/list runs the turns-list variant that walks the
//             page's data/items/turns key.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeThreadHistoryImagesForRelay,
  sanitizeThreadTurnsListForRelay,
  sanitizeRelayHistoryTurns,
  sanitizeRelayHistoryTurn,
} = require("../../src/bridge/relay-payload-pipeline");

// ─── dispatcher behaviour ───────────────────────────────────────────────────

test("sanitizeThreadHistoryImagesForRelay passes non-thread/* requests through unchanged", () => {
  const raw = JSON.stringify({ id: "r1", result: { thread: { id: "t", turns: [] } } });
  assert.equal(sanitizeThreadHistoryImagesForRelay(raw, "account/status/read"), raw);
  assert.equal(sanitizeThreadHistoryImagesForRelay(raw, "thread/started"), raw);
  assert.equal(sanitizeThreadHistoryImagesForRelay(raw, "turn/started"), raw);
});

test("sanitizeThreadHistoryImagesForRelay leaves payloads without a thread.turns array unchanged", () => {
  const raw = JSON.stringify({ id: "r1", result: { thread: { id: "t" } } });
  assert.equal(sanitizeThreadHistoryImagesForRelay(raw, "thread/read"), raw);
  const noThread = JSON.stringify({ id: "r2", result: {} });
  assert.equal(sanitizeThreadHistoryImagesForRelay(noThread, "thread/read"), noThread);
});

test("sanitizeThreadHistoryImagesForRelay treats thread/read and thread/resume the same way", () => {
  const raw = JSON.stringify({
    id: "r1",
    result: { thread: {
      id: "t1",
      turns: [{ id: "turn-1", items: [{ id: "i1", type: "message", text: "hi" }] }],
    } },
  });
  assert.equal(
    sanitizeThreadHistoryImagesForRelay(raw, "thread/read"),
    sanitizeThreadHistoryImagesForRelay(raw, "thread/resume"),
  );
});

test("sanitizeThreadHistoryImagesForRelay routes thread/turns/list to the page variant", () => {
  // The page variant walks result.data/items/turns rather than result.thread.turns.
  const raw = JSON.stringify({
    id: "r1",
    result: { data: [{ id: "turn-1", items: [{ id: "i1", type: "message", text: "hi" }] }] },
  });
  const out = sanitizeThreadHistoryImagesForRelay(raw, "thread/turns/list");
  // No images / oversized payloads → output equals raw (no work needed)
  assert.equal(out, raw);
});

test("sanitizeThreadHistoryImagesForRelay elides inline data: image URLs in history content", () => {
  const raw = JSON.stringify({
    id: "r1",
    result: { thread: {
      id: "t-img",
      turns: [{
        id: "turn-1",
        items: [{
          id: "i1",
          type: "message",
          content: [{ type: "input_image", url: "data:image/png;base64,AAA" }],
        }],
      }],
    } },
  });
  const out = sanitizeThreadHistoryImagesForRelay(raw, "thread/read");
  // The inline data: URL must be gone from anywhere in the payload, and the
  // agnt:// elision placeholder must appear in its place.
  assert.equal(out.includes("data:image/png"), false, "inline data URL must be elided");
  assert.equal(out.includes("agnt://history-image-elided"), true, "placeholder must be present");
});

test("sanitizeThreadTurnsListForRelay returns rawMessage when no turns key is present", () => {
  const raw = JSON.stringify({ id: "r1", result: { somethingElse: 1 } });
  assert.equal(sanitizeThreadTurnsListForRelay(raw), raw);
});

test("sanitizeThreadTurnsListForRelay returns rawMessage when result is malformed", () => {
  const raw = JSON.stringify({ id: "r1", result: null });
  assert.equal(sanitizeThreadTurnsListForRelay(raw), raw);
});

test("sanitizeThreadTurnsListForRelay walks the data/items/turns key in order", () => {
  // If both `data` and `items` are present arrays, the implementation picks
  // `data` first (per RELAY_TURNS_LIST_RESULT_KEYS order).
  const raw = JSON.stringify({
    id: "r1",
    result: {
      data: [{ id: "turn-d", items: [] }],
      items: [{ id: "turn-i", items: [] }],
    },
  });
  const out = sanitizeThreadTurnsListForRelay(raw);
  // Same payload (no sanitization needed) — should be ===
  assert.equal(out, raw);
});

// ─── sanitizeRelayHistoryTurn(s) ────────────────────────────────────────────

test("sanitizeRelayHistoryTurns preserves identity when nothing changes", () => {
  const turns = [
    { id: "t1", items: [{ id: "i1", type: "message", text: "hi" }] },
    { id: "t2", items: [{ id: "i2", type: "message", text: "bye" }] },
  ];
  const out = sanitizeRelayHistoryTurns(turns, "thread-1");
  assert.equal(out.didSanitize, false);
  // Each turn unchanged → same identity
  for (let i = 0; i < turns.length; i += 1) {
    assert.equal(out.turns[i], turns[i]);
  }
});

test("sanitizeRelayHistoryTurns flips didSanitize when any item changes", () => {
  // sanitizeRelayHistoryTurn only mutates an item if it touches the item's
  // content array (input_image / image / output_image with a data: URL) or
  // it's a generated-image type or a compaction item. A bare top-level
  // input_image does nothing — the content array is what gets walked.
  const turns = [
    { id: "t1", items: [{ id: "i1", type: "message", text: "hi" }] },
    { id: "t2", items: [{
      id: "i2",
      type: "message",
      content: [{ type: "input_image", url: "data:image/png;base64,YYY" }],
    }] },
  ];
  const out = sanitizeRelayHistoryTurns(turns, "thread-1");
  assert.equal(out.didSanitize, true);
  // First turn untouched (preserves identity), second turn rebuilt
  assert.equal(out.turns[0], turns[0]);
  assert.notEqual(out.turns[1], turns[1]);
});

test("sanitizeRelayHistoryTurn preserves identity for turns without items array", () => {
  const malformed = { id: "t1" };
  assert.equal(sanitizeRelayHistoryTurn(malformed, "thread-1"), malformed);
  const arrayLike = [];
  assert.equal(sanitizeRelayHistoryTurn(arrayLike, "thread-1"), arrayLike);
  assert.equal(sanitizeRelayHistoryTurn(null, "thread-1"), null);
});

test("sanitizeRelayHistoryTurn falls back to turn.threadId when the outer threadId is empty", () => {
  // Build a generated-image item that needs the thread id for saved_path —
  // verify the per-turn fallback works when the outer sanitizer doesn't know it.
  const turn = {
    id: "t1",
    threadId: "thread-from-turn",
    items: [{
      id: "ig_42",
      type: "image_generation_call",
      result: "BIG_BASE64_BLOB",
    }],
  };
  const sanitized = sanitizeRelayHistoryTurn(turn, "");
  const item = sanitized.items[0];
  assert.match(item.saved_path, /thread-from-turn/);
  assert.match(item.saved_path, /ig_42\.png$/);
  assert.equal(item.result, undefined);
  assert.equal(item.result_elided_for_relay, true);
});
