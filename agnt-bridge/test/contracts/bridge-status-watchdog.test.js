const test = require("node:test");
const assert = require("node:assert/strict");
const { createBridgeRelayHeartbeat } = require("../../src/bridge/relay-heartbeat");
const { createBridgeStatusRuntime } = require("../../src/bridge/bridge-status-runtime");

function createHarness({ replyToPing = false, pingThrows = false } = {}) {
  let time = 0;
  let timer;
  const harness = { pings: 0, terminations: 0, shuttingDown: false };
  const heartbeat = createBridgeRelayHeartbeat({
    nowImpl: () => time,
    setIntervalImpl(fn) { timer = fn; return { unref() {} }; },
    clearIntervalImpl() { timer = null; },
  });
  const socket = {
    readyState: 1,
    ping() {
      if (pingThrows) throw new Error("socket closed");
      harness.pings += 1;
      if (replyToPing) heartbeat.markActivity();
    },
    terminate() { harness.terminations += 1; },
  };
  harness.currentSocket = socket;
  const runtime = createBridgeStatusRuntime({
    WebSocketCtor: { OPEN: 1 },
    isShuttingDown: () => harness.shuttingDown,
    getSocket: () => harness.currentSocket,
    heartbeat,
  });
  runtime.startRelayWatchdog(socket);
  harness.receiveAt = (value) => { time = value; heartbeat.markActivity(); };
  harness.tickAt = (value) => { time = value; timer?.(); };
  return harness;
}

test("relay heartbeats and application traffic avoid redundant watchdog probes", () => {
  const harness = createHarness();
  for (let time = 1_000; time <= 3_600_000; time += 1_000) {
    if (time % 30_000 === 5_000) harness.receiveAt(time);
    if (time % 10_000 === 0) harness.tickAt(time);
  }
  assert.equal(harness.pings, 0);
  assert.equal(harness.terminations, 0);
});

test("quiet relays are probed and incoming pongs reset the idle clock", () => {
  const harness = createHarness({ replyToPing: true });
  for (let time = 10_000; time <= 120_000; time += 10_000) harness.tickAt(time);
  assert.equal(harness.pings, 4);
  assert.equal(harness.terminations, 0);
});

test("unanswered probes preserve the stale deadline and terminate only once", () => {
  const harness = createHarness();
  for (let time = 10_000; time <= 60_000; time += 10_000) harness.tickAt(time);
  assert.equal(harness.pings, 2);
  assert.equal(harness.terminations, 1);
});

test("sleep/wake jumps recover immediately without sending another probe", () => {
  const harness = createHarness();
  harness.tickAt(300_000);
  assert.equal(harness.pings, 0);
  assert.equal(harness.terminations, 1);
});

test("shutdown, replaced sockets, and ping errors cannot keep a watchdog running", () => {
  for (const action of ["shutdown", "replace", "error"]) {
    const harness = createHarness({ pingThrows: action === "error" });
    if (action === "shutdown") harness.shuttingDown = true;
    if (action === "replace") harness.currentSocket = {};
    harness.tickAt(30_000);
    harness.tickAt(50_000);
    assert.equal(harness.pings, 0);
    assert.equal(harness.terminations, action === "error" ? 1 : 0);
  }
});
