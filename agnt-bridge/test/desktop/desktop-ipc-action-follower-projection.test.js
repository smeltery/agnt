// FILE: desktop-ipc-action-follower-projection.test.js
// Purpose: Verifies Desktop IPC projection helpers without opening IPC sockets.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/desktop/desktop-ipc-action-follower

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
} = require("../../src/desktop/desktop-ipc-action-follower");

test("desktop turns/list returns newest-first pages without reversing reopen history", () => {
  const chronologicalTurns = [
    { id: "turn-1", items: [{ id: "message-1", type: "agentMessage", text: "one" }] },
    { id: "turn-2", items: [{ id: "message-2", type: "agentMessage", text: "two" }] },
    { id: "turn-3", items: [{ id: "message-3", type: "agentMessage", text: "three" }] },
  ];

  const firstPage = buildDesktopTurnsListResult(chronologicalTurns, {
    sortDirection: "desc",
    limit: 2,
  });
  assert.deepEqual(firstPage.data.map((turn) => turn.id), ["turn-3", "turn-2"]);
  assert.equal(Object.hasOwn(firstPage, "turns"), false);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const secondPage = buildDesktopTurnsListResult(chronologicalTurns, {
    sortDirection: "desc",
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(secondPage.data.map((turn) => turn.id), ["turn-1"]);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextCursor, null);

  const streamingGrowth = structuredClone(chronologicalTurns);
  streamingGrowth[2].items[0].text = "three, still streaming";
  const pageAfterStreamingGrowth = buildDesktopTurnsListResult(streamingGrowth, {
    sortDirection: "desc",
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(pageAfterStreamingGrowth.data.map((turn) => turn.id), ["turn-1"]);

  const itemGrowth = structuredClone(chronologicalTurns);
  itemGrowth[2].items.push({ id: "tool-3", type: "toolCall", text: "running" });
  const pageAfterNonUserItemGrowth = buildDesktopTurnsListResult(itemGrowth, {
    sortDirection: "desc",
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(pageAfterNonUserItemGrowth.data.map((turn) => turn.id), ["turn-1"]);

  const changedSnapshot = buildDesktopTurnsListResult(
    chronologicalTurns.filter((turn) => turn.id !== "turn-2"),
    {
      sortDirection: "desc",
      limit: 2,
      cursor: firstPage.nextCursor,
    }
  );
  assert.equal(changedSnapshot, null);

  const prependedSnapshot = buildDesktopTurnsListResult(
    [{ id: "turn-x", items: [{ id: "message-x" }] }, ...chronologicalTurns],
    {
      sortDirection: "desc",
      limit: 2,
      cursor: firstPage.nextCursor,
    }
  );
  assert.equal(prependedSnapshot, null);
});

test("desktop turns/list private cursors never fall through to app-server", (t) => {
  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath: path.join(os.tmpdir(), `missing-agnt-${Date.now()}-${process.pid}.sock`),
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
  });
  t.after(() => follower.stopAll());

  const handled = follower.observeInbound(JSON.stringify({
    id: "private-cursor-read",
    method: "thread/turns/list",
    params: {
      threadId: "thread-with-expired-desktop-page",
      cursor: "agnt-desktop-turns:desc:id:missing-turn",
    },
  }));

  assert.equal(handled, true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].id, "private-cursor-read");
  assert.equal(outbound[0].error.code, -32602);
});

test("projects desktop pending user input as an app-server request shape", () => {
  const actions = projectPendingDesktopActions("thread-1", {
    requests: [{
      id: "req-user-input",
      method: "item/tool/requestUserInput",
      completed: false,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{
          id: "q1",
          header: "Mode",
          question: "Choose one",
          isOther: true,
          options: [{ label: "Yes", description: "Continue" }],
        }],
      },
    }],
  });

  assert.deepEqual(actions, [{
    id: "req-user-input",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      agntActionSource: "desktop-ipc-action-follower",
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      questions: [{
        id: "q1",
        header: "Mode",
        question: "Choose one",
        isOther: true,
        options: [{ label: "Yes", description: "Continue" }],
      }],
    },
  }]);
});

