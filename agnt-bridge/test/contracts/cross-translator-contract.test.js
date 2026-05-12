// FILE: contracts/cross-translator-contract.test.js
// Purpose: Parameterized contract suite. The three non-Codex translator shims
//          (claude, opencode, cursor) all present the same JSON-RPC envelope
//          to the iOS / Android / web clients. Their internal upstreams
//          (stream-json, REST/SSE, stream-json) look nothing alike, but the
//          wire contract surfaced to the bridge must be identical.
//
//          This suite drives the *same* RPC script against each translator
//          and asserts the *same* shape of response and notifications. When
//          a future provider lands, adding it to PROVIDERS below covers the
//          contract automatically.
//
// What's covered here (vs. per-provider files):
//   - thread/start response envelope: result.thread.{id, cwd?} + emit
//     "thread/started" with params.threadId
//   - turn/start ack with result.turnId + emit "turn/started"
//   - overlapping turn/start → JSON-RPC error -32003 on the second request
//   - turn/interrupt → ack {ok:true} and emit "turn/failed" + "turn/completed"
//
// What's NOT covered here (kept in per-provider files because they hinge on
// upstream-format quirks):
//   - claude stream-json frames, cursor stream-json frames, opencode SSE
//     event tree, approval flow, tool-call mapping, content_block parsing.
//
// Layer: Cross-translator contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createClaudeTranslator } = require("../../src/providers/claude/translate");
const { createCursorTranslator } = require("../../src/providers/cursor/translate");
const { createOpencodeTranslator } = require("../../src/providers/opencode/translate");

function buildSpawnTransport() {
  const injected = [];
  const transport = {
    send() {},
    describe: () => "fake",
    setResumeSessionId() {},
    setCwd() {},
    setTurnArgs() {},
    interruptTurn() {},
  };
  return { transport, injected };
}

function buildHttpTransport({ session = { id: "ses_test", directory: "/tmp/work" } } = {}) {
  const injected = [];
  const transport = {
    describe: () => "fake-opencode",
    send() {},
    httpRequest(method, pathName) {
      if (method === "POST" && pathName === "/session") {
        return Promise.resolve({ status: 200, json: session });
      }
      // Default: best-effort 200 with empty body so POST /message + POST
      // /abort don't reject and trip the .catch finalizer.
      return Promise.resolve({ status: 200, json: null, raw: "" });
    },
  };
  return { transport, injected };
}

// Provider adapter: hides the spawn-vs-REST difference so the invariant
// body can stay agnostic. Each adapter exposes a `startThread()` that
// returns when the thread is observably started (synchronous for
// spawn-based providers, awaited for opencode's POST /session).
const PROVIDERS = [
  {
    name: "claude",
    create() {
      const { transport, injected } = buildSpawnTransport();
      const translator = createClaudeTranslator({
        injectInbound: (line) => injected.push(line),
        transport,
        env: process.env,
      });
      return { translator, injected };
    },
    async startThread({ translator }, { id = "ts-1", cwd = "/tmp/work" } = {}) {
      translator.outbound(JSON.stringify({ id, method: "thread/start", params: { cwd } }));
    },
  },
  {
    name: "cursor",
    create() {
      const { transport, injected } = buildSpawnTransport();
      const translator = createCursorTranslator({
        injectInbound: (line) => injected.push(line),
        transport,
        env: { ...process.env },
      });
      return { translator, injected };
    },
    async startThread({ translator }, { id = "ts-1", cwd = "/tmp/work" } = {}) {
      translator.outbound(JSON.stringify({ id, method: "thread/start", params: { cwd } }));
    },
  },
  {
    name: "opencode",
    create() {
      const { transport, injected } = buildHttpTransport();
      const translator = createOpencodeTranslator({
        injectInbound: (line) => injected.push(line),
        transport,
        env: process.env,
      });
      return { translator, injected };
    },
    async startThread({ translator }, { id = "ts-1" } = {}) {
      translator.outbound(JSON.stringify({ id, method: "thread/start", params: {} }));
      // Let the POST /session promise resolve so the response is injected.
      await new Promise((resolve) => setImmediate(resolve));
    },
  },
];

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

