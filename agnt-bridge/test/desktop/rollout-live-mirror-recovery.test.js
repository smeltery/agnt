// FILE: rollout-live-mirror-recovery.test.js
// Purpose: Verifies rollout live mirror recovery, terminal-state finalization, and user-message extraction.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, rollout-live-mirror

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");

const {
  createRolloutLiveMirrorController,
} = require("../../src/desktop/rollout-live-mirror");
const {
  agentMessage,
  appendRolloutLines,
  createTemporaryRolloutHome,
  customToolCall,
  errorEvent,
  patchApplyEnd,
  restoreCodexHome,
  taskComplete,
  taskStarted,
  taskStartedWithoutTurnId,
  turnAborted,
  userMessage,
  userMessagePayload,
  userMessageWithTimestamp,
} = require("./rollout-live-mirror-fixtures");

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
