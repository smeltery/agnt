// FILE: contracts/relay-socket-loop.test.js
// Purpose: Locks the lifecycle contract for createRelaySocketLoop —
//          isShuttingDown gating, on-open wiring, message dispatch into
//          secureTransport, close-code policy (reconnect vs. shutdown),
//          and stale-socket guards on late close/error events.
// Layer: Unit test (contract)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createRelaySocketLoop } = require("../../src/bridge/relay-socket-loop");

function makeFakeSocket() {
  const sock = new EventEmitter();
  sock.readyState = 0; // CONNECTING
  sock.sent = [];
  sock.send = (data) => { sock.sent.push(data); };
  sock.close = () => { sock.readyState = 3; };
  sock.terminate = () => { sock.readyState = 3; };
  return sock;
}

function makeWebSocketCtor() {
  const constructed = [];
  function Ctor(url, opts) {
    const sock = makeFakeSocket();
    sock.url = url;
    sock.opts = opts;
    constructed.push(sock);
    return sock;
  }
  Ctor.OPEN = 1;
  return { Ctor, constructed };
}

function makeReconnectScheduler() {
  const scheduled = [];
  let pending = false;
  let attempts = 0;
  return {
    schedule(fn) { scheduled.push(fn); pending = true; },
    clear() { pending = false; },
    resetAttempt() { attempts = 0; },
    isPending() { return pending; },
    _attempts: () => attempts,
    _scheduled: () => scheduled,
  };
}

function buildLoop(overrides = {}) {
  const calls = [];
  const ws = makeWebSocketCtor();
  const reconnectScheduler = makeReconnectScheduler();
  const defaults = {
    WebSocketCtor: ws.Ctor,
    relaySessionUrl: () => "wss://relay.example/sess",
    buildHeaders: () => ({ "x-role": "mac" }),
    isShuttingDown: () => false,
    reconnectScheduler,
    shouldShutdownOnClose: (code) => code === 4000 || code === 4001,
    onShutdown: () => calls.push(["shutdown"]),
    onStatus: (s) => calls.push(["status", s]),
    markActivity: () => calls.push(["activity"]),
    startWatchdog: () => calls.push(["startWatchdog"]),
    clearWatchdog: () => calls.push(["clearWatchdog"]),
    onOpen: () => calls.push(["onOpen"]),
    onTeardown: () => calls.push(["onTeardown"]),
    handleIncomingWireMessage: (msg, ctx) => { calls.push(["wire", msg, ctx]); return true; },
    onApplicationMessage: (m) => calls.push(["app", m]),
  };
  const opts = { ...defaults, ...overrides };
  const loop = createRelaySocketLoop(opts);
  return { loop, calls, ws, reconnectScheduler };
}

test("connect() no-ops when isShuttingDown returns true", () => {
  const { loop, ws, calls } = buildLoop({ isShuttingDown: () => true });
  loop.connect();
  assert.equal(ws.constructed.length, 0);
  assert.deepEqual(calls, []);
});

test("connect() constructs a WebSocket, emits status=connecting, and tracks the socket", () => {
  const { loop, ws, calls } = buildLoop();
  loop.connect();
  assert.equal(ws.constructed.length, 1);
  assert.equal(ws.constructed[0].url, "wss://relay.example/sess");
  assert.deepEqual(ws.constructed[0].opts.headers, { "x-role": "mac" });
  assert.equal(loop.getSocket(), ws.constructed[0]);
  assert.ok(calls.some((c) => c[0] === "status" && c[1] === "connecting"));
});

test("on open: marks activity, clears reconnect, resets attempt, starts watchdog, fires onOpen", () => {
  const { loop, ws, calls, reconnectScheduler } = buildLoop();
  loop.connect();
  reconnectScheduler.schedule(() => {}); // simulate a pending retry
  assert.equal(reconnectScheduler.isPending(), true);

  ws.constructed[0].emit("open");

  assert.ok(calls.some((c) => c[0] === "activity"));
  assert.ok(calls.some((c) => c[0] === "startWatchdog"));
  assert.ok(calls.some((c) => c[0] === "status" && c[1] === "connected"));
  assert.ok(calls.some((c) => c[0] === "onOpen"));
  assert.equal(reconnectScheduler.isPending(), false, "open must clear any pending reconnect");
});

