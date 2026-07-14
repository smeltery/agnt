// FILE: bridge-history-trimmer.test.js
// Purpose: Verifies relay thread history compaction and oversized text trimming.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/bridge/bridge, ../../src/bridge/relay-payload-trimmer

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeThreadHistoryImagesForRelay } = require("../../src/bridge/bridge");
const {
  RELAY_HISTORY_RECENT_TURN_TARGET,
} = require("../../src/bridge/relay-payload-trimmer");

test("sanitizeThreadHistoryImagesForRelay strips bulky compaction replacement history", () => {
  const rawMessage = JSON.stringify({
    id: "req-thread-resume",
    result: {
      thread: {
        id: "thread-compaction",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-compaction",
                type: "context_compaction",
                payload: {
                  message: "",
                  replacement_history: [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "very old transcript" }],
                    },
                  ],
                },
              },
              {
                id: "item-compaction-camel",
                type: "contextCompaction",
                replacementHistory: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "older prompt" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  const sanitized = JSON.parse(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "thread/resume")
  );
  const items = sanitized.result.thread.turns[0].items;

  assert.deepEqual(items[0], {
    id: "item-compaction",
    type: "context_compaction",
    payload: {
      message: "",
    },
  });
  assert.deepEqual(items[1], {
    id: "item-compaction-camel",
    type: "contextCompaction",
  });
});

test("sanitizeThreadHistoryImagesForRelay compacts oversized history before the newest turn tail", () => {
  const largeText = "A".repeat(4 * 1024 * 1024);
  const rawMessage = JSON.stringify({
    id: "req-thread-tail",
    result: {
      thread: {
        id: "thread-large-history",
        turns: [
          {
            id: "turn-old",
            items: [
              {
                id: "item-old",
                type: "assistant_message",
                text: largeText,
              },
            ],
          },
          {
            id: "turn-new",
            items: [
              {
                id: "item-new",
                type: "assistant_message",
                text: "latest reply",
              },
            ],
          },
        ],
      },
    },
  });

  const sanitized = JSON.parse(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "thread/read")
  );

  assert.equal(sanitized.result.thread.historyTailTruncatedForRelay, true);
  assert.equal(sanitized.result.thread.agntHistoryCompacted, true);
  assert.equal(sanitized.result.thread.agntOmittedTurnCount, 1);
  assert.equal(sanitized.result.thread.agntKeptTurnCount, 1);
  assert.deepEqual(
    sanitized.result.thread.turns.map((turn) => turn.id),
    ["agnt-history-compacted-turn-old", "turn-new"]
  );
  assert.equal(
    sanitized.result.thread.turns[0].items[0].text.includes("Older turns omitted: 1"),
    true
  );
});

test("sanitizeThreadHistoryImagesForRelay keeps the configured recent turn window when compacting", () => {
  const largeText = "A".repeat(900 * 1024);
  const turns = Array.from({ length: 45 }, (_, index) => ({
    id: `turn-${index + 1}`,
    items: [
      {
        id: `item-${index + 1}`,
        type: "assistant_message",
        text: index < 5 ? largeText : `reply ${index + 1}`,
      },
    ],
  }));
  const rawMessage = JSON.stringify({
    id: "req-thread-recent-window",
    result: {
      thread: {
        id: "thread-recent-window",
        turns,
      },
    },
  });

  const sanitized = JSON.parse(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "thread/read")
  );

  assert.equal(sanitized.result.thread.agntHistoryCompacted, true);
  assert.equal(
    sanitized.result.thread.agntOmittedTurnCount,
    turns.length - RELAY_HISTORY_RECENT_TURN_TARGET
  );
  assert.equal(sanitized.result.thread.agntKeptTurnCount, RELAY_HISTORY_RECENT_TURN_TARGET);
  assert.deepEqual(
    sanitized.result.thread.turns.map((turn) => turn.id),
    [
      "agnt-history-compacted-turn-1",
      ...turns.slice(-RELAY_HISTORY_RECENT_TURN_TARGET).map((turn) => turn.id),
    ]
  );
});

test("sanitizeThreadHistoryImagesForRelay truncates the newest oversized text item to its tail", () => {
  const largeText = `header\n${"B".repeat(4 * 1024 * 1024)}`;
  const rawMessage = JSON.stringify({
    id: "req-thread-text-tail",
    result: {
      thread: {
        id: "thread-large-item",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-1",
                type: "assistant_message",
                text: largeText,
              },
            ],
          },
        ],
      },
    },
  });

  const sanitized = JSON.parse(
    sanitizeThreadHistoryImagesForRelay(rawMessage, "thread/read")
  );
  const item = sanitized.result.thread.turns[0].items[0];

  assert.equal(sanitized.result.thread.historyTailTruncatedForRelay, true);
  assert.equal(item.relayTextTailTruncated, true);
  assert.equal(item.text.startsWith("…\n"), true);
  assert.equal(item.text.includes("header"), false);
});
