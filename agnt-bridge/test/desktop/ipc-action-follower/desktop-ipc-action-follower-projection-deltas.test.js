// FILE: desktop-ipc-action-follower-projection-deltas.test.js
// Purpose: Verifies Desktop IPC state patch and assistant delta projection helpers.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, desktop-ipc-action-follower


const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
  applyConversationStateChange,
  buildDesktopTurnsListResult,
  createDesktopIpcActionFollower,
  desktopFollowerPayloadForResponse,
  projectDesktopAssistantDeltaNotifications,
  projectPendingDesktopActions,
  seedConversationStateFromThreadRead,
} = require("../../../src/desktop/desktop-ipc-action-follower");

test("rejects malformed or failed desktop action responses instead of defaulting to accept", () => {
  assert.equal(
    desktopFollowerPayloadForResponse({
      requestId: "req-command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-command",
      error: { code: -32603, message: "User cancelled" },
    }),
    null
  );

  assert.equal(
    desktopFollowerPayloadForResponse({
      requestId: "req-command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-command",
      result: {},
    }),
    null
  );

  assert.equal(
    desktopFollowerPayloadForResponse({
      requestId: "req-user-input",
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
    }, {
      id: "req-user-input",
      result: {},
    }),
    null
  );
});

test("applies desktop IPC snapshots and Immer-style request patches", () => {
  const snapshot = applyConversationStateChange(null, {
    type: "snapshot",
    conversationState: {
      requests: [{
        id: "req-1",
        method: "item/tool/requestUserInput",
        params: {
          questions: [{ id: "q1", question: "Continue?" }],
        },
      }],
    },
  });

  const patched = applyConversationStateChange(snapshot, {
    type: "patches",
    patches: [{
      op: "replace",
      path: ["requests", 0, "completed"],
      value: true,
    }],
  });

  assert.equal(snapshot.requests[0].completed, undefined);
  assert.equal(patched.requests[0].completed, true);
  assert.deepEqual(projectPendingDesktopActions("thread-1", patched), []);
});

test("seeds conversation state from thread/read responses for IPC recovery", () => {
  assert.deepEqual(
    seedConversationStateFromThreadRead({
      thread: {
        turns: [{ id: "turn-1", items: [] }],
      },
    }),
    {
      turns: [{ id: "turn-1", items: [] }],
      requests: [],
    }
  );

  assert.deepEqual(
    seedConversationStateFromThreadRead({
      conversationState: {
        requests: [{ id: "req-1" }],
      },
    }),
    {
      requests: [{ id: "req-1" }],
    }
  );
});

test("projects only appended assistant text as live app-server deltas", () => {
  const previousState = {
    turns: [{
      id: "turn-1",
      items: [{
        id: "assistant-1",
        type: "assistant_message",
        text: "Hello",
      }],
    }],
  };
  const nextState = {
    turns: [{
      id: "turn-1",
      items: [{
        id: "assistant-1",
        type: "assistant_message",
        text: "Hello world",
      }],
    }],
  };

  assert.deepEqual(
    projectDesktopAssistantDeltaNotifications("thread-1", previousState, nextState),
    [{
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "assistant-1",
        delta: " world",
      },
    }]
  );
});

test("projects canonical desktop agentMessage items as live app-server deltas", () => {
  const previousState = {
    turns: [{
      id: "turn-agent-message",
      items: [{
        id: "agent-message-1",
        type: "agentMessage",
        text: "Hello",
      }],
    }],
  };
  const nextState = {
    turns: [{
      id: "turn-agent-message",
      items: [{
        id: "agent-message-1",
        type: "agentMessage",
        text: "Hello world",
      }],
    }],
  };

  assert.deepEqual(
    projectDesktopAssistantDeltaNotifications("thread-agent-message", previousState, nextState),
    [{
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-agent-message",
        turnId: "turn-agent-message",
        itemId: "agent-message-1",
        delta: " world",
      },
    }]
  );
});

test("does not replay unchanged or rewritten assistant text as live deltas", () => {
  const previousState = {
    turns: [{
      id: "turn-1",
      items: [
        {
          id: "assistant-same",
          type: "assistant_message",
          text: "same",
        },
        {
          id: "assistant-rewrite",
          type: "assistant_message",
          text: "draft",
        },
      ],
    }],
  };
  const nextState = {
    turns: [{
      id: "turn-1",
      items: [
        {
          id: "assistant-same",
          type: "assistant_message",
          text: "same",
        },
        {
          id: "assistant-rewrite",
          type: "assistant_message",
          text: "final",
        },
      ],
    }],
  };

  assert.deepEqual(
    projectDesktopAssistantDeltaNotifications("thread-1", previousState, nextState),
    []
  );
});
