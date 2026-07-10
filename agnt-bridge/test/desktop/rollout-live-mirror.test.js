// FILE: rollout-live-mirror.test.js
// Purpose: Verifies desktop-origin rollout replay/live tailing emits thinking and tool-call notifications for iPhone only.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/rollout-live-mirror

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");

const {
  createRolloutLiveMirrorController,
  isDesktopRolloutOrigin,
} = require("../../src/desktop/rollout-live-mirror");

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

test("desktop-origin active runs mirror generated image previews", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-image",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-image"),
      imageGenerationCall("ig_123"),
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
      threadId: "thread-image",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/image_generation_end",
    ]
  );
  assert.equal(outbound[2].params.call_id, "ig_123");
  assert.equal(outbound[2].params.itemId, "ig_123");
  assert.equal(outbound[2].params.turnId, "turn-image");
  assert.equal(
    outbound[2].params.saved_path,
    path.join(homeDir, "generated_images", "thread-image", "ig_123.png")
  );
});

test("desktop-origin active runs mirror imageView items", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-image-view",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-image-view"),
      imageViewItem("view_123", "/tmp/generated view.png"),
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
      threadId: "thread-image-view",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/image_generation_end",
    ]
  );
  assert.equal(outbound[2].params.call_id, "view_123");
  assert.equal(outbound[2].params.saved_path, "/tmp/generated view.png");
});

test("desktop-origin active runs mirror image_generation items", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-image-generation",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-image-generation"),
      imageGenerationItem("ig_generation", "/tmp/generated item.png"),
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
      threadId: "thread-image-generation",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/image_generation_end",
    ]
  );
  assert.equal(outbound[2].params.call_id, "ig_generation");
  assert.equal(outbound[2].params.saved_path, "/tmp/generated item.png");
});

test("desktop-origin active runs mirror generated image end events without response items", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-image-event",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-image-event"),
      imageGenerationEnd("turn-image-event", "ig_event", "/tmp/generated event.png"),
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
      threadId: "thread-image-event",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/image_generation_end",
    ]
  );
  assert.equal(outbound[2].params.call_id, "ig_event");
  assert.equal(outbound[2].params.itemId, "ig_event");
  assert.equal(outbound[2].params.turnId, "turn-image-event");
  assert.equal(outbound[2].params.saved_path, "/tmp/generated event.png");
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

test("desktop-origin update_plan calls mirror as structured plan updates", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-plan",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-plan"),
      functionCall("call-plan", "update_plan", {
        explanation: "Break the work into safe slices.",
        plan: [
          { step: "Inspect plan rendering", status: "completed" },
          { step: "Keep it visible", status: "in_progress" },
        ],
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
    method: "thread/resume",
    params: {
      threadId: "thread-plan",
    },
  }));

  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "turn/plan/updated",
    ]
  );
  assert.equal(outbound[2].params.turnId, "turn-plan");
  assert.equal(outbound[2].params.explanation, "Break the work into safe slices.");
  assert.deepEqual(outbound[2].params.plan, [
    { step: "Inspect plan rendering", status: "completed" },
    { step: "Keep it visible", status: "in_progress" },
  ]);
  // update_plan is internal: it must not also surface as a generic activity row.
  assert.equal(
    outbound.some((message) => message.params?.message === "Running update_plan"),
    false
  );
});

test("desktop-origin plan mirror ignores empty updates but keeps explanation-only updates", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-plan-visibility",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-plan-visibility"),
      functionCall("call-empty-plan", "update_plan", { plan: [] }),
      functionCall("call-explanation-plan", "update_plan", {
        explanation: "Keep the last meaningful plan visible.",
        plan: [],
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
    method: "thread/resume",
    params: { threadId: "thread-plan-visibility" },
  }));
  await wait(30);

  const planUpdates = outbound.filter((message) => message.method === "turn/plan/updated");
  assert.equal(planUpdates.length, 1);
  assert.equal(planUpdates[0].params.explanation, "Keep the last meaningful plan visible.");
  assert.deepEqual(planUpdates[0].params.plan, []);
});

