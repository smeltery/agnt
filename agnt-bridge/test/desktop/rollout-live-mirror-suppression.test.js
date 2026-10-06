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

test("rollout mirror defers its first filesystem scan until after observeInbound returns", (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-deferred-scan",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [taskStarted("turn-deferred-scan")],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  const trackedFs = createTrackedMirrorFs();
  let firstTick = null;
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse() {},
    fsModule: trackedFs,
    setIntervalFn() {
      return 1;
    },
    clearIntervalFn() {},
    setImmediateFn(callback) {
      firstTick = callback;
      return 2;
    },
    clearImmediateFn() {},
  });
  t.after(() => {
    controller.stopAll();
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-deferred-scan" },
  }));

  assert.equal(trackedFs.readdirCalls, 0);
  assert.ok(firstTick);
  firstTick();
  assert.ok(trackedFs.readdirCalls > 0);
});

test("rollout mirror performs no filesystem scan or bootstrap while suppressed", (t) => {
  const { homeDir } = createTemporaryRolloutHome({
    threadId: "thread-suppressed-scan",
    originator: "Codex Desktop",
    source: "desktop",
    lines: [taskStarted("turn-suppressed-scan")],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  const trackedFs = createTrackedMirrorFs();
  let firstTick = null;
  let intervalTick = null;
  const controller = createRolloutLiveMirrorController({
    sendApplicationResponse() {},
    fsModule: trackedFs,
    shouldSuppressThread: () => true,
    setIntervalFn(callback) {
      intervalTick = callback;
      return 1;
    },
    clearIntervalFn() {},
    setImmediateFn(callback) {
      firstTick = callback;
      return 2;
    },
    clearImmediateFn() {},
  });
  t.after(() => {
    controller.stopAll();
    restoreCodexHome(previousCodexHome);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  controller.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-suppressed-scan" },
  }));
  firstTick();
  intervalTick();

  assert.equal(trackedFs.readdirCalls, 0);
  assert.equal(trackedFs.statCalls, 0);
  assert.equal(trackedFs.readCalls, 0);
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

function createTrackedMirrorFs() {
  return {
    ...fs,
    readdirCalls: 0,
    statCalls: 0,
    readCalls: 0,
    readdirSync(...args) {
      this.readdirCalls += 1;
      return fs.readdirSync(...args);
    },
    statSync(...args) {
      this.statCalls += 1;
      return fs.statSync(...args);
    },
    readSync(...args) {
      this.readCalls += 1;
      return fs.readSync(...args);
    },
  };
}

test("stale IPC probes reuse the rollout path and yield only to newer file activity", (t) => {
  const { homeDir, rolloutPath } = createTemporaryRolloutHome({
    threadId: "thread-stale-ipc", originator: "Codex Desktop", source: "desktop",
    lines: [taskStarted("turn-stale-ipc"), agentMessage("Still working", "final_answer")],
  });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homeDir;
  t.after(() => { restoreCodexHome(previousCodexHome); fs.rmSync(homeDir, { recursive: true, force: true }); });
  const desktopActivityAt = fs.statSync(rolloutPath).mtimeMs + 100;
  const trackedFs = createTrackedMirrorFs();
  const outbound = [];
  let tick;
  let initialTick;
  const controller = createRolloutLiveMirrorController({
    fsModule: trackedFs, now: () => desktopActivityAt + 30_000,
    setIntervalFn: (callback) => { tick = callback; return 1; }, clearIntervalFn() {},
    setImmediateFn: (callback) => { initialTick = callback; return 1; }, clearImmediateFn() {},
    shouldSuppressThread: (_id, context) => context.probeFallbackActivity
      ? false : (context.fallbackActivityAt || 0) <= desktopActivityAt,
    sendApplicationResponse: (raw) => outbound.push(JSON.parse(raw)),
  });
  t.after(() => controller.stopAll());
  controller.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId: "thread-stale-ipc" } }));
  initialTick();
  assert.deepEqual(outbound, []);
  const scans = trackedFs.readdirCalls;
  tick();
  tick();
  assert.equal(trackedFs.readdirCalls, scans, "quiet work only needs stat probes");
  assert.deepEqual(outbound, []);
  const newer = new Date(desktopActivityAt + 1_000);
  fs.utimesSync(rolloutPath, newer, newer);
  tick();
  assert.ok(outbound.some((message) => message.method === "turn/started"));
  assert.equal(trackedFs.readdirCalls, scans, "the recovered mirror retains its known rollout path");
});
