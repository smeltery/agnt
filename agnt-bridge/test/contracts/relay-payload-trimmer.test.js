// FILE: contracts/relay-payload-trimmer.test.js
// Purpose: Pins the thread-payload trim ladder used by
//          `sanitizeThreadHistoryImagesForRelay` and
//          `sanitizeThreadTurnsListForRelay`. The load-bearing rules:
//          1. Under-cap payloads pass through (no synthetic compaction
//             marker injected unnecessarily).
//          2. Over-cap thread payloads progressively drop older turns
//             until the payload fits, always re-prepending the
//             agnt-history-compacted summary so iOS can render the gap.
//          3. Over-cap turns-list payloads compact items one bucket at a
//             time until the page fits.
//          4. The synthetic compaction turn is suppressed when no turns
//             would be omitted (omittedTurnCount <= 0).
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RELAY_HISTORY_RECENT_TURN_TARGET,
  trimThreadPayloadForRelay,
  trimTurnsListPayloadForRelay,
  buildRelayHistoryCompactionTurn,
} = require("../../src/bridge/relay-payload-trimmer");

// ─── buildRelayHistoryCompactionTurn ────────────────────────────────────────

test("buildRelayHistoryCompactionTurn returns null when omittedTurnCount is zero", () => {
  assert.equal(buildRelayHistoryCompactionTurn(0, 5, { id: "t1" }), null);
});

test("buildRelayHistoryCompactionTurn returns null for negative omitted counts", () => {
  assert.equal(buildRelayHistoryCompactionTurn(-1, 5, { id: "t1" }), null);
});

test("buildRelayHistoryCompactionTurn synthesises a turn with the agnt-history-compacted marker", () => {
  const turn = buildRelayHistoryCompactionTurn(12, 3, { id: "thread-abc" });
  assert.match(turn.id, /^agnt-history-compacted-thread-abc/);
  assert.equal(turn.agntSynthetic, true);
  assert.equal(turn.agntHistoryCompacted, true);
  assert.equal(turn.agntOmittedTurnCount, 12);
  assert.equal(turn.agntKeptTurnCount, 3);
  const item = turn.items[0];
  assert.equal(item.role, "assistant");
  assert.match(item.text, /Older turns omitted: 12/);
  assert.match(item.text, /Recent turns kept: 3/);
});

test("buildRelayHistoryCompactionTurn falls back to 'history' base id when source has no usable id field", () => {
  const turn = buildRelayHistoryCompactionTurn(2, 1, {});
  assert.match(turn.id, /agnt-history-compacted-history$/);
});

// ─── trimThreadPayloadForRelay ──────────────────────────────────────────────

test("trimThreadPayloadForRelay returns null when payload has no thread.turns array", () => {
  assert.equal(trimThreadPayloadForRelay({ result: { thread: null } }), null);
  assert.equal(trimThreadPayloadForRelay({ result: {} }), null);
  assert.equal(trimThreadPayloadForRelay(null), null);
});

test("trimThreadPayloadForRelay returns null when an under-cap payload is already small (implicit thread)", () => {
  // explicitThread === undefined → returns null when payload is under cap,
  // signalling the caller "no rewrite needed".
  const small = {
    id: "r1",
    result: {
      thread: {
        id: "t1",
        turns: [{ id: "turn-1", items: [{ type: "message", text: "hi" }] }],
      },
    },
  };
  assert.equal(trimThreadPayloadForRelay(small), null);
});

test("trimThreadPayloadForRelay returns the encoded payload when an under-cap thread is passed explicitly", () => {
  const small = {
    id: "r1",
    result: { thread: { id: "t1", turns: [{ id: "turn-1", items: [] }] } },
  };
  const out = trimThreadPayloadForRelay(small, small.result.thread);
  assert.ok(typeof out === "string" && out.length > 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.result.thread.id, "t1");
});

test("trimThreadPayloadForRelay preserves pre-omitted turn counts when the working window fits", () => {
  const parsed = {
    id: "r-pre-omitted",
    result: {
      thread: {
        id: "t-pre-omitted",
        turns: [
          { id: "turn-new-1", items: [{ id: "item-new-1", type: "message", text: "new 1" }] },
          { id: "turn-new-2", items: [{ id: "item-new-2", type: "message", text: "new 2" }] },
        ],
      },
    },
  };

  const out = trimThreadPayloadForRelay(parsed, undefined, {
    preOmittedTurnCount: 3,
    compactionIdSource: { id: "turn-old-1" },
  });
  assert.ok(out != null);
  const rewritten = JSON.parse(out);

  assert.equal(rewritten.result.thread.agntHistoryCompacted, true);
  assert.equal(rewritten.result.thread.agntOmittedTurnCount, 3);
  assert.equal(rewritten.result.thread.agntKeptTurnCount, 2);
  assert.deepEqual(
    rewritten.result.thread.turns.map((turn) => turn.id),
    ["agnt-history-compacted-turn-old-1", "turn-new-1", "turn-new-2"]
  );
});

