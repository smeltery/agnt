// FILE: rollout-live-mirror.test.js
// Purpose: Verifies desktop-origin rollout replay/live tailing emits thinking and tool-call notifications for iPhone only.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, ../src/rollout-live-mirror

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");

const {
  createRolloutLiveMirrorController,
  isDesktopRolloutOrigin,
} = require("../../src/desktop/rollout-live-mirror");
const {
  agentMessage,
  agentReasoning,
  appendRolloutLines,
  createTemporaryRolloutHome,
  customToolCall,
  errorEvent,
  functionCall,
  functionCallOutput,
  patchApplyEnd,
  responseMessage,
  responseReasoning,
  restoreCodexHome,
  taskComplete,
  taskStarted,
  taskStartedWithoutTurnId,
  turnAborted,
  userMessage,
  userMessagePayload,
  userMessageWithTimestamp,
} = require("./rollout-live-mirror-fixtures");

test("desktop-origin active runs replay thinking and exec command activity on resume", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-desktop",
    originator: "Codex Desktop",
    source: "vscode",
    lines: [
      taskStarted("turn-live"),
      functionCall("call-1", "exec_command", {
        cmd: "git status",
        workdir: "/repo",
      }),
      functionCallOutput("call-1", "On branch main"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-desktop",
    },
  }));

  await wait(30);

  assert.equal(rolloutPath.includes("thread-desktop"), true);
  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/exec_command_begin",
      "codex/event/exec_command_output_delta",
      "codex/event/exec_command_end",
    ]
  );
  assert.equal(outbound[1].params.delta, "Thinking...");
  assert.equal(outbound[2].params.command, "git status");
  assert.equal(outbound[3].params.chunk, "On branch main");
});

test("desktop-origin bootstrap replays the pending user message and final assistant text", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-chat",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("Please review this diff"),
      taskStarted("turn-chat"),
      agentMessage("Review complete", "final_answer"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-chat",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "codex/event/user_message",
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/agent_message",
    ]
  );
  assert.equal(outbound[0].params.message, "Please review this diff");
  assert.equal(outbound[3].params.message, "Review complete");
  assert.equal(
    outbound[3].params.itemId,
    "rollout-agent-message:thread-chat:turn-chat:2026-03-15T19:47:40.000Z:73e01b91e228"
  );
});

test("desktop-origin mirror keeps commentary prose interleaved with tool calls", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-commentary",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-commentary"),
      agentMessage("Checking touched files", "commentary"),
      functionCall("call-1", "exec_command", { cmd: "git status" }),
      agentMessage("Everything is green; committing", "commentary"),
      agentMessage("Done: commit created", "final_answer"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-commentary",
    },
  }));

  await wait(30);

  const agentMessages = outbound.filter((message) => message.method === "codex/event/agent_message");
  assert.deepEqual(
    agentMessages.map((message) => [message.params.message, message.params.phase]),
    [
      ["Checking touched files", "commentary"],
      ["Everything is green; committing", "commentary"],
      ["Done: commit created", "final_answer"],
    ]
  );

  const flowMethods = outbound
    .filter((message) => (
      message.method === "codex/event/agent_message"
      || message.method === "codex/event/exec_command_begin"
    ))
    .map((message) => message.method);
  assert.deepEqual(flowMethods, [
    "codex/event/agent_message",
    "codex/event/exec_command_begin",
    "codex/event/agent_message",
    "codex/event/agent_message",
  ]);
});

test("desktop-origin bootstrap emits terminal catch-up for completed runs", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-terminal-completed",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-terminal-completed"),
      agentMessage("Done", "final_answer"),
      taskComplete("turn-terminal-completed"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-terminal-completed" },
  }));

  await wait(30);

  assert.deepEqual(outbound.map((message) => message.method), ["turn/completed"]);
  assert.equal(outbound[0].params.threadId, "thread-terminal-completed");
  assert.equal(outbound[0].params.turnId, "turn-terminal-completed");
  assert.equal(outbound[0].params.agntRolloutTerminalCatchUp, true);
});

test("desktop-origin bootstrap emits terminal catch-up for aborted runs", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-terminal-aborted",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-terminal-aborted"),
      turnAborted("turn-terminal-aborted"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-terminal-aborted" },
  }));

  await wait(30);

  assert.deepEqual(outbound.map((message) => message.method), ["turn/completed"]);
  assert.equal(outbound[0].params.turnId, "turn-terminal-aborted");
  assert.equal(outbound[0].params.status, "aborted");
  assert.equal(outbound[0].params.agntRolloutTerminalCatchUp, true);
});

test("desktop-origin bootstrap emits terminal catch-up for failed runs", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-terminal-error",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-terminal-error"),
      errorEvent("turn-terminal-error", "desktop failed"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-terminal-error" },
  }));

  await wait(30);

  assert.deepEqual(outbound.map((message) => message.method), ["turn/completed"]);
  assert.equal(outbound[0].params.turnId, "turn-terminal-error");
  assert.equal(outbound[0].params.status, "failed");
  assert.equal(outbound[0].params.error.message, "desktop failed");
  assert.equal(outbound[0].params.agntRolloutTerminalCatchUp, true);
});

test("desktop-origin mirror flushes a valid partial EOF line before stopping", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-partial-eof",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 25,
    activityHeartbeatMs: 100,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-partial-eof" },
  }));

  await wait(10);
  fs.appendFileSync(rolloutPath, taskStarted("turn-partial-eof"));
  await wait(45);

  assert.ok(outbound.some((message) => (
    message.method === "turn/started"
    && message.params.turnId === "turn-partial-eof"
  )));
});

test("desktop-origin mirror emits response_item assistant messages when event_msg is absent", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-response-message",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-response-message"),
      responseMessage("Only response item text", "final_answer", "msg-response-only"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-response-message" },
  }));

  await wait(30);

  const message = outbound.find((entry) => entry.method === "codex/event/agent_message");
  assert.ok(message);
  assert.equal(message.params.message, "Only response item text");
  assert.equal(message.params.phase, "final_answer");
  assert.equal(message.params.itemId, "msg-response-only");
});

test("desktop-origin mirror dedupes the same assistant text across event and response_item shapes", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-dedupe-shapes",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-dedupe-shapes"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 200,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-dedupe-shapes" },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    agentMessage("Final answer text", "final_answer"),
    responseMessage("Final answer text", "final_answer", "msg-dedupe-response"),
  ]);
  await wait(30);

  const messages = outbound.filter((message) => (
    message.method === "codex/event/agent_message"
    && message.params.message === "Final answer text"
  ));
  assert.equal(messages.length, 1);
});
