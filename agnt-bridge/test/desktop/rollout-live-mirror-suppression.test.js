// FILE: rollout-live-mirror-suppression.test.js
// Purpose: Verifies rollout live mirror heartbeat, phone-origin, and live-owner suppression behavior.
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