test("trimThreadPayloadForRelay drops older turns and prepends the agnt-history-compacted marker when over cap", () => {
  // Build a payload that's deliberately oversized: lots of turns each with a
  // big text item so the encoded size exceeds the 4 MiB soft cap.
  const bigText = "x".repeat(200_000); // 200 KB per turn
  const turns = [];
  for (let i = 0; i < 30; i += 1) {
    turns.push({
      id: `turn-${i}`,
      items: [{ id: `item-${i}`, type: "message", text: bigText }],
    });
  }
  const parsed = { id: "r2", result: { thread: { id: "t-big", turns } } };
  const encoded = trimThreadPayloadForRelay(parsed);
  assert.ok(encoded != null, "must rewrite an over-cap payload");
  const rewritten = JSON.parse(encoded);
  const rewrittenTurns = rewritten.result.thread.turns;
  // First turn must be the synthetic compaction marker, not a real turn.
  assert.equal(rewrittenTurns[0].agntSynthetic, true);
  assert.equal(rewrittenTurns[0].agntHistoryCompacted, true);
  // Thread itself must carry the compacted-history markers.
  assert.equal(rewritten.result.thread.historyTailTruncatedForRelay, true);
  assert.equal(rewritten.result.thread.agntHistoryCompacted, true);
  assert.ok(rewritten.result.thread.agntOmittedTurnCount > 0);
});

test("trimThreadPayloadForRelay keeps no more than RELAY_HISTORY_RECENT_TURN_TARGET turns on the first compaction pass", () => {
  assert.equal(RELAY_HISTORY_RECENT_TURN_TARGET, 40);
  // Verify that a long, easily-shrinkable thread doesn't keep more than the
  // target. We use small per-turn payloads so the pass converges at the
  // 40-turn step rather than the per-item drop step.
  const turns = [];
  for (let i = 0; i < 100; i += 1) {
    turns.push({
      id: `turn-${i}`,
      // ~50 KB per turn x 100 = ~5 MB, just above the 4 MiB cap.
      items: [{ id: `i-${i}`, type: "message", text: "y".repeat(50_000) }],
    });
  }
  const parsed = { id: "r3", result: { thread: { id: "t-100", turns } } };
  const out = trimThreadPayloadForRelay(parsed);
  assert.ok(out != null);
  const rewritten = JSON.parse(out);
  // turns[0] is the synthetic marker; real turns follow. Total length must be
  // <= RELAY_HISTORY_RECENT_TURN_TARGET + 1 (the synthetic prepend).
  assert.ok(
    rewritten.result.thread.turns.length <= RELAY_HISTORY_RECENT_TURN_TARGET + 1,
    `expected ≤ ${RELAY_HISTORY_RECENT_TURN_TARGET + 1} turns, got ${rewritten.result.thread.turns.length}`,
  );
});

// ─── trimTurnsListPayloadForRelay ───────────────────────────────────────────

test("trimTurnsListPayloadForRelay returns the original raw message when payload is under cap", () => {
  const parsed = { id: "r4", result: { data: [{ id: "t1", items: [] }] } };
  const raw = JSON.stringify(parsed);
  assert.equal(trimTurnsListPayloadForRelay(parsed, "data", raw), raw);
});

test("trimTurnsListPayloadForRelay returns encoded payload when no original raw message is supplied and payload is under cap", () => {
  const parsed = { id: "r5", result: { data: [{ id: "t1", items: [] }] } };
  const out = trimTurnsListPayloadForRelay(parsed, "data", null);
  const reparsed = JSON.parse(out);
  assert.equal(reparsed.id, "r5");
});

test("trimTurnsListPayloadForRelay returns the original raw payload when result.turns is missing/non-array", () => {
  const parsed = { id: "r6", result: { somethingElse: 1 } };
  const raw = JSON.stringify(parsed);
  assert.equal(trimTurnsListPayloadForRelay(parsed, "data", raw), raw);
});

test("trimTurnsListPayloadForRelay compacts oversized turns and marks the payload", () => {
  const bigText = "z".repeat(200_000);
  const turns = [];
  for (let i = 0; i < 30; i += 1) {
    turns.push({ id: `t-${i}`, items: [{ id: `i-${i}`, type: "message", text: bigText }] });
  }
  const parsed = { id: "r7", result: { data: turns } };
  const out = trimTurnsListPayloadForRelay(parsed, "data", null);
  const rewritten = JSON.parse(out);
  assert.equal(rewritten.result.agntPageCompactedForRelay, true);
  // Every turn must carry the page-compacted marker.
  for (const turn of rewritten.result.data) {
    assert.equal(turn.agntPageCompactedForRelay, true);
  }
});