test("projects command, file, and permission approvals while ignoring completed requests", () => {
  const actions = projectPendingDesktopActions("thread-2", {
    requests: [
      {
        id: "req-command",
        method: "item/commandExecution/requestApproval",
        params: {
          turnId: "turn-2",
          itemId: "item-command",
          command: "git status",
          cwd: "/repo",
          reason: "Need to inspect changes",
        },
      },
      {
        id: "req-file",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "item-file",
          grantRoot: "/repo",
          reason: "Need to edit files",
        },
      },
      {
        id: "req-file-read",
        method: "item/fileRead/requestApproval",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "item-file-read",
          path: "/repo/secrets.txt",
          reason: "Need to inspect a file",
        },
      },
      {
        id: "req-done",
        method: "item/tool/requestUserInput",
        completed: true,
        params: {
          questions: [{ id: "q", question: "Done?" }],
        },
      },
      {
        id: "req-permissions",
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "item-permissions",
          reason: "Need plugin network access",
          permissions: {
            network: { enabled: true },
          },
        },
      },
    ],
  });

  assert.deepEqual(
    actions.map((action) => [action.id, action.method, action.params.threadId]),
    [
      ["req-command", "item/commandExecution/requestApproval", "thread-2"],
      ["req-file", "item/fileChange/requestApproval", "thread-2"],
      ["req-file-read", "item/fileRead/requestApproval", "thread-2"],
      ["req-permissions", "item/permissions/requestApproval", "thread-2"],
    ]
  );
  assert.equal(actions[0].params.command, "git status");
  assert.equal(actions[1].params.grantRoot, "/repo");
  assert.equal(actions[2].params.path, "/repo/secrets.txt");
  assert.equal(actions[3].params.reason, "Need plugin network access");
  assert.equal(actions[3].params.agntActionSource, "desktop-ipc-action-follower");
});

test("builds desktop follower reply payloads from iOS responses", () => {
  assert.deepEqual(
    desktopFollowerPayloadForResponse({
      requestId: "req-command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-command",
      result: { decision: "acceptForSession" },
    }),
    {
      method: "thread-follower-command-approval-decision",
      params: {
        conversationId: "thread-1",
        requestId: "req-command",
        decision: "acceptForSession",
      },
    }
  );

  assert.deepEqual(
    desktopFollowerPayloadForResponse({
      requestId: "req-user-input",
      method: "item/tool/requestUserInput",
      threadId: "thread-1",
    }, {
      id: "req-user-input",
      result: {
        answers: {
          q1: { answers: ["Yes"] },
        },
      },
    }),
    {
      method: "thread-follower-submit-user-input",
      params: {
        conversationId: "thread-1",
        requestId: "req-user-input",
        response: {
          answers: {
            q1: { answers: ["Yes"] },
          },
        },
      },
    }
  );

  assert.deepEqual(
    desktopFollowerPayloadForResponse({
      requestId: "req-file-read",
      method: "item/fileRead/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-file-read",
      result: { decision: "accept" },
    }),
    {
      method: "thread-follower-file-approval-decision",
      params: {
        conversationId: "thread-1",
        requestId: "req-file-read",
        decision: "accept",
      },
    }
  );

  assert.deepEqual(
    desktopFollowerPayloadForResponse({
      requestId: "req-permissions",
      method: "item/permissions/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-permissions",
      result: {
        permissions: {
          network: { enabled: true },
        },
        scope: "turn",
      },
    }),
    {
      method: "thread-follower-file-approval-decision",
      params: {
        conversationId: "thread-1",
        requestId: "req-permissions",
        decision: "accept",
      },
    }
  );

  assert.deepEqual(
    desktopFollowerPayloadForResponse({
      requestId: "req-permissions",
      method: "item/permissions/requestApproval",
      threadId: "thread-1",
    }, {
      id: "req-permissions",
      result: {
        permissions: {},
        scope: "turn",
      },
    }),
    {
      method: "thread-follower-file-approval-decision",
      params: {
        conversationId: "thread-1",
        requestId: "req-permissions",
        decision: "decline",
      },
    }
  );
});

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
