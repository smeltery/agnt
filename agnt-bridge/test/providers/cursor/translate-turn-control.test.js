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
  assert.deepEqual(transportCalls[0], ["interrupt"]);
});

test("turn/start with model param translates to --model X via setTurnArgs", () => {
  const { translator, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  transportCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-args",
    method: "turn/start",
    params: {
      threadId: "thr_args",
      input: [{ type: "text", text: "x" }],
      model: "gpt-5",
    },
  }));

  const call = transportCalls.find((c) => c[0] === "turnArgs");
  assert.ok(call, "expected setTurnArgs to be called");
  assert.deepEqual(call[1], ["--model", "gpt-5"]);
});

test("turn/steer is rejected with -32601 (cursor has no mid-turn steering)", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "steer-1",
    method: "turn/steer",
    params: { threadId: "thr_x" },
  }));

  const events = parseInjected(injected);
  const errorAck = events.find((e) => e.id === "steer-1");
  assert.equal(errorAck.error.code, -32601);
  assert.match(errorAck.error.message, /turn\/steer/);
});

test("thread/compact acknowledges as not supported without hanging the iOS pill", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "compact-1",
    method: "thread/compact",
    params: { threadId: "thr_x" },
  }));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "compact-1");
  assert.equal(ack.result.compacted, false);
  assert.equal(ack.result.reason, "cursor_cli_compact_unsupported");
});
