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
  sanitizeLiveContextualUserItemForRelay,
  sanitizeLiveUserNotification,
  sanitizeThreadHistoryImagesForRelay,
  sanitizeThreadTurnsListForRelay,
  sanitizeRelayHistoryTurns,
  sanitizeRelayHistoryTurn,
} = require("../../src/bridge/relay-payload-pipeline");
const {
  RELAY_HISTORY_RECENT_TURN_TARGET,
} = require("../../src/bridge/relay-payload-trimmer");

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

test("sanitizeThreadHistoryImagesForRelay drops injected context user items from thread history", () => {
  const raw = JSON.stringify({
    id: "r-context",
    result: { thread: {
      id: "thread-context",
      turns: [{
        id: "turn-1",
        items: [
          {
            id: "ctx-agents",
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "# AGENTS.md instructions for /Users/me/project\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>",
            }],
          },
          {
            id: "ctx-env",
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<environment_context>\n  <cwd>/Users/me/project</cwd>\n</environment_context>",
            }],
          },
          {
            id: "ctx-internal-goal",
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<codex_internal_context source=\"goal\">\nhidden goal state\n</codex_internal_context>",
            }],
          },
          {
            id: "real-user",
            type: "user_message",
            content: [{ type: "input_text", text: "Summarize the diff" }],
          },
          {
            id: "assistant",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        ],
      }],
    } },
  });

  const out = JSON.parse(sanitizeThreadHistoryImagesForRelay(raw, "thread/read"));
  assert.deepEqual(
    out.result.thread.turns[0].items.map((item) => item.id),
    ["real-user", "assistant"]
  );
});

test("sanitizeThreadHistoryImagesForRelay sanitizes mixed user content entry-by-entry", () => {
  const raw = JSON.stringify({
    id: "r-mixed-context",
    result: { thread: {
      id: "thread-mixed-context",
      turns: [{
        id: "turn-1",
        items: [{
          id: "item-mixed",
          type: "user_message",
          content: [
            { type: "input_text", text: "<environment_context>secret</environment_context>" },
            {
              type: "input_text",
              text: "## Code review guidelines:\ninternal review text\n## My request for Codex:\nReview this file",
            },
            { type: "input_text", text: "<image name=[Image #1] path=\"/tmp/private.png\">" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_text", text: "</image>" },
          ],
        }],
      }],
    } },
  });

  const out = JSON.parse(sanitizeThreadHistoryImagesForRelay(raw, "thread/read"));
  assert.deepEqual(out.result.thread.turns[0].items[0].content, [
    { type: "input_text", text: "Review this file" },
    { type: "input_image", url: "agnt://history-image-elided" },
  ]);
});

test("sanitizeThreadTurnsListForRelay drops injected context user items from pages", () => {
  const raw = JSON.stringify({
    id: "r-context-page",
    result: {
      data: [{
        id: "turn-1",
        items: [
          {
            id: "ctx-internal",
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<codex_internal_context source=\"goal\">\nContinue working.\n</codex_internal_context>",
            }],
          },
          {
            id: "real-user",
            type: "user_message",
            text: "Continue",
          },
        ],
      }],
    },
  });

  const out = JSON.parse(sanitizeThreadTurnsListForRelay(raw));
  assert.deepEqual(out.result.data[0].items.map((item) => item.id), ["real-user"]);
});

test("sanitizeThreadHistoryImagesForRelay converts historical apply_patch calls to fileChange items", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.js",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const raw = JSON.stringify({
    id: "r-apply-patch-history",
    result: { thread: {
      id: "thread-apply-patch-history",
      turns: [{
        id: "turn-1",
        items: [{
          id: "call-apply-patch",
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-1",
          input: patch,
          status: "completed",
        }],
      }],
    } },
  });

  const out = JSON.parse(sanitizeThreadHistoryImagesForRelay(raw, "thread/read"));
  const item = out.result.thread.turns[0].items[0];
  assert.equal(item.id, "call-1");
  assert.equal(item.type, "fileChange");
  assert.equal(item.status, "completed");
  assert.deepEqual(item.changes.map((change) => ({
    path: change.path,
    kind: change.kind,
    additions: change.additions,
    deletions: change.deletions,
  })), [{
    path: "src/app.js",
    kind: "update",
    additions: 1,
    deletions: 1,
  }]);
  assert.match(item.changes[0].diff, /diff --git a\/src\/app\.js b\/src\/app\.js/);
});

