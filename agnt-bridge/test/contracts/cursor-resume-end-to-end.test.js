// FILE: contracts/cursor-resume-end-to-end.test.js
// Purpose: Pins the end-to-end Cursor resume plumbing — the wiring between
//          the translator (which extracts `session_id` from inbound cursor
//          frames and republishes it to the transport) and the transport
//          (which appends `--resume <session_id>` to the next spawn argv).
//
// The pieces are tested independently elsewhere:
//   - cursor-translate.test.js: inbound session_id → setResumeSessionId
//   - contracts/cursor-spawn-per-turn.test.js: direct setResumeSessionId
//     call → --resume flag in argv
//
// What's untested today is the *integrated* path. If someone refactors the
// translator's transport reference (e.g. renames setResumeSessionId, drops
// the call, or wraps transport with a proxy that swallows the publish),
// the per-layer tests still pass but resume silently breaks in production.
// This suite drives the real translator + real transport (with a fake spawn)
// end-to-end so the wiring is regression-tested as one contract.
//
// Layer: Contract test (integration)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createCursorTransport } = require("../../src/providers/cursor/transport");
const { createCursorTranslator } = require("../../src/providers/cursor/translate");

function makeFakeChild() {
  const child = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal); return true; };
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeRig() {
  const spawnCalls = [];
  const children = [];
  const injected = [];

  const transport = createCursorTransport({
    binPath: "/fake/cursor-agent",
    spawnImpl: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      children.push(child);
      return child;
    },
    env: { PATH: "/usr/bin" },
  });

  const translator = createCursorTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: { PATH: "/usr/bin" },
  });

  // Mirror the bridge's outbound wiring: translator.outbound returns the
  // frames the bridge should hand to transport.send. The real wiring lives
  // in providers/types.js `withTranslator` — kept faithful here so the
  // integration path matches production.
  function sendThroughTranslator(jsonRpcLine) {
    const translated = translator.outbound(jsonRpcLine);
    if (translated == null) return;
    const frames = Array.isArray(translated) ? translated : [translated];
    for (const frame of frames) {
      if (typeof frame === "string" && frame.length > 0) {
        transport.send(frame);
      }
    }
  }

  return { transport, translator, spawnCalls, children, injected, sendThroughTranslator };
}

test("inbound cursor system.init session_id flows through to the next spawn's --resume argv", () => {
  const { translator, spawnCalls, sendThroughTranslator } = makeRig();

  sendThroughTranslator(JSON.stringify({ id: "ts", method: "thread/start", params: { cwd: "/tmp/work" } }));

  // First turn — no session_id yet, no --resume flag should appear.
  sendThroughTranslator(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "hello" }] },
  }));
  assert.equal(spawnCalls.length, 1, "first turn must spawn");
  assert.equal(spawnCalls[0].args.includes("--resume"), false,
    "first turn before any session_id must not have --resume");

  // Cursor CLI emits a system.init frame with the session id. The translator
  // is supposed to extract this and republish it to the transport so the
  // NEXT spawn carries --resume. (The translator may also republish it on
  // every frame that carries a session_id — both are fine; we just need the
  // wiring to land before turn 2.)
  translator.inbound(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-abc-123",
    cwd: "/tmp/work",
  }));

  // Finalize the first turn so the second isn't rejected as overlapping
  // (-32003). A `result` frame from cursor closes the active turn.
  translator.inbound(JSON.stringify({
    type: "result",
    session_id: "sess-abc-123",
    result: "ok",
  }));

  // Second turn — must include --resume sess-abc-123 right before the prompt.
  sendThroughTranslator(JSON.stringify({
    id: "tu-2",
    method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "again" }] },
  }));
  assert.equal(spawnCalls.length, 2, "second turn must spawn");
  const args2 = spawnCalls[1].args;
  const idx = args2.indexOf("--resume");
  assert.ok(idx !== -1,
    `expected --resume in second spawn argv. Got: ${args2.join(" ")}`);
  assert.equal(args2[idx + 1], "sess-abc-123");
  assert.equal(args2[args2.length - 1], "again", "prompt is still the final positional arg");
});

test("session_id republished on any cursor frame propagates to the next spawn", () => {
  // Cursor's translator republishes session_id on assistant frames too, not
  // just system.init (per CLAUDE.md: "cursor streams it on every frame"). Pin
  // that path so a future refactor doesn't silently narrow it to init only.
  const { translator, spawnCalls, sendThroughTranslator } = makeRig();

  sendThroughTranslator(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  sendThroughTranslator(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "first" }] },
  }));

  // Mid-stream assistant frame carrying a session_id.
  translator.inbound(JSON.stringify({
    type: "assistant",
    session_id: "sess-from-assistant",
    message: { content: [{ type: "text", text: "ok" }] },
  }));

  // Cursor finalizes the turn so the next turn/start is accepted (the shim
  // rejects overlap with -32003 while one is in flight).
  translator.inbound(JSON.stringify({
    type: "result",
    session_id: "sess-from-assistant",
    result: "done",
  }));

  sendThroughTranslator(JSON.stringify({
    id: "tu-2",
    method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "second" }] },
  }));
  const args2 = spawnCalls[1].args;
  const idx = args2.indexOf("--resume");
  assert.ok(idx !== -1, "--resume must appear on the second spawn");
  assert.equal(args2[idx + 1], "sess-from-assistant");
});

test("a fresh translator with no inbound session_id never adds --resume", () => {
  // Regression backstop: if setResumeSessionId is ever defaulted/initialized
  // to a non-empty string, the spawn will silently --resume a bogus id.
  const { translator, spawnCalls, sendThroughTranslator } = makeRig();
  sendThroughTranslator(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  sendThroughTranslator(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "fresh" }] },
  }));
  assert.equal(spawnCalls[0].args.includes("--resume"), false);
});