test("on message: passes plaintext through handleIncomingWireMessage with the onApplicationMessage callback", () => {
  const seenApp = [];
  const { loop, ws } = buildLoop({
    handleIncomingWireMessage: (msg, ctx) => {
      // Simulate secure-transport invoking the app-message callback.
      ctx.onApplicationMessage({ method: "x", original: msg });
      return true;
    },
    onApplicationMessage: (m) => seenApp.push(m),
  });
  loop.connect();
  ws.constructed[0].emit("message", "ciphertext-line");
  assert.deepEqual(seenApp, [{ method: "x", original: "ciphertext-line" }]);
});

test("on message: coerces Buffer data to utf8 string", () => {
  let seen = null;
  const { loop, ws } = buildLoop({
    handleIncomingWireMessage: (msg) => { seen = msg; return true; },
  });
  loop.connect();
  ws.constructed[0].emit("message", Buffer.from("hello-bytes", "utf8"));
  assert.equal(seen, "hello-bytes");
});

test("on close: terminal close code triggers onShutdown, not a reconnect", () => {
  const { loop, ws, calls, reconnectScheduler } = buildLoop();
  loop.connect();
  ws.constructed[0].emit("close", 4000);
  assert.ok(calls.some((c) => c[0] === "shutdown"));
  assert.deepEqual(reconnectScheduler._scheduled(), [], "terminal close must not schedule reconnect");
});

test("on close: non-terminal close schedules a reconnect", () => {
  const { loop, ws, calls, reconnectScheduler } = buildLoop();
  loop.connect();
  ws.constructed[0].emit("close", 1006); // transient drop
  assert.equal(reconnectScheduler._scheduled().length, 1);
  assert.ok(!calls.some((c) => c[0] === "shutdown"));
  // onTeardown runs regardless so the bridge stops dependent watchers.
  assert.ok(calls.some((c) => c[0] === "onTeardown"));
});

test("on close: stale socket (already replaced) does not double-clear watchdog or null active socket", () => {
  const { loop, ws, calls } = buildLoop();
  loop.connect();
  const first = ws.constructed[0];
  // Force a second connect, replacing the tracked socket.
  loop.connect();
  const second = ws.constructed[1];
  assert.equal(loop.getSocket(), second);

  // Now the late close from the *first* socket fires. clearWatchdog must
  // not fire (would tear down the live socket's watchdog), and getSocket()
  // must still return the second one.
  calls.length = 0;
  first.emit("close", 1006);
  assert.ok(!calls.some((c) => c[0] === "clearWatchdog"),
    "late close from stale socket must not clear the live socket's watchdog");
  assert.equal(loop.getSocket(), second);
});

test("on error: clears watchdog only when the erroring socket is still the tracked one", () => {
  const { loop, ws, calls } = buildLoop();
  loop.connect();
  const first = ws.constructed[0];
  loop.connect();
  const second = ws.constructed[1];

  calls.length = 0;
  first.emit("error", new Error("stale"));
  assert.ok(!calls.some((c) => c[0] === "clearWatchdog"));

  calls.length = 0;
  second.emit("error", new Error("live"));
  assert.ok(calls.some((c) => c[0] === "clearWatchdog"));
});

test("scheduleReconnect respects isPending — no double-scheduling", () => {
  const { loop, reconnectScheduler } = buildLoop();
  reconnectScheduler.schedule(() => {}); // pre-existing pending
  loop.scheduleReconnect(1006);
  // Still just the one we pre-scheduled, not two.
  assert.equal(reconnectScheduler._scheduled().length, 1);
});

test("ping / pong both mark activity (heartbeat liveness)", () => {
  const { loop, ws, calls } = buildLoop();
  loop.connect();
  calls.length = 0;
  ws.constructed[0].emit("ping");
  ws.constructed[0].emit("pong");
  const activityCount = calls.filter((c) => c[0] === "activity").length;
  assert.equal(activityCount, 2);
});
