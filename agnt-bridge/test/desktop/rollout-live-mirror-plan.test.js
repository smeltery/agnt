// FILE: rollout-live-mirror-plan.test.js
// Purpose: Verifies desktop-origin rollout mirroring for structured plan updates and completed plan rows.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, rollout-live-mirror fixtures

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: wait } = require("node:timers/promises");

const { createRolloutLiveMirrorController } = require("../../src/desktop/rollout-live-mirror");
const {
  appendRolloutLines,
  createTemporaryRolloutHome,
  functionCall,
  planItemCompleted,
  restoreCodexHome,
  taskComplete,
  taskStarted,
} = require("./rollout-live-mirror-fixtures");

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
