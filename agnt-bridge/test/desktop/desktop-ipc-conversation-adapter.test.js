// FILE: desktop-ipc-conversation-adapter.test.js
// Purpose: Verifies Desktop IPC conversation state adaptation for Desktop rendering.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/desktop/desktop-ipc-conversation-adapter

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationStateFromThread,
  synchronizeDesktopConversationCompatibility,
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

test("conversation adapter publishes current Desktop canonical history with iterable phone settings", () => {
  const state = buildConversationStateFromThread({
    id: "thread-phone-desktop",
    cwd: "/Users/me/project",
    modelProvider: "openai",
    turns: [{
      id: "turn-phone-desktop",
      status: "inProgress",
      startedAt: 5,
      items: [{ id: "assistant", type: "agentMessage", text: "working" }],
    }],
  }, {
    previous: {
      turns: [{
        id: "turn-phone-desktop",
        turnId: "turn-phone-desktop",
        params: {
          threadId: "thread-phone-desktop",
          cwd: "/Users/me/project",
          input: [{ type: "image", url: "data:image/jpeg;base64,abc" }],
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: {
            type: "workspaceWrite",
            networkAccess: true,
          },
        },
        items: [],
      }],
    },
    now: () => 9_000,
  });

  synchronizeDesktopConversationCompatibility(state);

  assert.deepEqual(state.turns[0].params.attachments, []);
  assert.deepEqual(state.turns[0].params.sandboxPolicy, {
    type: "workspaceWrite",
    networkAccess: true,
    writableRoots: [],
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
  });
  assert.equal(state.turnHistory.kind, "canonical");
  assert.deepEqual(state.turnHistory.history.islands[0].entries, [{
    key: "turn:turn-phone-desktop",
    value: "turn:turn-phone-desktop",
  }]);
  assert.equal(
    state.turnHistory.history.entitiesByKey["turn:turn-phone-desktop"].turnId,
    "turn-phone-desktop"
  );
  assert.equal(state.turnHistory.history.isComplete, true);
  assert.deepEqual(state.currentPermissions.runtimeWorkspaceRoots, []);
  assert.deepEqual(state.currentPermissions.sandboxPolicy.writableRoots, []);
});
