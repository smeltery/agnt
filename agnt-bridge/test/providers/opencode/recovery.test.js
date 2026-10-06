const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createOpencodeEventStream } = require("../../../src/providers/opencode/event-stream");
const { setupTranslator, parseInjected } = require("./translate-test-helpers");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("SSE reconnects once, preserves split UTF-8 frames and stops without closing a turn", () => {
  const connections = [], timers = [], messages = [];
  const stream = createOpencodeEventStream({ host: "127.0.0.1", port: 1,
    httpImpl: { get(options, callback) { const req = new EventEmitter(); req.destroy = () => {}; connections.push({ options, callback, req }); return req; } },
    onMessage: (message) => messages.push(message), setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer() {},
  });
  const response = new EventEmitter(); response.statusCode = 200;
  connections[0].callback(response);
  const frame = Buffer.from('data: {"text":"héllo"}\r\n\r\n');
  const split = frame.indexOf(Buffer.from("é")) + 1;
  response.emit("data", frame.subarray(0, split)); response.emit("data", frame.subarray(split));
  assert.equal(JSON.parse(messages[1]).text, "héllo");
  response.emit("end"); response.emit("close");
  assert.equal(timers.length, 1);
  timers[0](); assert.equal(connections.length, 2);
  assert.equal(connections[1].options.path, "/global/event");
  stream.stop(); connections[1].req.emit("error", new Error("closed"));
  assert.equal(timers.length, 1);
});

test("reconnect repairs missed completion without replaying a previous answer", async () => {
  const { translator, injected } = setupTranslator({ httpHandler(method, route) {
    if (route.startsWith("/session/status")) return { status: 200, json: {} };
    if (route.includes("/message")) return { status: 200, json: [
      { info: { id: "old-user", role: "user" }, parts: [] },
      { info: { id: "old-answer", role: "assistant" }, parts: [{ id: "old", type: "text", text: "old answer" }] },
    ] };
    return { status: 200, json: { id: "ses_a", directory: "/project" } };
  } });
  translator.outbound(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "ses_a", input: [{ type: "text", text: "new request" }] } }));
  await tick(); injected.length = 0;
  translator.inbound(JSON.stringify({ type: "server.connected" })); await tick();
  const events = parseInjected(injected);
  assert.equal(events.filter((e) => e.method === "turn/completed").length, 1);
  assert.equal(events.some((e) => e.method === "item/agentMessage/delta"), false);
});

test("slow reconnect snapshots cannot end a turn after newer live activity", async () => {
  let resolveStatus;
  const { translator, injected } = setupTranslator({ httpHandler(method, route) {
    if (route.startsWith("/session/status")) return new Promise((resolve) => { resolveStatus = resolve; });
    return { status: 200, json: route.includes("/message") ? [] : { id: "ses_a", directory: "/project" } };
  } });
  translator.outbound(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "ses_a", input: [{ type: "text", text: "request" }] } }));
  await tick();
  translator.inbound(JSON.stringify({ type: "server.connected" })); await tick();
  translator.inbound(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }));
  resolveStatus({ status: 200, json: {} }); await tick();
  assert.equal(parseInjected(injected).some((e) => e.method === "turn/completed"), false);
});