test("desktop-origin completed plan items mirror as final plan rows", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-plan-result",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-plan-result"),
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
      threadId: "thread-plan-result",
    },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    planItemCompleted("turn-plan-result", "plan-result-1", "# Improve Dashboard\n\n- Tighten validation"),
    taskComplete("turn-plan-result"),
  ]);
  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "item/completed",
      "turn/completed",
    ]
  );
  assert.equal(outbound[2].params.threadId, "thread-plan-result");
  assert.equal(outbound[2].params.turnId, "turn-plan-result");
  assert.equal(outbound[2].params.item.type, "Plan");
  assert.equal(outbound[2].params.item.id, "plan-result-1");
  assert.equal(outbound[2].params.item.text, "# Improve Dashboard\n\n- Tighten validation");
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

test("desktop-origin bootstrap catches up aborted runs without replaying content", async (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-aborted",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("Please stop midway"),
      taskStarted("turn-aborted"),
      agentMessage("Partial answer", "final_answer"),
      turnAborted("turn-aborted"),
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
      threadId: "thread-aborted",
    },
  }));

  await wait(30);

  assert.deepEqual(outbound.map((message) => message.method), ["turn/completed"]);
  assert.equal(outbound[0].params.threadId, "thread-aborted");
  assert.equal(outbound[0].params.turnId, "turn-aborted");
  assert.equal(outbound[0].params.status, "aborted");
  assert.equal(outbound[0].params.agntRolloutTerminalCatchUp, true);
});

test("desktop-origin mirror re-bootstraps after rollout truncation", async (t) => {
  const longMessage = "x".repeat(600);
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-truncate",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-truncate-old"),
      agentMessage(longMessage, "commentary"),
      agentMessage(`${longMessage}-more`, "commentary"),
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
    params: { threadId: "thread-truncate" },
  }));

  await wait(20);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-03-15T19:47:36.019Z",
      type: "session_meta",
      payload: {
        id: "thread-truncate",
        cwd: "/repo",
        originator: "Codex Desktop",
        source: "desktop",
      },
    }),
    taskStarted("turn-truncate-new"),
    agentMessage("Fresh rewritten rollout", "final_answer"),
    "",
  ].join("\n"));
  await wait(40);

  const freshMessage = outbound.find((message) => (
    message.method === "codex/event/agent_message"
    && message.params.message === "Fresh rewritten rollout"
  ));
  assert.ok(freshMessage);
  assert.equal(freshMessage.params.turnId, "turn-truncate-new");
});

test("desktop-origin bootstrap skips stale active runs whose rollout stopped growing", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-stale",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("Long lost run"),
      taskStarted("turn-stale"),
      agentMessage("Working on it", "final_answer"),
    ],
  });
  const staleDate = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(rolloutPath, staleDate, staleDate);
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
    activityHeartbeatMs: 10,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-stale",
    },
  }));

  await wait(30);

  assert.deepEqual(outbound, []);
});

test("desktop-origin stale runs resume live mirroring when the rollout grows again", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-stale-resume",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      userMessage("Long lost run"),
      taskStarted("turn-stale-resume"),
    ],
  });
  const staleDate = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(rolloutPath, staleDate, staleDate);
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
      threadId: "thread-stale-resume",
    },
  }));

  await wait(20);
  assert.deepEqual(outbound, []);

  appendRolloutLines(rolloutPath, [
    agentMessage("Back from stale state", "final_answer"),
    taskComplete("turn-stale-resume"),
  ]);
  await wait(30);

  const agentMessageNotification = outbound.find((message) => message.method === "codex/event/agent_message");
  assert.ok(agentMessageNotification);
  assert.equal(agentMessageNotification.params.turnId, "turn-stale-resume");
  const completed = outbound.find((message) => message.method === "turn/completed");
  assert.ok(completed);
  assert.equal(completed.params.turnId, "turn-stale-resume");
});

test("desktop-origin live tail closes mirrored turns on turn_aborted", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-live-abort",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-live-abort"),
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
    idleTimeoutMs: 100,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-live-abort",
    },
  }));
  await wait(20);
  appendRolloutLines(rolloutPath, [
    turnAborted("turn-live-abort"),
  ]);
  await wait(30);

  const completed = outbound.find((message) => message.method === "turn/completed");
  assert.ok(completed);
  assert.equal(completed.params.turnId, "turn-live-abort");
  assert.equal(completed.params.status, "aborted");
});