test("sanitizeLiveContextualUserItemForRelay drops injected live user item notifications", () => {
  const raw = JSON.stringify({
    method: "item/updated",
    params: {
      item: {
        id: "ctx-live",
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "# AGENTS.md instructions for /Users/me/project\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
        }],
      },
    },
  });

  assert.equal(sanitizeLiveContextualUserItemForRelay(raw), null);
});

test("sanitizeLiveContextualUserItemForRelay preserves real live user item notifications", () => {
  const raw = JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        id: "real-live",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Add tests" }],
      },
    },
  });

  assert.equal(sanitizeLiveContextualUserItemForRelay(raw), raw);
});

test("sanitizeLiveUserNotification filters fallback context and rewrites visible envelopes", () => {
  assert.equal(sanitizeLiveUserNotification({
    method: "codex/event/user_message",
    params: {
      threadId: "t",
      message: "<codex_internal_context source=\"goal\">secret</codex_internal_context>",
    },
  }), null);

  const heartbeat = sanitizeLiveUserNotification({
    method: "codex/event/user_message",
    params: {
      threadId: "t",
      message: "<heartbeat><automation_id>private</automation_id><instructions>Check CI.</instructions></heartbeat>",
    },
  });
  assert.equal(heartbeat.params.message, "Check CI.");

  const mixedItem = sanitizeLiveUserNotification({
    method: "item/completed",
    params: {
      threadId: "t",
      item: {
        id: "mixed",
        type: "userMessage",
        content: [
          { type: "input_text", text: "<environment_context>secret</environment_context>" },
          { type: "input_text", text: "keep me" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    },
  });
  assert.deepEqual(mixedItem.params.item.content, [
    { type: "input_text", text: "keep me" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
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

test("sanitizeThreadHistoryImagesForRelay pre-trims oversized old image turns before sanitation", () => {
  const oldImage = `data:image/png;base64,${"A".repeat(900_000)}`;
  const turns = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `old-turn-${index + 1}`,
      items: [{
        id: `old-item-${index + 1}`,
        type: "user_message",
        content: [{ type: "input_image", url: oldImage }],
      }],
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `new-turn-${index + 1}`,
      items: [{ id: `new-item-${index + 1}`, type: "message", text: `reply ${index + 1}` }],
    })),
  ];
  const raw = JSON.stringify({
    id: "r-pretrim-images",
    result: {
      thread: {
        id: "thread-pretrim-images",
        turns,
      },
    },
  });

  const out = sanitizeThreadHistoryImagesForRelay(raw, "thread/read");
  const rewritten = JSON.parse(out);

  assert.equal(out.includes("data:image/png"), false, "oversized image data must not remain");
  assert.equal(
    out.includes("agnt://history-image-elided"),
    false,
    "old oversized image turns should be omitted instead of sanitized and kept"
  );
  assert.equal(rewritten.result.thread.agntHistoryCompacted, true);
  assert.equal(
    rewritten.result.thread.agntOmittedTurnCount,
    turns.length - RELAY_HISTORY_RECENT_TURN_TARGET
  );
  assert.equal(rewritten.result.thread.agntKeptTurnCount, RELAY_HISTORY_RECENT_TURN_TARGET);
  assert.deepEqual(
    rewritten.result.thread.turns.map((turn) => turn.id),
    [
      "agnt-history-compacted-old-turn-1",
      ...turns.slice(-RELAY_HISTORY_RECENT_TURN_TARGET).map((turn) => turn.id),
    ]
  );
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