for (const provider of PROVIDERS) {
  test(`[${provider.name}] thread/start returns a thread envelope + emits thread/started`, async () => {
    const ctx = provider.create();
    await provider.startThread(ctx, { id: "req-1", cwd: "/tmp/work" });

    const events = parseInjected(ctx.injected);
    const ack = events.find((e) => e.id === "req-1");
    const started = events.find((e) => e.method === "thread/started");
    assert.ok(ack, `${provider.name}: missing ack for req-1`);
    assert.ok(ack.result?.thread?.id, `${provider.name}: ack.result.thread.id missing`);
    assert.equal(typeof ack.result.thread.id, "string");
    assert.ok(started, `${provider.name}: missing thread/started notification`);
    assert.equal(started.params.threadId, ack.result.thread.id);
  });

  test(`[${provider.name}] turn/start acks with a turnId and emits turn/started`, async () => {
    const ctx = provider.create();
    await provider.startThread(ctx);
    ctx.injected.length = 0;

    ctx.translator.outbound(JSON.stringify({
      id: "tu-1",
      method: "turn/start",
      params: { threadId: "thr_x", input: [{ type: "text", text: "hi" }] },
    }));

    const events = parseInjected(ctx.injected);
    const ack = events.find((e) => e.id === "tu-1");
    const started = events.find((e) => e.method === "turn/started");
    assert.ok(ack, `${provider.name}: turn/start ack missing`);
    assert.match(ack.result.turnId, /^turn_/, `${provider.name}: turnId should be turn_*`);
    assert.ok(started, `${provider.name}: turn/started notification missing`);
    assert.equal(started.params.turnId, ack.result.turnId);
    assert.equal(started.params.id, ack.result.turnId);
    assert.equal(started.params.turn_id, ack.result.turnId);
  });

  test(`[${provider.name}] overlapping turn/start is rejected with JSON-RPC error -32003`, async () => {
    const ctx = provider.create();
    await provider.startThread(ctx);
    ctx.translator.outbound(JSON.stringify({
      id: "tu-1",
      method: "turn/start",
      params: { threadId: "thr_x", input: [{ type: "text", text: "first" }] },
    }));
    ctx.injected.length = 0;

    ctx.translator.outbound(JSON.stringify({
      id: "tu-2",
      method: "turn/start",
      params: { threadId: "thr_x", input: [{ type: "text", text: "second" }] },
    }));

    const events = parseInjected(ctx.injected);
    const errorAck = events.find((e) => e.id === "tu-2");
    assert.ok(errorAck?.error, `${provider.name}: expected error ack for second turn/start`);
    assert.equal(errorAck.error.code, -32003);
  });

  test(`[${provider.name}] turn/interrupt acks {ok:true} and emits turn/failed + turn/completed`, async () => {
    const ctx = provider.create();
    await provider.startThread(ctx);
    ctx.translator.outbound(JSON.stringify({
      id: "tu-1",
      method: "turn/start",
      params: { threadId: "thr_x", input: [{ type: "text", text: "going" }] },
    }));
    ctx.injected.length = 0;

    ctx.translator.outbound(JSON.stringify({
      id: "int-1",
      method: "turn/interrupt",
      params: { threadId: "thr_x" },
    }));

    const events = parseInjected(ctx.injected);
    const ack = events.find((e) => e.id === "int-1");
    const failed = events.find((e) => e.method === "turn/failed");
    const completed = events.find((e) => e.method === "turn/completed");
    assert.ok(ack, `${provider.name}: interrupt ack missing`);
    assert.equal(ack.result?.ok, true);
    assert.ok(failed, `${provider.name}: turn/failed notification missing`);
    assert.ok(completed, `${provider.name}: turn/completed notification missing`);
    // turn_id alias must be present on completed (canonical envelope from
    // createTurnLifecycleEmitter). iOS reads either turnId or turn_id; the
    // shared helper guarantees both ship.
    assert.ok(completed.params.turnId);
    assert.equal(completed.params.turn_id, completed.params.turnId);
  });
}