test("desktop-origin live tail closes mirrored turns on fatal error", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-live-error",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-live-error"),
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
    idleTimeoutMs: 100,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-live-error" },
  }));
  await wait(20);
  appendRolloutLines(rolloutPath, [
    errorEvent("turn-live-error", "Model stream disconnected"),
  ]);
  await wait(30);

  const completed = outbound.find((message) => message.method === "turn/completed");
  assert.ok(completed);
  assert.equal(completed.params.turnId, "turn-live-error");
  assert.equal(completed.params.status, "failed");
  assert.equal(completed.params.error.message, "Model stream disconnected");
});

test("desktop-origin live tail preserves abort status when finalizing a synthetic active turn", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-live-synthetic-abort",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted(),
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
    idleTimeoutMs: 100,
    syntheticTerminalGraceMs: 5,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-live-synthetic-abort" },
  }));
  await wait(20);
  appendRolloutLines(rolloutPath, [
    turnAborted("turn-real-abort"),
  ]);
  await wait(40);

  const syntheticCompleted = outbound
    .filter((message) => message.method === "turn/completed")
    .find((message) => message.params.turnId.startsWith("rollout-turn:"));
  assert.ok(syntheticCompleted);
  assert.equal(syntheticCompleted.params.status, "aborted");
});

test("desktop-origin live tail preserves failed status when finalizing a synthetic active turn", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-live-synthetic-error",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted(),
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
    idleTimeoutMs: 100,
    syntheticTerminalGraceMs: 5,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-live-synthetic-error" },
  }));
  await wait(20);
  appendRolloutLines(rolloutPath, [
    errorEvent("turn-real-error", "Model stream disconnected"),
  ]);
  await wait(40);

  const syntheticCompleted = outbound
    .filter((message) => message.method === "turn/completed")
    .find((message) => message.params.turnId.startsWith("rollout-turn:"));
  assert.ok(syntheticCompleted);
  assert.equal(syntheticCompleted.params.status, "failed");
  assert.equal(syntheticCompleted.params.error.message, "Model stream disconnected");
});

test("desktop-origin rollouts emit a turn-end file-change snapshot after final text", async (t) => {
  const firstPatch = [
    "*** Begin Patch",
    "*** Update File: Sources/App.swift",
    "@@",
    "-let title = \"Old\"",
    "+let title = \"New\"",
    "*** End Patch",
    "",
  ].join("\n");
  const secondPatch = [
    "*** Begin Patch",
    "*** Update File: Sources/Settings.swift",
    "@@",
    "-let enabled = false",
    "+let enabled = true",
    "*** End Patch",
    "",
  ].join("\n");
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-patch-snapshot",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [
      taskStarted("turn-patch-snapshot"),
      customToolCall("call-patch-1", "apply_patch", firstPatch),
      patchApplyEnd("turn-patch-snapshot", "call-patch-1"),
      customToolCall("call-patch-2", "apply_patch", secondPatch),
      patchApplyEnd("turn-patch-snapshot", "call-patch-2"),
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
      threadId: "thread-patch-snapshot",
    },
  }));
  await wait(20);
  appendRolloutLines(rolloutPath, [
    agentMessage("Done editing.", "final_answer"),
    taskComplete("turn-patch-snapshot"),
  ]);
  await wait(40);

  const methods = outbound.map((message) => message.method);
  const agentIndex = methods.lastIndexOf("codex/event/agent_message");
  const completedIndex = methods.lastIndexOf("turn/completed");
  // The aggregate snapshot is the final patch_apply_end emitted on task_complete,
  // carrying every change from the turn keyed off the last apply-patch item.
  const snapshotIndex = outbound.findIndex((message, index) => (
    index > agentIndex
    && message.method === "codex/event/patch_apply_end"
    && message.params.itemId === "call-patch-2"
    && Array.isArray(message.params.changes)
    && message.params.changes.length === 2
  ));

  assert.ok(agentIndex >= 0);
  assert.ok(snapshotIndex > agentIndex);
  assert.ok(completedIndex > snapshotIndex);
  assert.deepEqual(
    outbound[snapshotIndex].params.changes.map((change) => change.path),
    ["Sources/App.swift", "Sources/Settings.swift"]
  );
});

