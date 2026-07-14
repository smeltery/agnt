const test = require("node:test");
const assert = require("node:assert/strict");

const { parseInjected, setupTranslator } = require("./translate-test-helpers");

test("turn/interrupt calls transport.interruptTurn() AND emits synthetic events", () => {
  const { translator, injected, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_int", input: [{ type: "text", text: "go" }] },
  }));
  injected.length = 0;
  transportCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "int-1",
    method: "turn/interrupt",
    params: { threadId: "thr_int" },
  }));

  const events = injected.map((line) => JSON.parse(line));
  const ack = events.find((e) => e.id === "int-1");
  const failed = events.find((e) => e.method === "turn/failed");
  const completed = events.find((e) => e.method === "turn/completed");
  assert.ok(ack);
  assert.equal(failed.params.error.message, "interrupted by user");
  assert.ok(completed);
  // Critical: the transport must actually be told to kill the active child.
  assert.deepEqual(transportCalls[0], ["interrupt"]);
});

test("turn/start params translate to per-turn CLI args (model + effort + plan)", () => {
  const { translator, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  transportCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-args", method: "turn/start",
    params: {
      threadId: "thr_args",
      input: [{ type: "text", text: "x" }],
      model: "sonnet",
      effort: "high",
      collaborationMode: { mode: "plan" },
    },
  }));

  const call = transportCalls.find((c) => c[0] === "turnArgs");
  assert.ok(call, "expected setTurnArgs to be called");
  const args = call[1];
  assert.deepEqual(args, ["--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
});

test("Codex effort `minimal` maps to Claude `low` (the smallest valid level)", () => {
  const { translator, transportCalls } = setupTranslator();
  transportCalls.length = 0;
  translator.outbound(JSON.stringify({
    id: "tu-eff", method: "turn/start",
    params: {
      threadId: "thr_eff",
      input: [{ type: "text", text: "x" }],
      effort: "minimal",
    },
  }));
  const call = transportCalls.find((c) => c[0] === "turnArgs");
  // Effort flag plus the auto-applied default permission-mode for --print mode.
  assert.deepEqual(call[1], ["--effort", "low", "--permission-mode", "acceptEdits"]);
});

test("turn/start without explicit permissionMode defaults to --permission-mode acceptEdits", () => {
  const { translator, transportCalls } = setupTranslator();
  transportCalls.length = 0;
  translator.outbound(JSON.stringify({
    id: "tu-pm", method: "turn/start",
    params: { threadId: "thr_pm", input: [{ type: "text", text: "x" }] },
  }));
  const call = transportCalls.find((c) => c[0] === "turnArgs");
  assert.deepEqual(call[1], ["--permission-mode", "acceptEdits"]);
});

test("second turn/start while one is active is rejected", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu-1", method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "first" }] },
  }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-2", method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "second" }] },
  }));
  const events = parseInjected(injected);
  assert.equal(events[0].id, "tu-2");
  assert.equal(events[0].error.code, -32003);
  assert.match(events[0].error.message, /already in flight/);
});

test("thread/compact acks with compacted:false (Claude CLI does not honor /compact in stream-json)", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "compact-1", method: "thread/compact", params: { threadId: "thr_c" },
  }));
  const events = parseInjected(injected);
  assert.equal(events[0].id, "compact-1");
  assert.equal(events[0].result.compacted, false);
  assert.equal(events[0].result.reason, "claude_cli_compact_unsupported");
});

test("unsupported methods get a JSON-RPC error response", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "steer-1",
    method: "turn/steer",
    params: { threadId: "thr_x" },
  }));
  const events = injected.map((line) => JSON.parse(line));
  assert.equal(events[0].id, "steer-1");
  assert.equal(events[0].error.code, -32601);
});
