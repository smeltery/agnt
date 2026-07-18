// FILE: rollout-live-mirror-synthetic-turns.test.js
// Purpose: Verifies Desktop-origin rollout mirroring dedupes content and reconciles synthetic turn ids.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, timers/promises, rollout-live-mirror, rollout-live-mirror-fixtures


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
