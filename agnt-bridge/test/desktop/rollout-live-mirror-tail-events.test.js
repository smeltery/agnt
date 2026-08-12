// FILE: rollout-live-mirror-tail-events.test.js
// Purpose: Verifies idle watcher tailing, custom apply_patch mirroring, and Desktop-origin detection.
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
  assert.equal(outbound[2].params.itemId, "call-2");
  assert.equal(outbound[2].params.status, "inProgress");
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
  assert.equal(outbound[3].params.itemId, undefined);
  assert.equal(outbound[3].params.status, undefined);
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
