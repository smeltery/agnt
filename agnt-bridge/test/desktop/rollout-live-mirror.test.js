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

test("desktop-origin mirror dedupes cumulative reasoning summaries across rollout shapes", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-reasoning-dedupe-shapes",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [taskStarted("turn-reasoning-dedupe-shapes")],
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
    params: { threadId: "thread-reasoning-dedupe-shapes" },
  }));

  await wait(20);
  outbound.length = 0;
  appendRolloutLines(rolloutPath, [
    agentReasoning("Testing notify command behavior"),
    agentReasoning("Analyzing notify hook JSON output format"),
    responseReasoning("reasoning-duplicate", [
      "Testing notify command behavior",
      "Analyzing notify hook JSON output format",
    ]),
    responseReasoning("reasoning-cumulative", [
      "Testing notify command behavior",
      "Analyzing notify hook JSON output format",
      "Planning parser fix",
    ]),
  ]);
  await wait(30);

  const deltas = outbound
    .filter((message) => message.method === "item/reasoning/textDelta")
    .map((message) => message.params.delta);
  assert.deepEqual(deltas, [
    "**Testing notify command behavior**\n\n<!-- -->",
    "\n\n**Analyzing notify hook JSON output format**\n\n<!-- -->",
    "\n\n**Planning parser fix**\n\n<!-- -->",
  ]);
  assert.equal(deltas.join("").includes("-->**"), false);
});

test("desktop-origin sibling terminal does not hijack a synthetic active turn", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-synthetic-sibling",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStartedWithoutTurnId(),
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
    params: { threadId: "thread-synthetic-sibling" },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    taskComplete("turn-parallel-sibling"),
  ]);
  await wait(20);

  const prematureSyntheticCompleted = outbound.find((message) => (
    message.method === "turn/completed"
    && /^rollout-turn:/.test(String(message.params.turnId))
  ));
  assert.equal(prematureSyntheticCompleted, undefined);

  appendRolloutLines(rolloutPath, [
    agentMessage("Synthetic run continues", "commentary"),
  ]);
  await wait(30);

  const siblingCompleted = outbound.find((message) => (
    message.method === "turn/completed"
    && message.params.turnId === "turn-parallel-sibling"
  ));
  assert.ok(siblingCompleted);

  const continuation = outbound.find((message) => (
    message.method === "codex/event/agent_message"
    && message.params.message === "Synthetic run continues"
  ));
  assert.ok(continuation);
  assert.match(continuation.params.turnId, /^rollout-turn:/);

  const syntheticCompleted = outbound.find((message) => (
    message.method === "turn/completed"
    && /^rollout-turn:/.test(String(message.params.turnId))
  ));
  assert.equal(syntheticCompleted, undefined);
});

test("desktop-origin terminal-only real id closes the synthetic active turn", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-synthetic-terminal",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStartedWithoutTurnId(),
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
    syntheticTerminalGraceMs: 25,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-synthetic-terminal" },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    taskComplete("turn-real-terminal"),
  ]);
  await wait(70);

  const realCompleted = outbound.find((message) => (
    message.method === "turn/completed"
    && message.params.turnId === "turn-real-terminal"
  ));
  assert.ok(realCompleted);

  const syntheticCompleted = outbound.find((message) => (
    message.method === "turn/completed"
    && /^rollout-turn:/.test(String(message.params.turnId))
  ));
  assert.ok(syntheticCompleted);
});

test("desktop-origin mirror promotes synthetic turn id when a real id appears", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-promote-turn",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStartedWithoutTurnId(),
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
    params: { threadId: "thread-promote-turn" },
  }));

  await wait(10);
  appendRolloutLines(rolloutPath, [
    responseMessage("Real turn arrived", "commentary", "msg-real-turn", "turn-real"),
    taskComplete("turn-real"),
  ]);
  await wait(30);

  const assistant = outbound.find((message) => message.method === "codex/event/agent_message");
  assert.ok(assistant);
  assert.equal(assistant.params.turnId, "turn-real");

  const completed = outbound.find((message) => message.method === "turn/completed");
  assert.ok(completed);
  assert.equal(completed.params.turnId, "turn-real");
});

