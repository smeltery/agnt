// FILE: desktop-ipc-conversation-adapter.test.js
// Purpose: Verifies Desktop IPC conversation state adaptation for Desktop rendering.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/desktop/desktop-ipc-conversation-adapter

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationStateFromThread,
} = require("../../src/desktop/desktop-ipc-conversation-adapter");

test("conversation adapter supplies receiverThreads required by Desktop collab rendering", () => {
  const state = buildConversationStateFromThread({
    id: "thread-collab-compatibility",
    cwd: "/Users/me/proj",
    turns: [{
      id: "turn-collab-compatibility",
      status: "completed",
      items: [{
        id: "collab-send-message",
        type: "collabAgentToolCall",
        tool: "send_message",
        status: "completed",
        receiverThreadIds: ["thread-child-a", "thread-child-b"],
        agentsStates: {},
      }],
    }],
  });

  assert.deepEqual(
    state.turns[0].items[0].receiverThreads,
    [{ threadId: "thread-child-a" }, { threadId: "thread-child-b" }]
  );
});