test("desktop-origin task_started without turn_id mirrors via a synthetic turn id", async (t) => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: Sources/App.swift",
    "@@",
    "-let title = \"Old\"",
    "+let title = \"New\"",
    "*** End Patch",
    "",
  ].join("\n");
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-turnless-task",
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
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-turnless-task",
    },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    taskStarted(),
    customToolCall("call-turnless-patch", "apply_patch", patch),
    patchApplyEnd("", "call-turnless-patch"),
    taskComplete(""),
  ]);
  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "item/reasoning/textDelta",
      "codex/event/patch_apply_begin",
      "codex/event/background_event",
      "codex/event/patch_apply_end",
      "codex/event/patch_apply_end",
      "turn/completed",
    ]
  );
  const mirroredTurnId = outbound[0].params.turnId;
  assert.match(mirroredTurnId, /^rollout-turn:thread-turnless-task:/);
  // Later turn-less events must resolve back to the synthetic turn id.
  assert.equal(outbound[2].params.turnId, mirroredTurnId);
  assert.equal(outbound[4].params.turnId, mirroredTurnId);
  assert.equal(outbound[5].params.turnId, mirroredTurnId);
  assert.equal(outbound[6].params.turnId, mirroredTurnId);
  assert.equal(outbound[4].params.changes[0].path, "Sources/App.swift");
});

test("desktop-origin user messages without a turn flush with timestamps on task start", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-user-flush",
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
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-user-flush",
    },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    userMessageWithTimestamp("Start from Mac", "2026-03-15T19:47:36.500Z", "desktop-user-1"),
    taskStarted("turn-flush"),
  ]);
  await wait(30);

  assert.deepEqual(
    outbound.map((message) => message.method),
    [
      "turn/started",
      "codex/event/user_message",
      "item/reasoning/textDelta",
    ]
  );
  assert.equal(outbound[1].params.message, "Start from Mac");
  assert.equal(outbound[1].params.turnId, "turn-flush");
  assert.equal(outbound[1].params.id, "desktop-user-1");
  assert.equal(outbound[1].params.createdAt, "2026-03-15T19:47:36.500Z");
  assert.equal(outbound[1].params.timestamp, "2026-03-15T19:47:36.500Z");
});

test("desktop-origin user messages drop contextual wrappers before mirroring", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-user-context",
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
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-user-context",
    },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    userMessage(`# AGENTS.md instructions for /tmp/project

<INSTRUCTIONS>
rules
</INSTRUCTIONS>

## My request for Codex:
Only show this prompt`),
    taskStarted("turn-context"),
  ]);
  await wait(30);

  const userNotification = outbound.find((message) => message.method === "codex/event/user_message");
  assert.equal(userNotification?.params.message, "Only show this prompt");
});

test("desktop-origin user messages extract visible text from structured input payloads", async (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-user-structured-context",
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
    idleTimeoutMs: 50,
  });
  t.after(() => controller.stopAll());

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: {
      threadId: "thread-user-structured-context",
    },
  }));

  await wait(20);
  appendRolloutLines(rolloutPath, [
    userMessagePayload({
      input: [
        {
          type: "input_text",
          text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>",
        },
        {
          type: "input_text",
          text: "IDE context\n\n## My request for Codex:\nSummarize the failing checks",
        },
      ],
    }),
    taskStarted("turn-structured-context"),
  ]);
  await wait(30);

  const userNotifications = outbound.filter((message) => message.method === "codex/event/user_message");
  assert.equal(userNotifications.length, 1);
  assert.equal(userNotifications[0].params.message, "Summarize the failing checks");
  assert.equal(userNotifications[0].params.turnId, "turn-structured-context");
});

