// FILE: rollout-live-mirror-images.test.js
// Purpose: Verifies desktop-origin rollout mirroring for generated image artifacts.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, path, rollout-live-mirror fixtures

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");

const { createRolloutLiveMirrorController } = require("../../src/desktop/rollout-live-mirror");
const {
  createTemporaryRolloutHome,
  imageGenerationCall,
  imageGenerationEnd,
  imageGenerationItem,
  imageViewItem,
  restoreCodexHome,
  taskStarted,
} = require("./rollout-live-mirror-fixtures");

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
