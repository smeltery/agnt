// FILE: contracts/lifecycle.test.js
// Purpose: Pins the two bootstrap/teardown helpers used by startBridge:
//          - createNoopDesktopRefresher shape (load-bearing for providers
//            that don't declare a desktopRefresher capability — bridge.js
//            calls handleInbound/handleOutbound/handleTransportReset on
//            this object unconditionally).
//          - shutdown ordering: caller cleanup runs first, then socket
//            close (only if OPEN/CONNECTING), then codex.shutdown, then
//            delayed process.exit.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const {
  createNoopDesktopRefresher,
  shutdown,
} = require("../../src/bridge/lifecycle");

// ─── createNoopDesktopRefresher ─────────────────────────────────────────────

test("createNoopDesktopRefresher returns the three required no-op methods", () => {
  const refresher = createNoopDesktopRefresher();
  assert.equal(typeof refresher.handleInbound, "function");
  assert.equal(typeof refresher.handleOutbound, "function");
  assert.equal(typeof refresher.handleTransportReset, "function");
});

test("createNoopDesktopRefresher methods accept any args and return undefined", () => {
  const refresher = createNoopDesktopRefresher();
  assert.equal(refresher.handleInbound("anything"), undefined);
  assert.equal(refresher.handleOutbound({ msg: 1 }), undefined);
  assert.equal(refresher.handleTransportReset(), undefined);
});

test("createNoopDesktopRefresher returns a fresh object each call", () => {
  // Important so callers can mutate / replace methods without cross-talk.
  assert.notEqual(createNoopDesktopRefresher(), createNoopDesktopRefresher());
});

// ─── shutdown ──────────────────────────────────────────────────────────────

function makeFakeCodex() {
  const calls = { shutdown: 0 };
  return {
    calls,
    shutdown() { calls.shutdown += 1; },
  };
}

function makeFakeSocket(readyState) {
  const calls = { close: 0 };
  return {
    calls,
    readyState,
    close() { calls.close += 1; },
  };
}

test("shutdown calls beforeExit, closes an OPEN socket, then codex.shutdown", (t) => {
  const codex = makeFakeCodex();
  const socket = makeFakeSocket(WebSocket.OPEN);
  const order = [];
  const beforeExit = () => order.push("beforeExit");
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;
  process.exit = () => order.push("exit");
  global.setTimeout = (fn) => { order.push("setTimeout-scheduled"); fn(); return 0; };
  t.after(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  shutdown(codex, () => socket, beforeExit);

  // Documented order: beforeExit first, then socket close, then codex.shutdown,
  // then setTimeout(exit, 100).
  assert.equal(order[0], "beforeExit");
  assert.equal(socket.calls.close, 1);
  assert.equal(codex.calls.shutdown, 1);
  assert.deepEqual(order.slice(-2), ["setTimeout-scheduled", "exit"]);
});

test("shutdown closes a CONNECTING socket", (t) => {
  const codex = makeFakeCodex();
  const socket = makeFakeSocket(WebSocket.CONNECTING);
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;
  process.exit = () => {};
  global.setTimeout = () => 0;
  t.after(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  shutdown(codex, () => socket);
  assert.equal(socket.calls.close, 1);
});

test("shutdown leaves CLOSING / CLOSED sockets alone (close not called)", (t) => {
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;
  process.exit = () => {};
  global.setTimeout = () => 0;
  t.after(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  for (const state of [WebSocket.CLOSING, WebSocket.CLOSED]) {
    const codex = makeFakeCodex();
    const socket = makeFakeSocket(state);
    shutdown(codex, () => socket);
    assert.equal(socket.calls.close, 0, `state=${state} must not close`);
    assert.equal(codex.calls.shutdown, 1, `state=${state} must still shutdown codex`);
  }
});

test("shutdown tolerates a null socket (getSocket returns null)", (t) => {
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;
  process.exit = () => {};
  global.setTimeout = () => 0;
  t.after(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  const codex = makeFakeCodex();
  assert.doesNotThrow(() => shutdown(codex, () => null));
  assert.equal(codex.calls.shutdown, 1);
});

test("shutdown defaults beforeExit to a no-op (no throw when omitted)", (t) => {
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;
  process.exit = () => {};
  global.setTimeout = () => 0;
  t.after(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  const codex = makeFakeCodex();
  assert.doesNotThrow(() => shutdown(codex, () => null));
});