test("desktop-origin detection stays narrow", () => {
  assert.equal(isDesktopRolloutOrigin({ originator: "Codex Desktop", source: "vscode" }), true);
  assert.equal(isDesktopRolloutOrigin({ originator: "codex_vscode", source: "vscode" }), true);
  assert.equal(isDesktopRolloutOrigin({ originator: "codexmobile_ios", source: "ios" }), false);
});

function createTemporaryRolloutHome({ threadId, originator, source, lines }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-live-mirror-"));
  const threadDir = path.join(homeDir, "sessions", "2026", "03", "15");
  fs.mkdirSync(threadDir, { recursive: true });
  const rolloutPath = path.join(threadDir, `rollout-2026-03-15T19-47-36-${threadId}.jsonl`);
  const header = JSON.stringify({
    timestamp: "2026-03-15T19:47:36.019Z",
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: "/repo",
      originator,
      source,
    },
  });
  fs.writeFileSync(rolloutPath, [header, ...lines, ""].join("\n"));
  return { homeDir, rolloutPath };
}

function appendRolloutLines(rolloutPath, lines) {
  fs.appendFileSync(rolloutPath, `${lines.join("\n")}\n`);
}

function taskStarted(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:37.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      model_context_window: 258400,
    },
  });
}

function taskStartedWithoutTurnId() {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:37.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      model_context_window: 258400,
    },
  });
}

function userMessage(message) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:36.500Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
    },
  });
}

function userMessagePayload(payload) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:36.500Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      ...payload,
    },
  });
}

function agentMessage(message, phase = "final_answer") {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.000Z",
    type: "event_msg",
    payload: {
      type: "agent_message",
      message,
      phase,
    },
  });
}

function responseMessage(message, phase = "final_answer", id = "msg-response", turnId = "") {
  const payload = {
    type: "message",
    id,
    role: "assistant",
    phase,
    content: [
      {
        type: "output_text",
        text: message,
      },
    ],
  };
  if (turnId) {
    payload.internal_chat_message_metadata_passthrough = {
      turn_id: turnId,
    };
  }
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.000Z",
    type: "response_item",
    payload,
  });
}

function agentReasoning(title) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.000Z",
    type: "event_msg",
    payload: {
      type: "agent_reasoning",
      text: `**${title}**\n\n<!-- -->`,
    },
  });
}

function responseReasoning(id, titles) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      id,
      summary: titles.map((title) => ({
        type: "summary_text",
        text: `**${title}**\n\n<!-- -->`,
      })),
    },
  });
}

function userMessageWithTimestamp(message, timestamp, id = "") {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
      ...(id ? { id } : {}),
    },
  });
}

function planItemCompleted(turnId, itemId, text) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.500Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: turnId,
      item: {
        type: "Plan",
        id: itemId,
        text,
      },
    },
  });
}

function customToolCall(callId, name, input) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.500Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name,
      input,
    },
  });
}

function patchApplyEnd(turnId, callId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.750Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      turn_id: turnId,
      call_id: callId,
      status: "completed",
      stdout: "Success. Updated the following files:\nM Sources/App.swift\n",
    },
  });
}

function taskComplete(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
    },
  });
}

function turnAborted(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: turnId,
    },
  });
}

function errorEvent(turnId, message) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "error",
      turn_id: turnId,
      message,
    },
  });
}

function functionCall(callId, name, argumentsObject) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(argumentsObject),
    },
  });
}

function functionCallOutput(callId, output) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  });
}

function imageGenerationCall(itemId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "image_generation_call",
      status: "completed",
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function imageGenerationEnd(turnId, callId, savedPath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "event_msg",
    payload: {
      type: "image_generation_end",
      id: turnId,
      turn_id: turnId,
      call_id: callId,
      saved_path: savedPath,
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function imageViewItem(itemId, imagePath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "imageView",
      path: imagePath,
    },
  });
}

function imageGenerationItem(itemId, imagePath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "image_generation",
      path: imagePath,
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function restoreCodexHome(previousCodexHome) {
  if (previousCodexHome == null) {
    delete process.env.CODEX_HOME;
    return;
  }
  process.env.CODEX_HOME = previousCodexHome;
}