test("desktop-origin mirror stays alive on heartbeat-only active runs", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-heartbeat-idle",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-heartbeat-idle"),
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
    idleTimeoutMs: 30,
    activityHeartbeatMs: 10,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-heartbeat-idle" },
  }));

  await wait(75);

  const heartbeats = outbound.filter((message) => message.method === "turn/activity");
  assert.ok(heartbeats.length >= 4, `expected heartbeat mirror to stay alive, got ${heartbeats.length}`);
});

test("phone-origin rollouts do not emit mirrored updates", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-phone",
    originator: "codexmobile_ios",
    source: "ios",
    lines: [
      taskStarted("turn-live"),
      functionCall("call-1", "exec_command", {
        cmd: "git status",
        workdir: "/repo",
      }),
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
    method: "thread/read",
    params: {
      threadId: "thread-phone",
    },
  }));

  await wait(30);

  assert.deepEqual(outbound, []);
});

test("rollout mirror suppression silences threads owned by another live source", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-suppressed",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("keep going"),
      taskStarted("turn-suppressed"),
      agentMessage("still streaming", "final_answer"),
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
    shouldSuppressThread: () => true,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-suppressed",
    },
  }));

  await wait(30);
  assert.deepEqual(outbound, []);
});

test("suppression lift re-bootstraps the muted tail so a running thread recovers", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-unmute",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("keep going"),
      taskStarted("turn-unmute"),
      agentMessage("still streaming", "final_answer"),
    ],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => {
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const outbound = [];
  let suppressed = true;
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    pollIntervalMs: 5,
    idleTimeoutMs: 200,
    shouldSuppressThread: () => suppressed,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-unmute",
    },
  }));

  await wait(30);
  assert.deepEqual(outbound, []);

  suppressed = false;
  await wait(30);

  const methods = outbound.map((message) => message.method);
  assert.equal(methods.includes("turn/started"), true);
  assert.equal(methods.includes("codex/event/user_message"), true);
  const userNotification = outbound.find((message) => message.method === "codex/event/user_message");
  assert.equal(userNotification?.params.turnId, "turn-unmute");
  assert.equal(userNotification?.params.message, "keep going");
});

test("desktop-origin idle watchers stream new rollout growth after the phone reopens the thread", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-grow",
    originator: "codex_vscode",
    source: "vscode",
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
    idleTimeoutMs: 100,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-grow",
    },
  }));
  await wait(20);

  appendRolloutLines(rolloutPath, [
    taskStarted("turn-next"),
    functionCall("call-2", "apply_patch", {}),
  ]);
  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/background_event",
    ]
  );
  assert.equal(outbound[2].params.message, "Applying patch");
});




test("desktop-origin rollouts mirror custom apply_patch as file-change lifecycle", async (t) => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: Sources/App.swift",
    "@@",
    "-let title = \"Old\"",
    "+let title = \"New\"",
    "*** End Patch",
    "",
  ].join("\n");
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-patch",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-patch"),
      customToolCall("call-patch", "apply_patch", patch),
      patchApplyEnd("turn-patch", "call-patch"),
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
      threadId: "thread-patch",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/patch_apply_begin",
      "codex/event/background_event",
      "codex/event/patch_apply_end",
    ]
  );
  assert.equal(outbound[2].params.itemId, "call-patch");
  assert.equal(outbound[2].params.status, "inProgress");
  assert.equal(outbound[2].params.changes[0].path, "Sources/App.swift");
  assert.equal(outbound[4].params.itemId, "call-patch");
  assert.equal(outbound[4].params.changes[0].path, "Sources/App.swift");
  assert.equal(outbound[4].params.changes[0].kind, "update");
  assert.equal(outbound[4].params.changes[0].additions, 1);
  assert.equal(outbound[4].params.changes[0].deletions, 1);
  assert.match(outbound[4].params.changes[0].diff, /diff --git a\/Sources\/App.swift b\/Sources\/App.swift/);
});

test("desktop-origin detection stays narrow", () => {
  assert.equal(isDesktopRolloutOrigin({ originator: "Codex Desktop", source: "vscode" }), true);
  assert.equal(isDesktopRolloutOrigin({ originator: "codex_vscode", source: "vscode" }), true);
  assert.equal(isDesktopRolloutOrigin({ originator: "codexmobile_ios", source: "ios" }), false);
});
