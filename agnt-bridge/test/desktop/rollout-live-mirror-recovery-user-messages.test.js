// FILE: rollout-live-mirror-recovery-user-messages.test.js
// Purpose: Verifies rollout live mirror recovery for synthetic turn ids and user-message extraction.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, timers/promises, rollout-live-mirror, rollout-live-mirror-fixtures


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
