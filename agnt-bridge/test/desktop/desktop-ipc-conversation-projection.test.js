// FILE: desktop-ipc-conversation-projection.test.js
// Purpose: Unit tests for pure Desktop conversationState projection and identity matching.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, ../../src/desktop/desktop-ipc-conversation-projector

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDesktopConversationProjector,
  matchDesktopTurnIdentityContinuities,
  projectDesktopConversationStateToGoal,
  projectDesktopConversationStateToThread,
} = require("../../src/desktop/desktop-ipc-conversation-projector");

test("desktop conversation projector applies persisted runtime settings", () => {
  const thread = projectDesktopConversationStateToThread("thread-runtime", {
    latestModel: "fallback-model",
    agntRuntimeSettings: {
      model: "gpt-5.2",
      reasoningEffort: "high",
      serviceTier: "fast",
      revision: 4,
      updatedAt: 123,
      source: "phone",
    },
    turns: [],
  });

  assert.equal(thread.model, "gpt-5.2");
  assert.equal(thread.reasoningEffort, "high");
  assert.equal(thread.serviceTier, "fast");
  assert.equal(thread.runtimeSettingsRevision, 4);
  assert.equal(thread.runtimeSettingsUpdatedAt, 123);
  assert.equal(thread.runtimeSettingsSource, "phone");
});

test("desktop conversation projector exposes latest thread goal", () => {
  const goal = projectDesktopConversationStateToGoal("thread-goal", {
    threadGoal: {
      objective: "Keep CI green",
      status: "active",
      tokenBudget: 5000,
      tokensUsed: 1250,
      timeUsedSeconds: 90,
      createdAt: 10,
      updatedAt: 20,
    },
    completedThreadGoal: {
      objective: "Older goal",
      status: "complete",
      updatedAt: 5,
    },
  });

  assert.deepEqual(goal, {
    threadId: "thread-goal",
    objective: "Keep CI green",
    status: "active",
    tokenBudget: 5000,
    tokensUsed: 1250,
    timeUsedSeconds: 90,
    createdAt: 10,
    updatedAt: 20,
  });
});

test("desktop conversation projector returns completed goal when newer", () => {
  const goal = projectDesktopConversationStateToGoal("thread-goal-done", {
    threadGoal: {
      objective: "Stale active",
      status: "active",
      updatedAt: 20,
    },
    completedThreadGoal: {
      objective: "Finished work",
      status: "complete",
      token_budget: 1000,
      tokens_used: 1000,
      time_used_seconds: 45,
      updated_at: 30,
    },
  });

  assert.deepEqual(goal, {
    threadId: "thread-goal-done",
    objective: "Finished work",
    status: "complete",
    tokenBudget: 1000,
    tokensUsed: 1000,
    timeUsedSeconds: 45,
    createdAt: 0,
    updatedAt: 30,
  });
});

test("desktop conversation projector refreshes thread metadata when runtime settings change", () => {
  const projector = createDesktopConversationProjector({ now: () => 100 });
  projector.project("thread-runtime-refresh", {
    agntRuntimeSettings: {
      model: "gpt-5.1",
      reasoningEffort: "medium",
      revision: 1,
      updatedAt: 100,
      source: "phone",
    },
    turns: [],
  });

  const output = projector.project("thread-runtime-refresh", {
    agntRuntimeSettings: {
      model: "gpt-5.2",
      reasoningEffort: "high",
      revision: 2,
      updatedAt: 200,
      source: "phone",
    },
    turns: [],
  });

  const threadStarted = output.notifications.find((notification) => notification.method === "thread/started");
  assert.equal(threadStarted?.params.thread.model, "gpt-5.2");
  assert.equal(threadStarted?.params.thread.runtimeSettingsRevision, 2);
  assert.equal(threadStarted?.params.thread.runtimeSettingsSource, "phone");
});

test("desktop identity repair pairs synthetic turns independently of parallel active turns", () => {
  const sharedTurn = {
    status: "inProgress",
    params: { input: [{ type: "text", text: "Repair A" }] },
    items: [{ id: "assistant-a-stable", type: "agentMessage", text: "Working" }],
  };
  const stableParallelTurn = {
    id: "turn-c",
    status: "inProgress",
    items: [{ id: "assistant-c", type: "agentMessage", text: "Parallel" }],
  };
  const matches = matchDesktopTurnIdentityContinuities(
    [
      { id: "ipc-turn-0", turn: sharedTurn },
      { id: "turn-c", turn: stableParallelTurn },
    ],
    [
      { id: "turn-real-a", turn: { ...sharedTurn, turnId: "turn-real-a" } },
      { id: "turn-c", turn: stableParallelTurn },
    ]
  );

  assert.deepEqual([...matches.previousTurnIds], ["ipc-turn-0"]);
  assert.deepEqual([...matches.nextTurnIds], ["turn-real-a"]);

  const stablePriority = matchDesktopTurnIdentityContinuities(
    [
      {
        id: "ipc-turn-0",
        turn: {
          startedAt: 123,
          params: { input: [{ type: "text", text: "same prompt" }] },
          items: [{ id: "assistant-fallback", type: "agentMessage", text: "Old" }],
        },
      },
      {
        id: "ipc-turn-1",
        turn: {
          startedAt: 999,
          params: { input: [{ type: "text", text: "other prompt" }] },
          items: [{ id: "assistant-stable", type: "agentMessage", text: "Stable" }],
        },
      },
    ],
    [{
      id: "turn-real-stable",
      turn: {
        startedAt: 123,
        params: { input: [{ type: "text", text: "same prompt" }] },
        items: [{ id: "assistant-stable", type: "agentMessage", text: "Stable" }],
      },
    }]
  );
  assert.deepEqual([...stablePriority.previousTurnIds], ["ipc-turn-1"]);
  assert.deepEqual([...stablePriority.nextTurnIds], ["turn-real-stable"]);
});

test("projects Desktop conversation state into thread/read backfill shape", () => {
  const thread = projectDesktopConversationStateToThread("thread-read-backfill", {
    title: "Backfill",
    cwd: "/repo",
    turns: [{
      turnId: "turn-read-backfill",
      status: "completed",
      params: {
        input: [{ type: "text", text: "hello" }],
      },
      items: [
        { id: "assistant-read-backfill", type: "agentMessage", text: "world" },
        {
          id: "mcp-read-backfill",
          type: "mcpToolCall",
          status: "completed",
          tool: "query",
          result: { content: [{ type: "text", text: "found it" }] },
        },
        {
          id: "dynamic-read-backfill",
          type: "dynamicToolCall",
          status: "completed",
          tool: "Read",
          contentItems: [{ type: "text", text: "file contents" }],
        },
      ],
    }],
  });

  assert.equal(thread.id, "thread-read-backfill");
  assert.equal(thread.name, "Backfill");
  assert.equal(thread.turns[0].id, "turn-read-backfill");
  assert.deepEqual(
    thread.turns[0].items.map((item) => item.type),
    ["userMessage", "agentMessage", "toolCall", "toolCall"]
  );
  assert.deepEqual(
    thread.turns[0].items.slice(2).map((item) => item.agntDesktopIpcItemType),
    ["mcpToolCall", "dynamicToolCall"]
  );
});
